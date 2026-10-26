using System.Collections.Concurrent;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Today's live option and futures data as the OI Replay live feed sees it (OiReplayLiveFeedService records every
/// tick here), kept in memory only - every index the feed tracks, all day, whether or not a page is open:
///  - each option leg's newest reading (GET /api/oi-replay/{underlying}/live-legs);
///  - each leg's 1-minute bars (open / high / low / close, OI, volume from the day's cumulative volume), and the
///    near futures' bars - so today's OI Replay run is served from here after ONE backfill from Dhan per series per
///    day (OiReplayService), and switching index on the live page asks Dhan for nothing.
/// A new IST day starts empty. The completed minutes are also kept on disk (TodayDiskStore's live-bars.csv, written by
/// TodayDataPersistenceService) and read back after a restart (Restore), so the day carries on from them.
/// </summary>
public sealed class LiveOptionLegStore
{
    private sealed class Bar
    {
        public DateTimeOffset Time;
        public decimal Open, High, Low, Close;
        public long OpenInterest, Volume;
    }

    private sealed class Series
    {
        public readonly SortedDictionary<long, Bar> Bars = new();
        public long LastDayVolume = -1;
    }

    private readonly ConcurrentDictionary<(string Underlying, string ExpiryFlag, string Side, decimal Strike), LiveOptionTick> _latest = new();
    private readonly Dictionary<(string Underlying, string ExpiryFlag, string Side, decimal Strike), Series> _options = new();
    private readonly Dictionary<string, Series> _futures = new(StringComparer.OrdinalIgnoreCase);
    private readonly object _lock = new();
    private DateOnly _day;
    // Today's minutes read back from disk after a restart (Restore), and the first minute this process recorded itself -
    // what CarriesOnFrom judges a saved backfill by.
    private long? _restoredFrom, _restoredThrough, _liveFrom;

    public void Record(LiveOptionTick tick) => Record(tick, -1, keepBars: true);

    /// <summary>A leg's tick - `dayVolume` Dhan's cumulative volume for the day (-1 unknown); `keepBars` false keeps
    /// only its newest reading (the positional N-expiries - today's run asks for WEEK / MONTH).</summary>
    public void Record(LiveOptionTick tick, long dayVolume, bool keepBars)
    {
        _latest[(tick.Underlying, tick.ExpiryFlag, tick.Side, tick.Strike)] = tick;
        if (!(tick.Price > 0) || !keepBars) return;
        lock (_lock)
        {
            if (!SameDay(tick.Time)) return;
            var key = (tick.Underlying.ToUpperInvariant(), tick.ExpiryFlag.ToUpperInvariant(), tick.Side, tick.Strike);
            if (!_options.TryGetValue(key, out var series)) _options[key] = series = new Series();
            Fold(series, tick.Time, tick.Price, tick.OpenInterest, dayVolume);
            _liveFrom ??= MinuteOf(tick.Time);
        }
    }

    /// <summary>A near-futures tick of `underlying`.</summary>
    public void RecordFutures(string underlying, decimal price, long openInterest, long dayVolume, DateTimeOffset time)
    {
        if (!(price > 0)) return;
        lock (_lock)
        {
            if (!SameDay(time)) return;
            if (!_futures.TryGetValue(underlying, out var series)) _futures[underlying] = series = new Series();
            Fold(series, time, price, openInterest, dayVolume);
            _liveFrom ??= MinuteOf(time);
        }
    }

    /// <summary>The newest reading of each leg of one chain (index + expiry flag) observed on `day` (IST),
    /// by strike then side - an earlier day's readings are not current prices.</summary>
    public IReadOnlyList<LiveOptionTick> Latest(string underlying, string expiryFlag, DateOnly day) =>
        _latest.Values
            .Where(t => string.Equals(t.Underlying, underlying, StringComparison.OrdinalIgnoreCase)
                        && string.Equals(t.ExpiryFlag, expiryFlag, StringComparison.OrdinalIgnoreCase)
                        && DayOf(t.Time) == day)
            .OrderBy(t => t.Strike).ThenBy(t => t.Side, StringComparer.Ordinal)
            .ToList();

    /// <summary>Today's 1-minute bars of every leg of one chain's `side` ("CE" / "PE") from the minute of `from`
    /// on, as OI Replay points (no IV - the feed's tick has none). Empty on another day.</summary>
    public IReadOnlyList<OiReplayPoint> OptionPointsFrom(string underlying, string expiryFlag, string side, DateTimeOffset from)
    {
        var fromMinute = MinuteOf(from);
        var points = new List<OiReplayPoint>();
        lock (_lock)
        {
            if (DayOf(from) != _day) return points;
            foreach (var (key, series) in _options)
            {
                if (key.Underlying != underlying.ToUpperInvariant() || key.ExpiryFlag != expiryFlag.ToUpperInvariant() || key.Side != side) continue;
                foreach (var (minute, b) in series.Bars)
                    if (minute >= fromMinute) points.Add(new OiReplayPoint(b.Time, key.Strike, b.OpenInterest, null, b.Close, b.Open, b.High, b.Low, b.Volume));
            }
        }
        return points.OrderBy(p => p.Time).ThenBy(p => p.Strike).ToList();
    }

    /// <summary>Today's 1-minute near-futures bars of `underlying` from the minute of `from` on.</summary>
    public IReadOnlyList<FuturesBar> FuturesBarsFrom(string underlying, DateTimeOffset from)
    {
        var fromMinute = MinuteOf(from);
        lock (_lock)
        {
            if (DayOf(from) != _day || !_futures.TryGetValue(underlying, out var series)) return Array.Empty<FuturesBar>();
            return series.Bars.Where(kv => kv.Key >= fromMinute)
                .Select(kv => new FuturesBar(kv.Value.Time, kv.Value.Open, kv.Value.High, kv.Value.Low, kv.Value.Close, kv.Value.Volume, kv.Value.OpenInterest))
                .ToList();
        }
    }

    /// <summary>`day`'s completed minutes after minute `afterMinute` up to and including `throughMinute` (unix minutes) of
    /// every option leg and the futures, as rows for TodayDiskStore's live-bars.csv. Empty for another day.</summary>
    public IReadOnlyList<TodayDiskStore.LiveBarRow> CompletedBars(DateOnly day, long afterMinute, long throughMinute)
    {
        var rows = new List<TodayDiskStore.LiveBarRow>();
        lock (_lock)
        {
            if (day != _day) return rows;
            foreach (var (key, series) in _options)
                foreach (var (minute, b) in series.Bars)
                    if (minute > afterMinute && minute <= throughMinute)
                        rows.Add(new TodayDiskStore.LiveBarRow("opt", key.Underlying, key.ExpiryFlag, key.Side, key.Strike, b.Time, b.Open, b.High, b.Low, b.Close, b.OpenInterest, b.Volume));
            foreach (var (underlying, series) in _futures)
                foreach (var (minute, b) in series.Bars)
                    if (minute > afterMinute && minute <= throughMinute)
                        rows.Add(new TodayDiskStore.LiveBarRow("fut", underlying.ToUpperInvariant(), "", "", 0, b.Time, b.Open, b.High, b.Low, b.Close, b.OpenInterest, b.Volume));
        }
        return rows;
    }

    /// <summary>Reads `day`'s saved minutes back after a restart (TodayDiskStore.ReadLiveBars) - a minute this process has
    /// already recorded itself is kept as it is. Another day's rows are ignored.</summary>
    public void Restore(DateOnly day, IEnumerable<TodayDiskStore.LiveBarRow> rows)
    {
        lock (_lock)
        {
            if (!SameDay(day)) return;
            foreach (var r in rows)
            {
                if (DayOf(r.Minute) != day) continue;
                Series series;
                if (r.Kind == "fut")
                {
                    if (!_futures.TryGetValue(r.Underlying, out series!)) _futures[r.Underlying] = series = new Series();
                }
                else
                {
                    var key = (r.Underlying.ToUpperInvariant(), r.ExpiryFlag.ToUpperInvariant(), r.Side, r.Strike);
                    if (!_options.TryGetValue(key, out series!)) _options[key] = series = new Series();
                }
                var minute = MinuteOf(r.Minute);
                if (series.Bars.ContainsKey(minute)) continue;
                series.Bars[minute] = new Bar
                {
                    Time = DateTimeOffset.FromUnixTimeSeconds(minute * 60).ToOffset(IstClock.Offset),
                    Open = r.Open, High = r.High, Low = r.Low, Close = r.Close, OpenInterest = r.OpenInterest, Volume = r.Volume,
                };
                _restoredFrom = _restoredFrom is { } f ? Math.Min(f, minute) : minute;
                _restoredThrough = _restoredThrough is { } t ? Math.Max(t, minute) : minute;
            }
        }
    }

    /// <summary>Whether the minutes held carry on from `from` (a backfill saved before a restart) up to `now` with no hole
    /// longer than `maxGap`: the minutes read back from disk reach back to `from`, and from their last one to where this
    /// process's own minutes start (or `now`, before any - but never past the day's last minute, 15:29) is at most
    /// `maxGap`. Only then does that backfill plus these minutes make the whole day - else the backfill is asked again.</summary>
    public bool CarriesOnFrom(DateTimeOffset from, DateTimeOffset now, TimeSpan maxGap)
    {
        lock (_lock)
        {
            if (DayOf(from) != _day || _restoredFrom is not { } restoredFrom || _restoredThrough is not { } restoredThrough) return false;
            if (restoredFrom > MinuteOf(from) + 1) return false;
            var lastMinute = MinuteOf(new DateTimeOffset(_day.ToDateTime(new TimeOnly(15, 29)), IstClock.Offset));
            var resumes = Math.Min(_liveFrom ?? MinuteOf(now), lastMinute);
            return resumes - restoredThrough <= (long)maxGap.TotalMinutes;
        }
    }

    private static DateOnly DayOf(DateTimeOffset t) => DateOnly.FromDateTime(t.ToOffset(IstClock.Offset).DateTime);
    private static long MinuteOf(DateTimeOffset t) => t.ToUnixTimeSeconds() / 60;

    // A tick of a new day clears yesterday's bars - and the newest readings of earlier days (a leg the feed no longer
    // tracks, a strike the index has moved away from, would otherwise stay held for the life of the server); one of an
    // older day than the bars held is dropped.
    private bool SameDay(DateTimeOffset time) => SameDay(DayOf(time));

    private bool SameDay(DateOnly day)
    {
        if (day > _day)
        {
            _day = day;
            _options.Clear();
            _futures.Clear();
            _restoredFrom = _restoredThrough = _liveFrom = null;
            foreach (var (key, tick) in _latest)
                if (DayOf(tick.Time) < day) _latest.TryRemove(KeyValuePair.Create(key, tick));
        }
        return day == _day;
    }

    /// <summary>For the tests: how many legs' newest readings are held.</summary>
    internal int LatestCount => _latest.Count;

    private static void Fold(Series series, DateTimeOffset time, decimal price, long openInterest, long dayVolume)
    {
        var minute = MinuteOf(time);
        var traded = dayVolume >= 0 && series.LastDayVolume >= 0 && dayVolume >= series.LastDayVolume ? dayVolume - series.LastDayVolume : 0;
        if (dayVolume >= 0) series.LastDayVolume = dayVolume;
        // Stamped at the minute's start (the REST history's convention), holding its latest reading.
        if (series.Bars.TryGetValue(minute, out var bar))
        {
            bar.High = Math.Max(bar.High, price);
            bar.Low = Math.Min(bar.Low, price);
            bar.Close = price;
            bar.OpenInterest = openInterest;
            bar.Volume += traded;
        }
        else
        {
            series.Bars[minute] = new Bar
            {
                Time = DateTimeOffset.FromUnixTimeSeconds(minute * 60).ToOffset(IstClock.Offset),
                Open = price, High = price, Low = price, Close = price, OpenInterest = openInterest, Volume = traded,
            };
        }
    }
}

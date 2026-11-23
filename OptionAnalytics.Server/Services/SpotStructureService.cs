using System.Collections.Concurrent;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// The Spot structure page's candles: an index's SPOT over many days at one timeframe - Day, 4 hours (NSE's session-anchored
/// 09:15 - 13:15 and 13:15 - 15:30, as TradingView draws it), 1 hour, 15 / 5 / 3 / 1 minutes - all BUILT FROM THE SPOT'S
/// 1-MINUTE CANDLES. The PAST days are the very 1-minute days OI Replay's runs and the backtests keep on disk
/// (DhanHistoricalDataService.GetIndexRangeDiskFirstAsync): read from the disk cache first, Dhan asked only for the weekdays
/// not kept (at most 80 days a call - its intraday limit is 90). They are held in memory per day for the IST day (a past day
/// never changes): 5-minute candles for every day (the Day / 4H / 1H / 15m / 5m candles are made from them) and the 1-minute
/// ones for the last two weeks (3m / 1m) - so every timeframe and the page's refresh read the same held days. TODAY comes from
/// OiReplayService.GetSpotDayAsync: the spot feed's memory (no Dhan call) or the day's one shared fetch. Only session
/// minutes (09:15 - 15:29 IST) are used.
/// </summary>
public sealed class SpotStructureService
{
    /// <summary>The timeframes offered, in minutes (1440 = a day), with how many TRADING days (weekdays) before today they show
    /// by default and at most. Weekdays, not calendar days: "2 days" on a Monday was Saturday and Sunday - no past session at
    /// all, only today's candles.</summary>
    public static readonly IReadOnlyDictionary<int, (int DefaultDays, int MaxDays)> Timeframes = new Dictionary<int, (int, int)>
    {
        [1440] = (280, 780),
        [240] = (85, 260),
        [60] = (40, 130),
        [15] = (15, 42),
        [5] = (5, 15),
        [3] = (3, 10),
        [1] = (2, 5),
    };

    /// <summary>Dhan's intraday candles are asked at most this many calendar days a call (its limit is 90).</summary>
    internal const int ChunkDays = 80;
    /// <summary>A held day keeps its 1-minute candles (for 3m / 1m) when it is at most this many days old - every older one
    /// only its 5-minute candles (Day / 4H / 1H / 15m / 5m are made from them).</summary>
    internal const int MinuteDays = 45;

    private static readonly TimeOnly SessionStart = new(9, 15);
    private static readonly TimeOnly SessionEnd = new(15, 30);

    private readonly Func<string, DateOnly, DateOnly, CancellationToken, Task<DhanHistoricalDataService.IndexRange>> _past;
    private readonly Func<string, DateOnly, CancellationToken, Task<(IReadOnlyList<CandleWithVolume> Bars, string? Error)>> _today;
    private readonly Func<DateTimeOffset> _now;
    // The past days held for the IST day they were read on: (underlying, day) -> its 5-minute and (recent) 1-minute candles.
    private readonly ConcurrentDictionary<(string, DateOnly), HeldDay> _held = new();
    private DateOnly _heldOn;

    private sealed record HeldDay(IReadOnlyList<CandleWithVolume> Five, IReadOnlyList<CandleWithVolume>? One);

    public SpotStructureService(DhanSpotInstrumentMaster instruments, DhanHistoricalDataService history, OiReplayService oiReplay)
        : this(async (underlying, from, to, ct) =>
        {
            await instruments.EnsureLoadedAsync(ct);
            var instrument = instruments.FindSpot(underlying);
            if (instrument is null) return new DhanHistoricalDataService.IndexRange(Array.Empty<CandleWithVolume>(), $"No {underlying} index in Dhan's scrip master.", 0, 0);
            return await history.GetIndexRangeDiskFirstAsync(instrument.SecurityId, instrument.DhanSegment, from, to, ChunkDays, ct);
        },
        async (underlying, date, ct) =>
        {
            var day = await oiReplay.GetSpotDayAsync(underlying, date, ct);
            return (day.Bars, day.Success ? null : day.Error);
        },
        () => DateTimeOffset.UtcNow)
    {
    }

    internal SpotStructureService(
        Func<string, DateOnly, DateOnly, CancellationToken, Task<DhanHistoricalDataService.IndexRange>> past,
        Func<string, DateOnly, CancellationToken, Task<(IReadOnlyList<CandleWithVolume>, string?)>> today,
        Func<DateTimeOffset> now)
    {
        _past = past;
        _today = today;
        _now = now;
    }

    /// <summary>DaysHeld / DaysFromDisk / DaysAskedOfDhan: where this answer's past weekdays came from - already in memory, the
    /// server's disk cache, Dhan (the first time - kept on disk after).</summary>
    public sealed record Result(string Underlying, int Timeframe, int Days, DateOnly From, DateOnly To, IReadOnlyList<CandleWithVolume> Candles, bool TodayIncluded, string? Error,
        int DaysHeld = 0, int DaysFromDisk = 0, int DaysAskedOfDhan = 0);

    public async Task<Result> CandlesAsync(string underlying, int timeframe, int? days, CancellationToken cancellationToken)
    {
        underlying = underlying.ToUpperInvariant();
        if (!Timeframes.TryGetValue(timeframe, out var spec))
            throw new ArgumentException($"Timeframe {timeframe} is not offered - one of {string.Join(", ", Timeframes.Keys)} (minutes; 1440 = a day).");
        var span = Math.Clamp(days ?? spec.DefaultDays, 1, spec.MaxDays);
        var today = IstClock.IstDate(_now());
        var weekdays = PastWeekdays(today, span);
        var from = weekdays[0];
        if (_heldOn != today) { _held.Clear(); _heldOn = today; }
        var minutes = timeframe % 5 != 0;   // 3m / 1m need the 1-minute candles

        var errors = new List<string>();
        bool Held(DateOnly d) => _held.TryGetValue((underlying, d), out var h) && (!minutes || h.One is not null);
        var needed = weekdays.Where(d => !Held(d)).ToList();
        int fromDisk = 0, asked = 0;
        if (needed.Count > 0)
        {
            var got = await _past(underlying, needed[0], needed[^1], cancellationToken);
            fromDisk = got.DaysFromDisk;
            asked = got.DaysAskedOfDhan;
            var byDay = got.Candles.GroupBy(c => IstClock.IstDate(c.Time)).ToDictionary(g => g.Key, g => g.ToList());
            foreach (var d in needed)
            {
                // A day with no candles is held only when nothing failed (a holiday) - else it is asked again next time.
                if (!byDay.TryGetValue(d, out var dayMinutes) && got.Error is not null) continue;
                dayMinutes ??= new List<CandleWithVolume>();
                _held[(underlying, d)] = new HeldDay(Aggregate(dayMinutes, 5), today.DayNumber - d.DayNumber <= MinuteDays ? Aggregate(dayMinutes, 1) : null);
            }
            if (got.Error is not null) errors.Add($"past days: {got.Error}");
        }
        var past = new List<CandleWithVolume>();
        foreach (var d in weekdays)
            if (_held.TryGetValue((underlying, d), out var h)) past.AddRange(minutes ? h.One ?? h.Five : h.Five);

        var todayIncluded = false;
        if (today.DayOfWeek is not (DayOfWeek.Saturday or DayOfWeek.Sunday) && TimeOnly.FromDateTime(_now().ToOffset(IstClock.Offset).DateTime) >= SessionStart)
        {
            var (bars, error) = await _today(underlying, today, cancellationToken);
            if (bars.Count > 0) { past.AddRange(bars); todayIncluded = true; }
            else if (error is not null) errors.Add($"today: {error}");
        }
        return new Result(underlying, timeframe, span, from, today, Aggregate(past, timeframe), todayIncluded, errors.Count > 0 ? string.Join(" · ", errors) : null,
            weekdays.Count - needed.Count, fromDisk, asked);
    }

    /// <summary>The weekday before `today` - the last day a window of past days asks for (a weekend after the last session
    /// would never be kept on disk, so a window ending on it went to Dhan at every load).</summary>
    /// <summary>The `count` weekdays before `today`, oldest first (a holiday among them is a day with no candles).</summary>
    internal static List<DateOnly> PastWeekdays(DateOnly today, int count)
    {
        var days = new List<DateOnly>();
        for (var d = LastWeekdayBefore(today); days.Count < count; d = d.AddDays(-1))
            if (d.DayOfWeek is not (DayOfWeek.Saturday or DayOfWeek.Sunday)) days.Add(d);
        days.Reverse();
        return days;
    }

    internal static DateOnly LastWeekdayBefore(DateOnly today)
    {
        var d = today.AddDays(-1);
        while (d.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) d = d.AddDays(-1);
        return d;
    }

    /// <summary>Candles of any interval (1-minute up to 60) made into `timeframe` candles, bucketed on the SESSION from 09:15
    /// IST (a 4-hour candle is 09:15 - 13:15 and 13:15 - 15:30; an hour 09:15 - 10:15 ...; a day the whole session), each
    /// stamped with its bucket's start; minutes outside 09:15 - 15:29 and duplicates (a minute both read and fed) left out.</summary>
    internal static IReadOnlyList<CandleWithVolume> Aggregate(IEnumerable<CandleWithVolume> candles, int timeframe)
    {
        var buckets = new SortedDictionary<DateTimeOffset, CandleWithVolume>();
        var seen = new HashSet<DateTimeOffset>();
        foreach (var c in candles.OrderBy(c => c.Time))
        {
            if (!seen.Add(c.Time)) continue;
            var ist = c.Time.ToOffset(IstClock.Offset);
            var time = TimeOnly.FromDateTime(ist.DateTime);
            if (time < SessionStart || time >= SessionEnd) continue;
            var date = DateOnly.FromDateTime(ist.DateTime);
            var sinceOpen = (int)(time - SessionStart).TotalMinutes;
            var bucketMinutes = timeframe >= 1440 ? 0 : sinceOpen / timeframe * timeframe;
            var start = new DateTimeOffset(date.ToDateTime(SessionStart), IstClock.Offset).AddMinutes(bucketMinutes);
            buckets[start] = buckets.TryGetValue(start, out var b)
                ? b with { High = Math.Max(b.High, c.High), Low = Math.Min(b.Low, c.Low), Close = c.Close, Volume = b.Volume + c.Volume }
                : c with { Time = start };
        }
        return buckets.Values.ToList();
    }
}

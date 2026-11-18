using System.Collections.Concurrent;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// The Spot structure page's candles: an index's SPOT over many days at one timeframe - Day, 4 hours (NSE's session-anchored
/// 09:15 - 13:15 and 13:15 - 15:30, as TradingView draws it), 1 hour, 15 / 5 / 3 / 1 minutes. The PAST days come from
/// Dhan's intraday candles through DhanHistoricalDataService - so the disk cache (DhanDataCache, a file a day) answers them
/// after the first load, Dhan asked at most 80 days a call (its intraday limit is 90) - and are held in memory for the day
/// (a past day never changes), so the page's refresh asks nothing. TODAY comes from OiReplayService.GetSpotDayAsync: the spot
/// feed's memory (no Dhan call) or the day's one shared fetch. Only session minutes (09:15 - 15:29 IST) are used.
/// </summary>
public sealed class SpotStructureService
{
    /// <summary>The timeframes offered, in minutes (1440 = a day), with the Dhan interval their past days are read at, how
    /// many calendar days back they show by default and at most.</summary>
    public static readonly IReadOnlyDictionary<int, (int Interval, int DefaultDays, int MaxDays)> Timeframes = new Dictionary<int, (int, int, int)>
    {
        [1440] = (60, 400, 1100),
        [240] = (60, 120, 365),
        [60] = (60, 60, 180),
        [15] = (15, 21, 60),
        [5] = (5, 7, 21),
        [3] = (1, 4, 10),
        [1] = (1, 2, 5),
    };

    /// <summary>Dhan's intraday candles are asked at most this many calendar days a call (its limit is 90).</summary>
    internal const int ChunkDays = 80;

    private static readonly TimeOnly SessionStart = new(9, 15);
    private static readonly TimeOnly SessionEnd = new(15, 30);

    private readonly Func<string, DateOnly, DateOnly, int, CancellationToken, Task<(IReadOnlyList<CandleWithVolume> Candles, string? Error)>> _past;
    private readonly Func<string, DateOnly, CancellationToken, Task<(IReadOnlyList<CandleWithVolume> Bars, string? Error)>> _today;
    private readonly Func<DateTimeOffset> _now;
    // The past days of a request, kept for the IST day they were read on: (underlying, interval, from, to) -> candles.
    private readonly ConcurrentDictionary<(string, int, DateOnly, DateOnly), IReadOnlyList<CandleWithVolume>> _pastHeld = new();
    private DateOnly _heldOn;

    public SpotStructureService(DhanSpotInstrumentMaster instruments, DhanHistoricalDataService history, OiReplayService oiReplay)
        : this(async (underlying, from, to, interval, ct) =>
        {
            await instruments.EnsureLoadedAsync(ct);
            var instrument = instruments.FindSpot(underlying);
            if (instrument is null) return (Array.Empty<CandleWithVolume>(), $"No {underlying} index in Dhan's scrip master.");
            return await history.GetIntradayCandlesAsync(instrument.SecurityId, instrument.DhanSegment, from, to, interval, ct);
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
        Func<string, DateOnly, DateOnly, int, CancellationToken, Task<(IReadOnlyList<CandleWithVolume>, string?)>> past,
        Func<string, DateOnly, CancellationToken, Task<(IReadOnlyList<CandleWithVolume>, string?)>> today,
        Func<DateTimeOffset> now)
    {
        _past = past;
        _today = today;
        _now = now;
    }

    public sealed record Result(string Underlying, int Timeframe, int Days, DateOnly From, DateOnly To, IReadOnlyList<CandleWithVolume> Candles, bool TodayIncluded, string? Error);

    public async Task<Result> CandlesAsync(string underlying, int timeframe, int? days, CancellationToken cancellationToken)
    {
        underlying = underlying.ToUpperInvariant();
        if (!Timeframes.TryGetValue(timeframe, out var spec))
            throw new ArgumentException($"Timeframe {timeframe} is not offered - one of {string.Join(", ", Timeframes.Keys)} (minutes; 1440 = a day).");
        var span = Math.Clamp(days ?? spec.DefaultDays, 1, spec.MaxDays);
        var today = IstClock.IstDate(_now());
        var from = today.AddDays(-span);
        var lastPast = LastWeekdayBefore(today);
        if (_heldOn != today) { _pastHeld.Clear(); _heldOn = today; }

        var errors = new List<string>();
        var minutes = new List<CandleWithVolume>();
        if (from <= lastPast)
        {
            if (_pastHeld.TryGetValue((underlying, spec.Interval, from, lastPast), out var held)) minutes.AddRange(held);
            else
            {
                var pastCandles = new List<CandleWithVolume>();
                string? pastError = null;
                foreach (var (chunkFrom, chunkTo) in Chunks(from, lastPast))
                {
                    var (candles, error) = await _past(underlying, chunkFrom, chunkTo, spec.Interval, cancellationToken);
                    pastCandles.AddRange(candles);
                    pastError ??= error;
                }
                if (pastError is null) _pastHeld[(underlying, spec.Interval, from, lastPast)] = pastCandles;
                else errors.Add($"past days: {pastError}");
                minutes.AddRange(pastCandles);
            }
        }

        var todayIncluded = false;
        if (today.DayOfWeek is not (DayOfWeek.Saturday or DayOfWeek.Sunday) && TimeOnly.FromDateTime(_now().ToOffset(IstClock.Offset).DateTime) >= SessionStart)
        {
            var (bars, error) = await _today(underlying, today, cancellationToken);
            if (bars.Count > 0) { minutes.AddRange(bars); todayIncluded = true; }
            else if (error is not null) errors.Add($"today: {error}");
        }
        return new Result(underlying, timeframe, span, from, today, Aggregate(minutes, timeframe), todayIncluded, errors.Count > 0 ? string.Join(" · ", errors) : null);
    }

    /// <summary>The weekday before `today` - the last day a window of past days asks for (a weekend after the last session
    /// would never be kept on disk, so a window ending on it went to Dhan at every load).</summary>
    internal static DateOnly LastWeekdayBefore(DateOnly today)
    {
        var d = today.AddDays(-1);
        while (d.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) d = d.AddDays(-1);
        return d;
    }

    /// <summary>[from, to] in pieces of at most ChunkDays calendar days, oldest first.</summary>
    internal static IEnumerable<(DateOnly From, DateOnly To)> Chunks(DateOnly from, DateOnly to)
    {
        for (var start = from; start <= to; start = start.AddDays(ChunkDays))
        {
            var end = start.AddDays(ChunkDays - 1);
            yield return (start, end < to ? end : to);
        }
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

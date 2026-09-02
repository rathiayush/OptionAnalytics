using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>Small helpers shared between BacktestService's own replay and any IBacktestStrategy
/// that needs the same day-boundary/aggregation logic - an intraday strategy walking forward bar
/// by bar needs to know when its own trading day ends.</summary>
public static class BacktestUtil
{
    /// <summary>Buckets native 1-minute closed bars into <paramref name="minutes"/>-minute OHLC
    /// bars - the server-side counterpart to the dashboard's client-side aggregateCandles, needed
    /// here because EMA9/21 (and anything else a strategy computes) has to be recomputed off the
    /// coarser bars themselves, not just redrawn from the same 1-minute signals.
    ///
    /// The LAST bucket this produces is dropped unless it is genuinely complete - callers only ever
    /// pass CLOSED 1-minute bars in, but "closed at 1 minute" does not mean "closed at 5 minutes":
    /// asked for 5-minute bars at, say, 09:47, the 09:45 bucket has only the 09:45/46 sub-bars so
    /// far, with 09:47/48/49 still to close. Returning it anyway would hand a strategy - and, live,
    /// a trigger re-evaluating every 30 seconds - a candle whose High/Low/Close can still change and
    /// whose EMA can still cross the OTHER way once the remaining minutes actually close, which is
    /// exactly "the signal fired off a candle that had not finished forming." A live evaluation
    /// simply sees one fewer (genuinely closed) bar until the window completes; nothing about a
    /// true backtest over old history changes, since every bucket there is long since complete
    /// regardless.</summary>
    public static List<Candle> AggregateCandles(IReadOnlyList<Candle> bars, int minutes)
    {
        if (minutes <= 1 || bars.Count == 0) return bars.ToList();

        var bucketSeconds = minutes * 60;
        var buckets = new SortedDictionary<long, Candle>();
        foreach (var bar in bars)
        {
            var bucketEpoch = bar.Time.ToUnixTimeSeconds() / bucketSeconds * bucketSeconds;
            var bucketTime = DateTimeOffset.FromUnixTimeSeconds(bucketEpoch);
            buckets[bucketEpoch] = buckets.TryGetValue(bucketEpoch, out var existing)
                ? existing with { High = Math.Max(existing.High, bar.High), Low = Math.Min(existing.Low, bar.Low), Close = bar.Close }
                : new Candle(bucketTime, bar.Open, bar.High, bar.Low, bar.Close);
        }

        var result = buckets.Values.ToList();
        DropTrailingBucketIfIncomplete(result, r => r.Time, LatestCoveredSecond(bars, b => b.Time), bucketSeconds);
        return result;
    }

    /// <summary>The IST (UTC+5:30, fixed offset) calendar date a bar's time falls on - what any
    /// intraday strategy uses to detect "the trading day ended, exit here" rather than riding a
    /// position into the next day.</summary>
    public static DateOnly IstDate(DateTimeOffset time) => DateOnly.FromDateTime(time.ToOffset(TimeSpan.FromHours(5.5)).DateTime);

    /// <summary>Buckets a running-total line (CDV/OBV) to <paramref name="minutes"/>-minute
    /// resolution. Unlike a candle, the meaningful value for a coarser bucket is simply the LAST
    /// sample in it - a running total's bucket value is where it stood at the end of that bucket -
    /// which is the same rule the dashboard's own client-side aggregateLine uses.
    ///
    /// Same still-forming-trailing-bucket rule as AggregateCandles, and for the same reason: the
    /// source points here are themselves 1-minute-bucketed (see CdvUnderlyingState.GetObvSeries /
    /// GetSmoothedCdvSeries), so a 5-minute OBV/CDV bucket at 09:47 is just as incomplete as the
    /// price candle for the same window - and a strategy's volume-alignment check reading that
    /// bucket's still-changing value is the exact same "signal off an unfinished bar" problem, just
    /// on the confirmation side of the check rather than the entry-trigger side.</summary>
    public static List<ObvPoint> AggregateLine(IReadOnlyList<ObvPoint> points, int minutes)
    {
        if (minutes <= 1 || points.Count == 0) return points.ToList();

        var bucketSeconds = minutes * 60;
        var buckets = new SortedDictionary<long, ObvPoint>();
        foreach (var point in points)
        {
            var bucketEpoch = point.Time.ToUnixTimeSeconds() / bucketSeconds * bucketSeconds;
            buckets[bucketEpoch] = new ObvPoint(DateTimeOffset.FromUnixTimeSeconds(bucketEpoch), point.Obv);
        }

        var result = buckets.Values.ToList();
        DropTrailingBucketIfIncomplete(result, p => p.Time, LatestCoveredSecond(points, p => p.Time), bucketSeconds);
        return result;
    }

    /// <summary>One past the last second any source point actually covers - each source point is
    /// itself a closed 1-minute bar/sample, so it accounts for its own minute through :59.</summary>
    private static long LatestCoveredSecond<T>(IReadOnlyList<T> source, Func<T, DateTimeOffset> time)
    {
        var latest = long.MinValue;
        foreach (var item in source)
        {
            var t = time(item).ToUnixTimeSeconds();
            if (t > latest) latest = t;
        }
        return latest + 60;
    }

    /// <summary>Drops the last bucket in <paramref name="buckets"/> if its nominal window extends
    /// past what the source data actually covers - see AggregateCandles/AggregateLine's own doc
    /// comments for why a bucket that has not finished forming must not be reported to a strategy
    /// or a live trigger as though it had.</summary>
    private static void DropTrailingBucketIfIncomplete<T>(
        List<T> buckets, Func<T, DateTimeOffset> time, long latestCoveredSecond, long bucketSeconds)
    {
        if (buckets.Count == 0) return;
        var lastBucketStart = time(buckets[^1]).ToUnixTimeSeconds();
        if (lastBucketStart + bucketSeconds > latestCoveredSecond) buckets.RemoveAt(buckets.Count - 1);
    }
}

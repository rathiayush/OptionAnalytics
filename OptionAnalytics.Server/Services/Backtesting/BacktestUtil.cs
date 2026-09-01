using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>Small helpers shared between BacktestService's own replay and any IBacktestStrategy
/// that needs the same day-boundary/aggregation logic (an intraday strategy walking forward bar by
/// bar needs to know when its own trading day ends, same as OtmConfluenceStrategy does).</summary>
public static class BacktestUtil
{
    /// <summary>Buckets native 1-minute closed bars into <paramref name="minutes"/>-minute OHLC
    /// bars - the server-side counterpart to the dashboard's client-side aggregateCandles, needed
    /// here because EMA9/21 (and anything else a strategy computes) has to be recomputed off the
    /// coarser bars themselves, not just redrawn from the same 1-minute signals.</summary>
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
        return buckets.Values.ToList();
    }

    /// <summary>The IST (UTC+5:30, fixed offset) calendar date a bar's time falls on - what any
    /// intraday strategy uses to detect "the trading day ended, exit here" rather than riding a
    /// position into the next day.</summary>
    public static DateOnly IstDate(DateTimeOffset time) => DateOnly.FromDateTime(time.ToOffset(TimeSpan.FromHours(5.5)).DateTime);

    /// <summary>Buckets a running-total line (CDV/OBV) to <paramref name="minutes"/>-minute
    /// resolution. Unlike a candle, the meaningful value for a coarser bucket is simply the LAST
    /// sample in it - a running total's bucket value is where it stood at the end of that bucket -
    /// which is the same rule the dashboard's own client-side aggregateLine uses.</summary>
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
        return buckets.Values.ToList();
    }
}

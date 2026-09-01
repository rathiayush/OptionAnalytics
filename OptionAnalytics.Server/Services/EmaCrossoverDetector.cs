using OptionAnalytics.Server.Models;
using Skender.Stock.Indicators;

namespace OptionAnalytics.Server.Services;

/// <summary>Shared EMA9/21 crossover check off a closed-bar series - the exact math
/// EmaCrossoverAlertService (spot) and ConfluenceAlertService (ATM CE/PE) both need, factored out
/// so there is exactly one place computing "did the most recent bar cross" rather than two
/// hand-kept-in-sync copies.</summary>
public static class EmaCrossoverDetector
{
    public const int FastPeriod = 9;
    public const int SlowPeriod = 21;

    /// <summary>"Bullish" (EMA9 crossed above EMA21 on the most recent bar), "Bearish" (crossed
    /// below), or null (no crossover on that bar, or not enough closed bars yet to know).</summary>
    public static string? Detect(IReadOnlyList<Candle> closedBars)
    {
        var (prevDiff, currDiff) = EmaDiffs(closedBars);
        if (prevDiff is not { } pd || currDiff is not { } cd) return null;

        return pd <= 0 && cd > 0 ? "Bullish"
            : pd >= 0 && cd < 0 ? "Bearish"
            : null;
    }

    /// <summary>"Bullish" (EMA9 currently above EMA21) or "Bearish" (below) on the most recent bar
    /// - the CURRENT bias, unlike Detect which only answers on the bar an actual cross happened.
    /// ConfluenceAlertService uses this to keep a continuously up-to-date "where does each leg
    /// stand right now" state, not just react to the moment of crossing.</summary>
    public static string? CurrentDirection(IReadOnlyList<Candle> closedBars)
    {
        var (_, currDiff) = EmaDiffs(closedBars);
        if (currDiff is not { } cd || cd == 0) return null;
        return cd > 0 ? "Bullish" : "Bearish";
    }

    /// <summary>Every bar's EMA9/21 bias computed in one pass (Bullish/Bearish once there are
    /// enough bars, null before that or on an exact tie) - what BacktestService needs to replay a
    /// leg's whole history without CurrentDirection's per-call recomputation, which would be
    /// quadratic if called once per bar over a multi-day series.</summary>
    public static IReadOnlyList<(DateTimeOffset Time, string? Direction)> DirectionSeries(IReadOnlyList<Candle> closedBars)
    {
        if (closedBars.Count < SlowPeriod + 1)
            return closedBars.Select(c => (c.Time, (string?)null)).ToList();

        var quotes = closedBars.Select(c => new Quote
        {
            Date = c.Time.UtcDateTime,
            Open = c.Open,
            High = c.High,
            Low = c.Low,
            Close = c.Close,
            Volume = 0,
        }).ToList();

        var ema9 = quotes.GetEma(FastPeriod).ToList();
        var ema21 = quotes.GetEma(SlowPeriod).ToList();

        var result = new List<(DateTimeOffset, string?)>(closedBars.Count);
        for (var i = 0; i < closedBars.Count; i++)
        {
            string? direction = null;
            if (ema9[i].Ema is { } fast && ema21[i].Ema is { } slow && fast != slow)
                direction = fast > slow ? "Bullish" : "Bearish";
            result.Add((closedBars[i].Time, direction));
        }
        return result;
    }

    private static (decimal? Prev, decimal? Curr) EmaDiffs(IReadOnlyList<Candle> closedBars)
    {
        // Need at least one prior bar beyond the slow EMA's own seed window, so there is a
        // previous EMA9/EMA21 pair to compare the newest one against.
        if (closedBars.Count < SlowPeriod + 1) return (null, null);

        var quotes = closedBars.Select(c => new Quote
        {
            Date = c.Time.UtcDateTime,
            Open = c.Open,
            High = c.High,
            Low = c.Low,
            Close = c.Close,
            Volume = 0,
        }).ToList();

        var ema9 = quotes.GetEma(FastPeriod).ToList();
        var ema21 = quotes.GetEma(SlowPeriod).ToList();

        var last = quotes.Count - 1;
        if (ema9[last].Ema is not { } fastNow || ema21[last].Ema is not { } slowNow) return (null, null);
        if (ema9[last - 1].Ema is not { } fastPrev || ema21[last - 1].Ema is not { } slowPrev) return (null, (decimal)(fastNow - slowNow));

        return ((decimal)(fastPrev - slowPrev), (decimal)(fastNow - slowNow));
    }
}

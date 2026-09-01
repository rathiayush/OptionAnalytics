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
        // Need at least one prior bar beyond the slow EMA's own seed window, so there is a
        // previous EMA9/EMA21 pair to compare the newest one against.
        if (closedBars.Count < SlowPeriod + 1) return null;

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
        if (ema9[last].Ema is not { } fastNow || ema21[last].Ema is not { } slowNow) return null;
        if (ema9[last - 1].Ema is not { } fastPrev || ema21[last - 1].Ema is not { } slowPrev) return null;

        var prevDiff = fastPrev - slowPrev;
        var currDiff = fastNow - slowNow;

        return prevDiff <= 0 && currDiff > 0 ? "Bullish"
            : prevDiff >= 0 && currDiff < 0 ? "Bearish"
            : null;
    }
}

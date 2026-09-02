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

    /// <summary>The CURRENT bias on the most recent bar, but only once price has actually confirmed
    /// it: the bar's own CLOSE must have finished beyond BOTH the fast and slow EMA in that
    /// direction, not just have the EMA9-vs-EMA21 relationship flip. In a flat/choppy stretch the
    /// two EMAs can sit almost on top of each other (a few points apart on a 50,000+ index, or well
    /// under 1% apart on an option premium) and swap order on a single noisy tick while price never
    /// really leaves their neighborhood - every alert this app sends off a bare EMA9/21 relationship
    /// would then fire on that noise even though nothing directional actually happened. Requiring
    /// the close to clear both lines is what filters that out: EmaCrossoverAlertService (the spot
    /// leg) and ConfluenceAlertService (all three legs) both alert off this rather than the raw
    /// relationship. Null under the same conditions as before (not enough closed bars, or an exact
    /// EMA tie) plus one more: the relationship has a bias but price hasn't closed clear of both
    /// lines yet - not "no direction", just "not confirmed on this bar".</summary>
    public static string? ConfirmedDirection(IReadOnlyList<Candle> closedBars)
    {
        var series = ConfirmedDirectionSeries(closedBars);
        return series.Count > 0 ? series[^1].Direction : null;
    }

    /// <summary>Every bar's fast/slow EMA bias computed in one pass (Bullish/Bearish once there are
    /// enough bars, null before that or on an exact tie) - what BacktestService needs to replay a
    /// leg's whole history without CurrentDirection's per-call recomputation, which would be
    /// quadratic if called once per bar over a multi-day series. The periods default to the 9/21
    /// this app alerts on everywhere else; a strategy that lets them be tuned passes its own.</summary>
    public static IReadOnlyList<(DateTimeOffset Time, string? Direction)> DirectionSeries(
        IReadOnlyList<Candle> closedBars, int fastPeriod = FastPeriod, int slowPeriod = SlowPeriod)
    {
        // A fast period at or above the slow one has no crossover to detect - guard rather than
        // emit nonsense, since these are user-supplied on the tunable strategies.
        if (fastPeriod < 1 || slowPeriod < 1 || fastPeriod >= slowPeriod || closedBars.Count < slowPeriod + 1)
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

        var fastEma = quotes.GetEma(fastPeriod).ToList();
        var slowEma = quotes.GetEma(slowPeriod).ToList();

        var result = new List<(DateTimeOffset, string?)>(closedBars.Count);
        for (var i = 0; i < closedBars.Count; i++)
        {
            string? direction = null;
            if (fastEma[i].Ema is { } fast && slowEma[i].Ema is { } slow && fast != slow)
                direction = fast > slow ? "Bullish" : "Bearish";
            result.Add((closedBars[i].Time, direction));
        }
        return result;
    }

    /// <summary>One EMA's value at every bar, null until the period's seed window has filled -
    /// what a strategy reasoning about where price sits RELATIVE to a single moving average needs
    /// (FiveEmaStrategy's "is this candle entirely clear of the 5 EMA?"), as opposed to the
    /// fast-vs-slow comparison the rest of this class is about.</summary>
    public static IReadOnlyList<decimal?> EmaSeries(IReadOnlyList<Candle> bars, int period)
    {
        if (period < 1 || bars.Count == 0) return bars.Select(_ => (decimal?)null).ToList();

        var quotes = bars.Select(c => new Quote
        {
            Date = c.Time.UtcDateTime,
            Open = c.Open,
            High = c.High,
            Low = c.Low,
            Close = c.Close,
            Volume = 0,
        }).ToList();

        return quotes.GetEma(period).Select(e => (decimal?)e.Ema).ToList();
    }

    /// <summary>Batch counterpart to ConfirmedDirection - every bar's confirmed bias in one pass,
    /// same "not quadratic over a multi-day series" reasoning as DirectionSeries. BacktestService's
    /// Confluence replay uses this (not the plain DirectionSeries) so the Backtrack page and every
    /// Strategy Trigger built off a Confluence/Entry signal reproduce EXACTLY what
    /// EmaCrossoverAlertService/ConfluenceAlertService would have alerted live - see
    /// ConfirmedDirection's own doc comment for why requiring the close to have actually finished
    /// beyond both EMAs (not just their relationship flipping) matters. EmaSurgeStrategy
    /// deliberately keeps using the plain DirectionSeries instead: it already has its own,
    /// separately-tuned volume-alignment noise filter, and folding this confirmation into its
    /// crossover math too would be a second, unreviewed change to a strategy this app tunes
    /// independently.</summary>
    public static IReadOnlyList<(DateTimeOffset Time, string? Direction)> ConfirmedDirectionSeries(
        IReadOnlyList<Candle> closedBars, int fastPeriod = FastPeriod, int slowPeriod = SlowPeriod)
    {
        if (fastPeriod < 1 || slowPeriod < 1 || fastPeriod >= slowPeriod || closedBars.Count < slowPeriod + 1)
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

        var fastEma = quotes.GetEma(fastPeriod).ToList();
        var slowEma = quotes.GetEma(slowPeriod).ToList();

        var result = new List<(DateTimeOffset, string?)>(closedBars.Count);
        for (var i = 0; i < closedBars.Count; i++)
        {
            string? direction = null;
            if (fastEma[i].Ema is { } fastRaw && slowEma[i].Ema is { } slowRaw && fastRaw != slowRaw)
            {
                var fast = (decimal)fastRaw;
                var slow = (decimal)slowRaw;
                var close = closedBars[i].Close;
                if (fast > slow) { if (close > fast && close > slow) direction = "Bullish"; }
                else { if (close < fast && close < slow) direction = "Bearish"; }
            }
            result.Add((closedBars[i].Time, direction));
        }
        return result;
    }
}

using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// Covers Rsi2MeanReversionStrategy's own reasoning - a genuine RSI(2) extreme fires when price is
/// still trending the required way, the SAME extreme is rejected when price has already broken that
/// trend, turning the trend filter off removes that requirement, and the direction/signal-start
/// filters reject instead of silently dropping a qualifying extreme.
///
/// Every fixture is a steady linear trend (so RSI(2) and the trend SMA are both easy to reason
/// about) followed by ONE bar that pulls RSI(2) to an extreme - the exact numbers (trend length,
/// step, and the extreme bar's close) were chosen empirically against Skender's own RSI(2)/SMA(20)
/// output rather than derived by hand, since RSI's Wilder-style smoothing has no simple closed form;
/// custom oversoldBelow=13/overboughtAbove=87 (instead of Connors' own 10/90) just widen the margin
/// between "RSI is extreme" and "price is on the required side of trend" so the fixtures are not
/// balanced on a knife's edge between the two.
/// </summary>
public sealed class Rsi2MeanReversionStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero); // 09:30 IST

    private static IReadOnlyList<Candle> BuildTrendThenExtreme(int trendBars, decimal startPrice, decimal step, decimal extremeClose, DateTimeOffset? start = null)
    {
        var bars = new List<Candle>();
        var time = start ?? T0;
        var price = startPrice;

        for (var i = 0; i < trendBars; i++)
        {
            bars.Add(new Candle(time, price, price, price, price));
            time = time.AddMinutes(1);
            price += step;
        }
        bars.Add(new Candle(time, extremeClose, extremeClose, extremeClose, extremeClose));

        return bars;
    }

    // An 80-bar uptrend (1000, step +3) pulled back to 1216 in one bar - RSI(2) drops to ~12.5
    // (at/below the 13 test threshold) while price (1216) stays above the 20-SMA (~1210.3).
    private static IReadOnlyList<Candle> BullishWithinUptrend(DateTimeOffset? start = null) =>
        BuildTrendThenExtreme(80, 1000, 3, 1216, start);

    // A shorter, 60-bar uptrend pulled back much harder to 1100 - RSI(2) falls to ~3.75 (still well
    // oversold), but this dip is sharp enough that price (1100) has ALSO fallen below the 20-SMA
    // (~1147.5) - the trend has broken, not just paused, so Connors' own filter must reject it.
    private static IReadOnlyList<Candle> BullishBelowItsOwnTrend(DateTimeOffset? start = null) =>
        BuildTrendThenExtreme(60, 1000, 3, 1100, start);

    // The mirror of BullishWithinUptrend - an 80-bar downtrend (2000, step -3) rallying to 1785 -
    // RSI(2) rises to ~88 (at/above the 87 test threshold) while price (1785) stays below the
    // 20-SMA (~1789.75).
    private static IReadOnlyList<Candle> BearishWithinDowntrend(DateTimeOffset? start = null) =>
        BuildTrendThenExtreme(80, 2000, -3, 1785, start);

    // The mirror of BullishBelowItsOwnTrend - a shorter, 60-bar downtrend rallying hard to 1950:
    // RSI(2) reads ~97.7 (deeply overbought), but price (1950) has already risen back ABOVE the
    // 20-SMA (~1855), so the downtrend has broken and Connors' own filter must reject it.
    private static IReadOnlyList<Candle> BearishAboveItsOwnTrend(DateTimeOffset? start = null) =>
        BuildTrendThenExtreme(60, 2000, -3, 1950, start);

    private static BacktestStrategyContext Context(IReadOnlyList<Candle> spotBars, Func<decimal, bool, IReadOnlyList<Candle>>? getOptionBars = null) => new()
    {
        Underlying = "NIFTY",
        TimeframeMinutes = 1,
        Step = 50,
        SpotBars = spotBars,
        ConfluenceSignalsAscending = Array.Empty<BacktestSignal>(),
        AllSignals = Array.Empty<BacktestSignal>(),
        ObvCeSeries = Array.Empty<ObvPoint>(),
        ObvPeSeries = Array.Empty<ObvPoint>(),
        CdvCeSeries = Array.Empty<ObvPoint>(),
        CdvPeSeries = Array.Empty<ObvPoint>(),
        GetOptionBars = getOptionBars ?? ((_, _) => Array.Empty<Candle>()),
        AtmCeBars = Array.Empty<Candle>(),
        AtmPeBars = Array.Empty<Candle>(),
        AtmCeVolumeBars = Array.Empty<CandleWithVolume>(),
        AtmPeVolumeBars = Array.Empty<CandleWithVolume>(),
        AtmStrike = null,
    };

    private static Dictionary<string, decimal> Parameters(
        decimal useTrendFilter = 1, decimal direction = 0, decimal signalStartMinutes = 555) => new()
    {
        ["side"] = OptionTradeSimulator.SideBuy,
        ["otmSteps"] = 1,
        ["slPoints"] = 10,
        ["tpPoints"] = 20,
        ["rsiPeriod"] = 2,
        ["oversoldBelow"] = 13,
        ["overboughtAbove"] = 87,
        ["useTrendFilter"] = useTrendFilter,
        ["trendPeriod"] = 20,
        ["direction"] = direction,
        ["signalStartMinutes"] = signalStartMinutes,
    };

    [Fact]
    public void EntrySignals_OversoldWithinAnUptrend_FiresBullishEntry()
    {
        var context = Context(BullishWithinUptrend());
        var strategy = new Rsi2MeanReversionStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal("Bullish", entry.Direction);
    }

    [Fact]
    public void EntrySignals_OversoldButTrendAlreadyBroken_RejectsInsteadOfEntering()
    {
        var context = Context(BullishBelowItsOwnTrend());
        var strategy = new Rsi2MeanReversionStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish" && s.Summary.Contains("trend filter"));
    }

    [Fact]
    public void EntrySignals_TrendFilterOff_FiresEvenWithTheTrendAlreadyBroken()
    {
        var context = Context(BullishBelowItsOwnTrend());
        var strategy = new Rsi2MeanReversionStrategy();

        var signals = strategy.EntrySignals(context, Parameters(useTrendFilter: 0));

        // With the trend filter off, the very first bars of this pure uptrend ALSO read as their
        // own (Bearish/overbought) RSI(2) extreme - real behaviour, not a bug, since a monotonic
        // run this clean is itself a synthetic-fixture artifact real price noise would not produce
        // this early. This test only cares that the fixture's OWN dip still fires once the trend
        // filter that used to reject it (for having no SMA warmup yet) is gone.
        Assert.Contains(signals, s => s.Kind == "Entry" && s.Direction == "Bullish" && s.Summary.Contains("3.75"));
    }

    [Fact]
    public void EntrySignals_OverboughtWithinADowntrend_FiresBearishEntry()
    {
        var context = Context(BearishWithinDowntrend());
        var strategy = new Rsi2MeanReversionStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal("Bearish", entry.Direction);
    }

    [Fact]
    public void EntrySignals_OverboughtButTrendAlreadyBroken_RejectsInsteadOfEntering()
    {
        var context = Context(BearishAboveItsOwnTrend());
        var strategy = new Rsi2MeanReversionStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bearish" && s.Summary.Contains("trend filter"));
    }

    [Fact]
    public void Simulate_OversoldWithinAnUptrend_ProducesABuyCallTrade()
    {
        var bars = BullishWithinUptrend();
        var optionBars = bars.Select(b => new Candle(b.Time, 50, 55, 45, 50)).ToList();
        var context = Context(bars, (_, isCall) => isCall ? optionBars : Array.Empty<Candle>());
        var strategy = new Rsi2MeanReversionStrategy();

        var trades = strategy.Simulate(context, Parameters());

        var trade = Assert.Single(trades);
        Assert.Equal("Bullish", trade.Direction);
        Assert.Equal("Buy", trade.Side);
        Assert.Equal("CE", trade.OptionType);
    }

    [Fact]
    public void EntrySignals_DirectionFilterExcludesTheOppositeSide_RejectsInsteadOfEntering()
    {
        var context = Context(BullishWithinUptrend());
        var strategy = new Rsi2MeanReversionStrategy();

        var signals = strategy.EntrySignals(context, Parameters(direction: 2 /* overbought pullbacks only */));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish" && s.Summary.Contains("overbought pullbacks only"));
    }

    // Early enough that all 81 bars of BullishWithinUptrend (not just its first couple) land before
    // the default 09:15 IST cutoff - unlike the other strategies' single-bar reversals, this
    // fixture's own signal bar is 80 minutes into the series, so the shift needs to clear that too.
    private static readonly DateTimeOffset EarlyStart = new(2026, 1, 4, 20, 30, 0, TimeSpan.Zero); // 02:00 IST

    [Fact]
    public void EntrySignals_ExtremeBeforeSignalStartTime_RejectsInsteadOfEntering()
    {
        var context = Context(BullishWithinUptrend(EarlyStart));
        var strategy = new Rsi2MeanReversionStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("pre-open"));
    }
}

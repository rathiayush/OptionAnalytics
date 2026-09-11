using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// Covers GoldenCrossStrategy's own reasoning - firing on a real SMA crossover (not every bar it
/// continues to hold), and the direction filter. Uses small custom fast/slow periods (3/7) rather
/// than the famous 50/200 default so a clear reversal fits in a short, hand-verifiable bar series -
/// the crossover MATH is identical at any period, and the real 50/200 default is covered by the
/// live-API smoke test instead of needing a 200+ bar fixture here.
/// </summary>
public sealed class GoldenCrossStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero); // 09:30 IST

    /// <summary>10 bars declining 100 -> 91 (long enough to seed a 7-SMA firmly below where price
    /// is about to go), then 8 bars rallying sharply 91 -> 147 - strong enough that the 3-SMA
    /// crosses back above the 7-SMA partway through.</summary>
    private static IReadOnlyList<Candle> BuildReversalBars(DateTimeOffset? start = null)
    {
        var bars = new List<Candle>();
        var time = start ?? T0;
        var price = 100m;

        for (var i = 0; i < 10; i++)
        {
            bars.Add(new Candle(time, price, price, price, price));
            time = time.AddMinutes(1);
            price -= 1;
        }
        for (var i = 0; i < 8; i++)
        {
            price += 7;
            bars.Add(new Candle(time, price, price, price, price));
            time = time.AddMinutes(1);
        }

        return bars;
    }

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

    private static Dictionary<string, decimal> Parameters(decimal direction = 0, decimal signalStartMinutes = 555) => new()
    {
        ["side"] = OptionTradeSimulator.SideBuy,
        ["otmSteps"] = 1,
        ["slPoints"] = 10,
        ["tpPoints"] = 20,
        ["fastPeriod"] = 3,
        ["slowPeriod"] = 7,
        ["direction"] = direction,
        ["signalStartMinutes"] = signalStartMinutes,
    };

    [Fact]
    public void EntrySignals_SharpReversal_FiresExactlyOneGoldenCrossEntry()
    {
        var context = Context(BuildReversalBars());
        var strategy = new GoldenCrossStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        var bullishEntries = signals.Where(s => s.Kind == "Entry" && s.Direction == "Bullish").ToList();
        Assert.Single(bullishEntries);
        Assert.Contains("Golden Cross", bullishEntries[0].Summary);
    }

    [Fact]
    public void Simulate_SharpReversal_ProducesABuyCallTrade()
    {
        var bars = BuildReversalBars();
        var optionBars = bars.Select(b => new Candle(b.Time, 50, 55, 45, 50)).ToList();
        var context = Context(bars, (_, isCall) => isCall ? optionBars : Array.Empty<Candle>());
        var strategy = new GoldenCrossStrategy();

        var trades = strategy.Simulate(context, Parameters());

        var bullishTrades = trades.Where(t => t.Direction == "Bullish").ToList();
        var trade = Assert.Single(bullishTrades);
        Assert.Equal("Buy", trade.Side);
        Assert.Equal("CE", trade.OptionType);
    }

    [Fact]
    public void EntrySignals_DirectionFilterExcludesTheOppositeSide_RejectsInsteadOfEntering()
    {
        var context = Context(BuildReversalBars());
        var strategy = new GoldenCrossStrategy();

        // The reversal produces a Golden Cross (Bullish) - "Death Cross only" must reject it, not
        // silently enter the wrong side. The earlier Bearish cross (the initial fast-below-slow
        // reading, unset -> Bearish counts as a change) must still fire normally.
        var signals = strategy.EntrySignals(context, Parameters(direction: 2 /* Death Cross only */));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish");
    }

    private static readonly DateTimeOffset EarlyStart = new(2026, 1, 5, 3, 0, 0, TimeSpan.Zero); // 08:30 IST

    [Fact]
    public void EntrySignals_ReversalBeforeSignalStartTime_RejectsInsteadOfEntering()
    {
        var context = Context(BuildReversalBars(EarlyStart));
        var strategy = new GoldenCrossStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("pre-open"));
    }

    [Fact]
    public void EntrySignals_FastPeriodNotBelowSlowPeriod_ReturnsNoSignals()
    {
        var context = Context(BuildReversalBars());
        var strategy = new GoldenCrossStrategy();

        var parameters = Parameters();
        parameters["fastPeriod"] = 10;
        parameters["slowPeriod"] = 10; // invalid - fast must be strictly below slow

        var signals = strategy.EntrySignals(context, parameters);

        Assert.Empty(signals);
    }
}

using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// Covers VmaStrategy's own reasoning - firing on a real price/VMA crossover (not every bar the
/// same side stays on top), and the direction/signal-start filters. Like SuperTrendStrategyTests,
/// the reversal fixture also produces an initial "crossover" the moment VMA first has a value
/// (verified empirically: this fixture crosses at bar index 10, Bearish, then again at the real
/// reversal, bar index 20, Bullish) - tests key off finding the specific Bullish entry the reversal
/// itself causes, not "the only signal", the same tolerance this app's other adaptive-line
/// strategies use for their own cold start.
/// </summary>
public sealed class VmaStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero); // 09:30 IST

    private static IReadOnlyList<Candle> BuildReversalBars(DateTimeOffset? start = null)
    {
        var bars = new List<Candle>();
        var time = start ?? T0;
        var price = 100m;

        for (var i = 0; i < 20; i++)
        {
            bars.Add(new Candle(time, price, price, price, price));
            time = time.AddMinutes(1);
            price -= 1;
        }
        for (var i = 0; i < 15; i++)
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
        AtmStrike = null,
    };

    private static Dictionary<string, decimal> Parameters(decimal direction = 0, decimal signalStartMinutes = 555) => new()
    {
        ["side"] = OptionTradeSimulator.SideBuy,
        ["otmSteps"] = 1,
        ["slPoints"] = 8,
        ["tpPoints"] = 80,
        ["period"] = 9,
        ["direction"] = direction,
        ["signalStartMinutes"] = signalStartMinutes,
    };

    [Fact]
    public void EntrySignals_SharpReversal_FiresABullishEntry()
    {
        var context = Context(BuildReversalBars());
        var strategy = new VmaStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.Contains(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
    }

    [Fact]
    public void Simulate_SharpReversal_ProducesABuyCallTrade()
    {
        var bars = BuildReversalBars();
        var optionBars = bars.Select(b => new Candle(b.Time, 50, 55, 45, 50)).ToList();
        var context = Context(bars, (_, isCall) => isCall ? optionBars : Array.Empty<Candle>());
        var strategy = new VmaStrategy();

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
        var strategy = new VmaStrategy();

        var signals = strategy.EntrySignals(context, Parameters(direction: 2 /* Bearish crosses only */));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish" && s.Summary.Contains("bearish crosses only"));
    }

    private static readonly DateTimeOffset EarlyStart = new(2026, 1, 5, 3, 0, 0, TimeSpan.Zero); // 08:30 IST

    [Fact]
    public void EntrySignals_SignalStartTimeDisabled_FiresEvenBeforeDefaultCutoff()
    {
        var context = Context(BuildReversalBars(EarlyStart));
        var strategy = new VmaStrategy();

        var signals = strategy.EntrySignals(context, Parameters(signalStartMinutes: 0));

        Assert.Contains(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
        Assert.DoesNotContain(signals, s => s.Summary.Contains("pre-open"));
    }

    [Fact]
    public void EntrySignals_ReversalBeforeSignalStartTime_RejectsInsteadOfEntering()
    {
        var context = Context(BuildReversalBars(EarlyStart));
        var strategy = new VmaStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish" && s.Summary.Contains("pre-open"));
    }
}

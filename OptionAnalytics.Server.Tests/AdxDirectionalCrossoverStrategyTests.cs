using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// Covers AdxDirectionalCrossoverStrategy's own reasoning - firing on a real DI+/DI- crossover (not
/// every bar the same side stays on top), the ADX-minimum filter, and the direction/signal-start
/// filters. Like EmaCrossoverStrategyTests, the reversal fixture also produces an initial "crossover"
/// the moment DI+/DI- first both have values - here it is additionally rejected on its own for
/// having no ADX yet, so tests key off finding the specific crossover the reversal itself causes
/// rather than asserting there is only one signal in total.
/// </summary>
public sealed class AdxDirectionalCrossoverStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero); // 09:30 IST

    /// <summary>30 bars declining 100 -> 71 (long enough for ADX/DMI(14) to seed and settle, DI-
    /// above DI+), then 20 bars rallying sharply to 219 - strong enough that DI+ crosses back above
    /// DI- partway through, with real ADX strength behind it by then (verified empirically against
    /// Skender's own GetAdx(14) output: the crossover lands at bar index 31, ADX ~89, comfortably
    /// above the 20 default minimum).</summary>
    private static IReadOnlyList<Candle> BuildReversalBars(DateTimeOffset? start = null)
    {
        var bars = new List<Candle>();
        var time = start ?? T0;
        var price = 100m;

        for (var i = 0; i < 30; i++)
        {
            bars.Add(new Candle(time, price, price + 2, price - 2, price));
            time = time.AddMinutes(1);
            price -= 1;
        }
        for (var i = 0; i < 20; i++)
        {
            price += 7;
            bars.Add(new Candle(time, price, price + 2, price - 2, price));
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

    private static Dictionary<string, decimal> Parameters(decimal adxMinimum = 20, decimal direction = 0, decimal signalStartMinutes = 555) => new()
    {
        ["side"] = OptionTradeSimulator.SideBuy,
        ["otmSteps"] = 1,
        ["slPoints"] = 8,
        ["tpPoints"] = 80,
        ["adxPeriod"] = 14,
        ["adxMinimum"] = adxMinimum,
        ["direction"] = direction,
        ["signalStartMinutes"] = signalStartMinutes,
    };

    [Fact]
    public void EntrySignals_SharpReversal_FiresBullishEntry()
    {
        var context = Context(BuildReversalBars());
        var strategy = new AdxDirectionalCrossoverStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.Contains(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
    }

    [Fact]
    public void Simulate_SharpReversal_ProducesABuyCallTrade()
    {
        var bars = BuildReversalBars();
        var optionBars = bars.Select(b => new Candle(b.Time, 50, 55, 45, 50)).ToList();
        var context = Context(bars, (_, isCall) => isCall ? optionBars : Array.Empty<Candle>());
        var strategy = new AdxDirectionalCrossoverStrategy();

        var trades = strategy.Simulate(context, Parameters());

        var bullishTrades = trades.Where(t => t.Direction == "Bullish").ToList();
        var trade = Assert.Single(bullishTrades);
        Assert.Equal("Buy", trade.Side);
        Assert.Equal("CE", trade.OptionType);
    }

    [Fact]
    public void EntrySignals_AdxMinimumImpossiblyHigh_RejectsInsteadOfEntering()
    {
        var context = Context(BuildReversalBars());
        var strategy = new AdxDirectionalCrossoverStrategy();

        // ADX can never exceed 100 - guarantees this veto fires regardless of the exact ADX value,
        // the same "impossible threshold" pattern this app's other filter tests already use.
        var signals = strategy.EntrySignals(context, Parameters(adxMinimum: 101));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish" && s.Summary.Contains("ADX"));
    }

    [Fact]
    public void EntrySignals_DirectionFilterExcludesTheOppositeSide_RejectsInsteadOfEntering()
    {
        var context = Context(BuildReversalBars());
        var strategy = new AdxDirectionalCrossoverStrategy();

        var signals = strategy.EntrySignals(context, Parameters(direction: 2 /* DI- crosses only */));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish" && s.Summary.Contains("DI- crosses only"));
    }

    private static readonly DateTimeOffset EarlyStart = new(2026, 1, 5, 3, 0, 0, TimeSpan.Zero); // 08:30 IST

    [Fact]
    public void EntrySignals_SignalStartTimeDisabled_FiresEvenBeforeDefaultCutoff()
    {
        var context = Context(BuildReversalBars(EarlyStart));
        var strategy = new AdxDirectionalCrossoverStrategy();

        var signals = strategy.EntrySignals(context, Parameters(signalStartMinutes: 0));

        Assert.Contains(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
    }
}

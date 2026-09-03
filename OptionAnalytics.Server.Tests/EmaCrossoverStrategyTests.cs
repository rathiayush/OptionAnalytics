using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// Covers EmaCrossoverStrategy's own reasoning - firing on a real direction change (not every bar
/// the crossover continues to hold), the slope filter, and the direction filter. The EMA math itself
/// (EmaCrossoverDetector) is already exercised in production by EmaCrossoverAlertService/
/// ConfluenceAlertService, so these tests build a bar series with a clear, unambiguous trend
/// reversal (a steady decline, then a sharp sustained rally) and assert on the strategy's behaviour
/// around whatever crossover that reversal produces, rather than hand-computing exact EMA values.
/// </summary>
public sealed class EmaCrossoverStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero);

    /// <summary>30 bars declining 100 -> 71 (a steady downtrend, giving both EMAs time to seed past
    /// the default slowPeriod=21 and firmly settle fast-below-slow), then 15 bars rallying sharply
    /// 71 -> 176 - a reversal strong enough that the fast EMA (9) crosses back above the slow EMA
    /// (21) partway through, exactly the "real trend reversal" case this strategy exists for.
    ///
    /// This produces TWO direction changes, not one - the first the instant the slow EMA has enough
    /// bars to compute at all (a Bearish reading, since the market has already been declining for
    /// nine-plus bars by then), the second the actual reversal. The first is not a bug: it is the
    /// exact same "previously unset counts as changed" rule BacktestService.TryUpdateLeg already
    /// applies to its own leg-tracking, applied here consistently. Tests key off Direction, not
    /// "the only signal", to stay correct regardless of that first one.</summary>
    private static IReadOnlyList<Candle> BuildReversalBars()
    {
        var bars = new List<Candle>();
        var time = T0;
        var price = 100m;

        for (var i = 0; i < 30; i++)
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
    };

    private static Dictionary<string, decimal> Parameters(decimal minSlopePercent = 0, decimal direction = 0) => new()
    {
        ["side"] = OptionTradeSimulator.SideBuy,
        ["otmSteps"] = 1,
        ["slPoints"] = 10,
        ["tpPoints"] = 20,
        ["fastPeriod"] = EmaCrossoverDetector.FastPeriod,
        ["slowPeriod"] = EmaCrossoverDetector.SlowPeriod,
        ["minSlopePercent"] = minSlopePercent,
        ["slopeLookbackBars"] = 3,
        ["direction"] = direction,
    };

    [Fact]
    public void EntrySignals_SharpReversal_FiresExactlyOneBullishEntry()
    {
        var context = Context(BuildReversalBars());
        var strategy = new EmaCrossoverStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        var bullishEntries = signals.Where(s => s.Kind == "Entry" && s.Direction == "Bullish").ToList();
        Assert.Single(bullishEntries);
    }

    [Fact]
    public void Simulate_SharpReversal_ProducesABuyCallTrade()
    {
        var bars = BuildReversalBars();
        // Strike is ATM (from the crossover bar's own spot close) + 1 step (otmSteps=1) on the call
        // side - the option series only needs a real Close at whatever time the crossover fires and
        // stays open at, so a flat 50-point premium series is enough for this to resolve as a trade.
        var optionBars = bars.Select(b => new Candle(b.Time, 50, 55, 45, 50)).ToList();

        var context = Context(bars, (_, isCall) => isCall ? optionBars : Array.Empty<Candle>());
        var strategy = new EmaCrossoverStrategy();

        var trades = strategy.Simulate(context, Parameters());

        var bullishTrades = trades.Where(t => t.Direction == "Bullish").ToList();
        var trade = Assert.Single(bullishTrades);
        Assert.Equal("Buy", trade.Side);
        Assert.Equal("CE", trade.OptionType);
    }

    [Fact]
    public void EntrySignals_SlopeThresholdTooHighForTheMove_RejectsInsteadOfEntering()
    {
        var context = Context(BuildReversalBars());
        var strategy = new EmaCrossoverStrategy();

        // 50%/3-bar is an impossible slope for this (or any realistic) price series - confirms the
        // filter can actually veto a crossover that fires cleanly with the filter off.
        var signals = strategy.EntrySignals(context, Parameters(minSlopePercent: 50));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("slope"));
    }

    [Fact]
    public void EntrySignals_DirectionFilterExcludesTheOppositeSide_RejectsInsteadOfEntering()
    {
        var context = Context(BuildReversalBars());
        var strategy = new EmaCrossoverStrategy();

        // The reversal produces a Bullish crossover - "shorts only" must reject it, not silently
        // enter the wrong side. The earlier Bearish one is a short, so it must still fire normally -
        // this is a filter on the crossover's direction, not a blanket "stop taking signals" switch.
        var signals = strategy.EntrySignals(context, Parameters(direction: 2 /* shorts only */));

        Assert.Contains(signals, s => s.Kind == "Entry" && s.Direction == "Bearish");
        Assert.DoesNotContain(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish");
    }
}

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
    private static IReadOnlyList<Candle> BuildReversalBars(DateTimeOffset? start = null)
    {
        var bars = new List<Candle>();
        var time = start ?? T0;
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

    /// <summary>The exact mirror of BuildReversalBars (every price step negated around the same
    /// start) - a steady RISE 100 -> 129, then a sharp sustained DECLINE 129 -> 24. By the same EMA
    /// symmetry, this flips to Bullish early (rising) and then to Bearish at the same bar index
    /// (33) the original flips to Bullish - what a PE leg needs to CONFIRM a Bullish spot crossover
    /// (put premiums falling as calls rise).</summary>
    private static IReadOnlyList<Candle> BuildMirroredReversalBars(DateTimeOffset? start = null)
    {
        var bars = new List<Candle>();
        var time = start ?? T0;
        var price = 100m;

        for (var i = 0; i < 30; i++)
        {
            bars.Add(new Candle(time, price, price, price, price));
            time = time.AddMinutes(1);
            price += 1;
        }
        for (var i = 0; i < 15; i++)
        {
            price -= 7;
            bars.Add(new Candle(time, price, price, price, price));
            time = time.AddMinutes(1);
        }

        return bars;
    }

    private static BacktestStrategyContext Context(
        IReadOnlyList<Candle> spotBars,
        Func<decimal, bool, IReadOnlyList<Candle>>? getOptionBars = null,
        IReadOnlyList<Candle>? atmCeBars = null,
        IReadOnlyList<Candle>? atmPeBars = null) => new()
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
        AtmCeBars = atmCeBars ?? Array.Empty<Candle>(),
        AtmPeBars = atmPeBars ?? Array.Empty<Candle>(),
    };

    private static Dictionary<string, decimal> Parameters(decimal minSlopePercent = 0, decimal direction = 0, decimal signalStartMinutes = 555, decimal requireAtmConfirmation = 0) => new()
    {
        ["side"] = OptionTradeSimulator.SideBuy,
        ["otmSteps"] = 1,
        ["slPoints"] = 10,
        ["tpPoints"] = 20,
        ["fastPeriod"] = EmaCrossoverDetector.FastPeriod,
        ["slowPeriod"] = EmaCrossoverDetector.SlowPeriod,
        ["minSlopePercent"] = minSlopePercent,
        ["slopeLookbackBars"] = 3,
        ["requireAtmConfirmation"] = requireAtmConfirmation,
        ["direction"] = direction,
        ["signalStartMinutes"] = signalStartMinutes,
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

    // 08:30 IST - early enough that the reversal (bar 33, see BuildReversalBars) lands at
    // 09:03 IST, before the default 09:15 signal-start cutoff, unlike every other test in this
    // file (T0 = 09:30 IST, already past it).
    private static readonly DateTimeOffset EarlyStart = new(2026, 1, 5, 3, 0, 0, TimeSpan.Zero);

    [Fact]
    public void EntrySignals_ReversalBeforeSignalStartTime_RejectsInsteadOfEntering()
    {
        var context = Context(BuildReversalBars(EarlyStart));
        var strategy = new EmaCrossoverStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("pre-open"));
    }

    [Fact]
    public void EntrySignals_SignalStartTimeDisabled_FiresEvenBeforeDefaultCutoff()
    {
        var context = Context(BuildReversalBars(EarlyStart));
        var strategy = new EmaCrossoverStrategy();

        // 0 explicitly turns the cutoff off - the same reversal that PreDefaultCutoff rejects
        // must fire normally here.
        var signals = strategy.EntrySignals(context, Parameters(signalStartMinutes: 0));

        Assert.Contains(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
        Assert.DoesNotContain(signals, s => s.Summary.Contains("pre-open"));
    }

    [Fact]
    public void EntrySignals_AtmConfirmationRequired_CeUpAndPeDown_FiresEntry()
    {
        var bars = BuildReversalBars();
        var ceBars = BuildReversalBars(); // CE also flips Bullish at the same bar
        var peBars = BuildMirroredReversalBars(); // PE flips Bearish at the same bar - confirms
        var context = Context(bars, atmCeBars: ceBars, atmPeBars: peBars);
        var strategy = new EmaCrossoverStrategy();

        var signals = strategy.EntrySignals(context, Parameters(requireAtmConfirmation: 1));

        Assert.Contains(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
    }

    [Fact]
    public void EntrySignals_AtmConfirmationRequired_AtmDisagrees_RejectsInsteadOfEntering()
    {
        var bars = BuildReversalBars();
        var ceBars = BuildReversalBars(); // CE flips Bullish - fine on its own
        var peBars = BuildReversalBars(); // PE ALSO flips Bullish, not the required Bearish
        var context = Context(bars, atmCeBars: ceBars, atmPeBars: peBars);
        var strategy = new EmaCrossoverStrategy();

        var signals = strategy.EntrySignals(context, Parameters(requireAtmConfirmation: 1));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish" && s.Summary.Contains("ATM CE/PE did not confirm"));
    }

    [Fact]
    public void EntrySignals_AtmConfirmationRequired_NoAtmHistory_RejectsInsteadOfEntering()
    {
        var context = Context(BuildReversalBars()); // AtmCeBars/AtmPeBars default to empty
        var strategy = new EmaCrossoverStrategy();

        var signals = strategy.EntrySignals(context, Parameters(requireAtmConfirmation: 1));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("not enough ATM CE/PE history"));
    }

    [Fact]
    public void EntrySignals_AtmConfirmationOffByDefault_IgnoresMissingAtmData()
    {
        // requireAtmConfirmation defaults to off - the same reversal fires exactly as it always
        // did even with no ATM CE/PE bars supplied at all, so the new filter never disturbs an
        // existing backtest/trigger that doesn't opt into it.
        var context = Context(BuildReversalBars());
        var strategy = new EmaCrossoverStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.Contains(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
    }
}

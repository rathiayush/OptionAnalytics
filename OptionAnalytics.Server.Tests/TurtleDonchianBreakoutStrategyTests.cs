using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// Covers TurtleDonchianBreakoutStrategy's own reasoning - no signal while the channel is still
/// forming, the first close past a side fires and a later bar still past that same side does not
/// re-fire (even though the channel itself has since widened to include the breakout bar), the
/// OTHER side can still break out independently, day boundaries reset the channel, and the
/// direction/signal-start filters reject instead of silently dropping a qualifying breakout.
/// </summary>
public sealed class TurtleDonchianBreakoutStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero); // 09:30 IST

    /// <summary>20 range-forming bars (High=110/Low=100/Close=105 throughout - an unambiguous
    /// [100, 110] channel), then: closes at 120 (first Bullish breakout - the channel at this point
    /// is still the flat [100,110] one, since Donchian's own window excludes the breakout bar
    /// itself), closes at 130 (the channel has since widened to include the 120 bar, but 130 still
    /// clears the new upper bound of 120 - must NOT re-fire, same side continuing), closes at 50
    /// (clears the channel's LOWER side - independent of the Bullish one already used).</summary>
    private static IReadOnlyList<Candle> BuildRangeThenBothBreakouts(DateTimeOffset? start = null)
    {
        var bars = new List<Candle>();
        var time = start ?? T0;

        for (var i = 0; i < 20; i++)
        {
            bars.Add(new Candle(time, 105, 110, 100, 105));
            time = time.AddMinutes(1);
        }
        bars.Add(new Candle(time, 111, 120, 111, 120)); time = time.AddMinutes(1); // breakout up
        bars.Add(new Candle(time, 125, 131, 125, 130)); time = time.AddMinutes(1); // still above updated upper - no refire
        bars.Add(new Candle(time, 60, 65, 50, 50));                                // breakout down

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
        ["channelPeriod"] = 20,
        ["direction"] = direction,
        ["signalStartMinutes"] = signalStartMinutes,
    };

    [Fact]
    public void EntrySignals_WhileChannelIsStillForming_NeverFires()
    {
        var context = Context(BuildRangeThenBothBreakouts().Take(20).ToList());
        var strategy = new TurtleDonchianBreakoutStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.Empty(signals);
    }

    [Fact]
    public void EntrySignals_FirstCloseAboveChannelHigh_FiresBullishOnlyOnce()
    {
        var bars = BuildRangeThenBothBreakouts().Take(22).ToList(); // through the "still above, no refire" bar
        var context = Context(bars);
        var strategy = new TurtleDonchianBreakoutStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        var entries = signals.Where(s => s.Kind == "Entry").ToList();
        var entry = Assert.Single(entries);
        Assert.Equal("Bullish", entry.Direction);
        Assert.Equal(bars[20].Time, entry.TimeUtc);
    }

    [Fact]
    public void EntrySignals_LaterCloseBelowChannelLow_FiresBearishIndependentlyOfTheEarlierBullishBreakout()
    {
        var bars = BuildRangeThenBothBreakouts();
        var context = Context(bars);
        var strategy = new TurtleDonchianBreakoutStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        var entries = signals.Where(s => s.Kind == "Entry").ToList();
        Assert.Equal(2, entries.Count);
        Assert.Contains(entries, e => e.Direction == "Bullish");
        Assert.Contains(entries, e => e.Direction == "Bearish");
    }

    [Fact]
    public void Simulate_FirstBullishBreakout_ProducesABuyCallTrade()
    {
        var bars = BuildRangeThenBothBreakouts().Take(22).ToList();
        var optionBars = bars.Select(b => new Candle(b.Time, 50, 55, 45, 50)).ToList();
        var context = Context(bars, (_, isCall) => isCall ? optionBars : Array.Empty<Candle>());
        var strategy = new TurtleDonchianBreakoutStrategy();

        var trades = strategy.Simulate(context, Parameters());

        var trade = Assert.Single(trades);
        Assert.Equal("Bullish", trade.Direction);
        Assert.Equal("Buy", trade.Side);
        Assert.Equal("CE", trade.OptionType);
    }

    [Fact]
    public void EntrySignals_DirectionFilterExcludesTheOppositeSide_RejectsInsteadOfEntering()
    {
        var bars = BuildRangeThenBothBreakouts().Take(22).ToList();
        var context = Context(bars);
        var strategy = new TurtleDonchianBreakoutStrategy();

        var signals = strategy.EntrySignals(context, Parameters(direction: 2 /* downside only */));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish" && s.Summary.Contains("downside only"));
    }

    private static readonly DateTimeOffset EarlyStart = new(2026, 1, 5, 3, 0, 0, TimeSpan.Zero); // 08:30 IST

    [Fact]
    public void EntrySignals_BreakoutBeforeSignalStartTime_RejectsInsteadOfEntering()
    {
        var bars = BuildRangeThenBothBreakouts(EarlyStart).Take(22).ToList();
        var context = Context(bars);
        var strategy = new TurtleDonchianBreakoutStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("pre-open"));
    }

    [Fact]
    public void EntrySignals_ANewDay_GetsItsOwnFreshChannelAndCanFireAgain()
    {
        var day1 = BuildRangeThenBothBreakouts().Take(22).ToList(); // Bullish breakout only
        var day2Start = new DateTimeOffset(2026, 1, 6, 4, 0, 0, TimeSpan.Zero);
        var day2 = BuildRangeThenBothBreakouts(day2Start).Take(22).ToList();
        var bars = day1.Concat(day2).ToList();
        var context = Context(bars);
        var strategy = new TurtleDonchianBreakoutStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        var entries = signals.Where(s => s.Kind == "Entry").ToList();
        Assert.Equal(2, entries.Count);
        Assert.All(entries, e => Assert.Equal("Bullish", e.Direction));
    }
}

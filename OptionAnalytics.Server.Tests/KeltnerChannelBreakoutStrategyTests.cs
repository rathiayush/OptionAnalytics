using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// Covers KeltnerChannelBreakoutStrategy's own reasoning - no signal while the EMA/ATR are still
/// seeding, the first close past a band fires and a later bar still past it does not re-fire, the
/// OTHER side can still break out independently, day boundaries reset the channel state, and the
/// direction/signal-start filters reject instead of silently dropping a qualifying breakout.
/// </summary>
public sealed class KeltnerChannelBreakoutStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero); // 09:30 IST

    /// <summary>25 flat bars (Open=100/High=102/Low=98/Close=100 - seeds the 20-EMA centerline and
    /// 10-ATR with a small, stable range), then a sharp jump to 140 (clears the upper band), a
    /// second bar at 142 (the channel has widened since, but 142 still clears the new upper bound -
    /// must NOT re-fire), then a collapse to 20 (clears the lower band - independent of the Bullish
    /// breakout already used).</summary>
    private static IReadOnlyList<Candle> BuildRangeThenBothBreakouts(DateTimeOffset? start = null)
    {
        var bars = new List<Candle>();
        var time = start ?? T0;

        for (var i = 0; i < 25; i++)
        {
            bars.Add(new Candle(time, 100, 102, 98, 100));
            time = time.AddMinutes(1);
        }
        bars.Add(new Candle(time, 100, 140, 100, 140)); time = time.AddMinutes(1); // breakout up
        bars.Add(new Candle(time, 140, 145, 138, 142)); time = time.AddMinutes(1); // still above updated upper - no refire
        bars.Add(new Candle(time, 60, 65, 20, 20));                                // breakout down

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
        ["slPoints"] = 8,
        ["tpPoints"] = 80,
        ["emaPeriod"] = 20,
        ["atrPeriod"] = 10,
        ["multiplier"] = 2,
        ["direction"] = direction,
        ["signalStartMinutes"] = signalStartMinutes,
    };

    [Fact]
    public void EntrySignals_WhileChannelIsStillSeeding_NeverFires()
    {
        var context = Context(BuildRangeThenBothBreakouts().Take(25).ToList());
        var strategy = new KeltnerChannelBreakoutStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.Empty(signals);
    }

    [Fact]
    public void EntrySignals_FirstCloseAboveUpperBand_FiresBullishOnlyOnce()
    {
        var bars = BuildRangeThenBothBreakouts().Take(27).ToList(); // through the "still above, no refire" bar
        var context = Context(bars);
        var strategy = new KeltnerChannelBreakoutStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        var entries = signals.Where(s => s.Kind == "Entry").ToList();
        var entry = Assert.Single(entries);
        Assert.Equal("Bullish", entry.Direction);
        Assert.Equal(bars[25].Time, entry.TimeUtc);
    }

    [Fact]
    public void EntrySignals_LaterCloseBelowLowerBand_FiresBearishIndependentlyOfTheEarlierBullishBreakout()
    {
        var bars = BuildRangeThenBothBreakouts();
        var context = Context(bars);
        var strategy = new KeltnerChannelBreakoutStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        var entries = signals.Where(s => s.Kind == "Entry").ToList();
        Assert.Equal(2, entries.Count);
        Assert.Contains(entries, e => e.Direction == "Bullish");
        Assert.Contains(entries, e => e.Direction == "Bearish");
    }

    [Fact]
    public void Simulate_FirstBullishBreakout_ProducesABuyCallTrade()
    {
        var bars = BuildRangeThenBothBreakouts().Take(27).ToList();
        var optionBars = bars.Select(b => new Candle(b.Time, 50, 55, 45, 50)).ToList();
        var context = Context(bars, (_, isCall) => isCall ? optionBars : Array.Empty<Candle>());
        var strategy = new KeltnerChannelBreakoutStrategy();

        var trades = strategy.Simulate(context, Parameters());

        var trade = Assert.Single(trades);
        Assert.Equal("Bullish", trade.Direction);
        Assert.Equal("Buy", trade.Side);
        Assert.Equal("CE", trade.OptionType);
    }

    [Fact]
    public void EntrySignals_DirectionFilterExcludesTheOppositeSide_RejectsInsteadOfEntering()
    {
        var bars = BuildRangeThenBothBreakouts().Take(27).ToList();
        var context = Context(bars);
        var strategy = new KeltnerChannelBreakoutStrategy();

        var signals = strategy.EntrySignals(context, Parameters(direction: 2 /* downside only */));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish" && s.Summary.Contains("downside only"));
    }

    private static readonly DateTimeOffset EarlyStart = new(2026, 1, 5, 3, 0, 0, TimeSpan.Zero); // 08:30 IST

    [Fact]
    public void EntrySignals_BreakoutBeforeSignalStartTime_RejectsInsteadOfEntering()
    {
        var bars = BuildRangeThenBothBreakouts(EarlyStart).Take(27).ToList();
        var context = Context(bars);
        var strategy = new KeltnerChannelBreakoutStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("pre-open"));
    }

    [Fact]
    public void EntrySignals_ANewDay_GetsItsOwnFreshChannelAndCanFireAgain()
    {
        var day1 = BuildRangeThenBothBreakouts().Take(27).ToList(); // Bullish breakout only
        var day2Start = new DateTimeOffset(2026, 1, 6, 4, 0, 0, TimeSpan.Zero);
        var day2 = BuildRangeThenBothBreakouts(day2Start).Take(27).ToList();
        var bars = day1.Concat(day2).ToList();
        var context = Context(bars);
        var strategy = new KeltnerChannelBreakoutStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        var entries = signals.Where(s => s.Kind == "Entry").ToList();
        Assert.Equal(2, entries.Count);
        Assert.All(entries, e => Assert.Equal("Bullish", e.Direction));
    }
}

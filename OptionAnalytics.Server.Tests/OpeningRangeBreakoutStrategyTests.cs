using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// Covers OpeningRangeBreakoutStrategy's own reasoning - no signal while the range is still forming,
/// the first close past a side fires and later bars still past that same side do not re-fire, the
/// OTHER side can still break out independently the same day, a new day gets its own fresh range,
/// and the direction filter rejects instead of silently dropping a qualifying breakout.
/// </summary>
public sealed class OpeningRangeBreakoutStrategyTests
{
    // 09:15 IST exactly - the default signalStartMinutes (555) and this strategy's own session
    // open, so the opening range starts on the very first bar.
    private static readonly DateTimeOffset SessionOpen = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero);

    /// <summary>15 range-forming bars (09:15-09:29 IST, High=110/Low=100/Close=105 throughout - an
    /// unambiguous [100, 110] opening range), then: 09:30 closes at 115 (first Bullish breakout),
    /// 09:31 closes at 120 (still above the range - must NOT re-fire), 09:32 closes at 50 (first
    /// Bearish breakout - the range's OTHER side, independent of the Bullish one already used),
    /// 09:33 closes at 40 (still below - must NOT re-fire either).</summary>
    private static IReadOnlyList<Candle> BuildRangeThenBothBreakouts(DateTimeOffset? start = null)
    {
        var bars = new List<Candle>();
        var time = start ?? SessionOpen;

        for (var i = 0; i < 15; i++)
        {
            bars.Add(new Candle(time, 105, 110, 100, 105));
            time = time.AddMinutes(1);
        }
        bars.Add(new Candle(time, 111, 115, 111, 115)); time = time.AddMinutes(1); // 09:30 - Bullish breakout
        bars.Add(new Candle(time, 116, 120, 116, 120)); time = time.AddMinutes(1); // 09:31 - still above, no re-fire
        bars.Add(new Candle(time, 60, 60, 50, 50)); time = time.AddMinutes(1);     // 09:32 - Bearish breakout
        bars.Add(new Candle(time, 45, 45, 40, 40));                                // 09:33 - still below, no re-fire

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
        ["openingRangeMinutes"] = 15,
        ["direction"] = direction,
        ["signalStartMinutes"] = signalStartMinutes,
    };

    [Fact]
    public void EntrySignals_WhileRangeIsStillForming_NeverFires()
    {
        // Just the 15 range-forming bars - there is no completed range yet to have broken out of.
        var context = Context(BuildRangeThenBothBreakouts().Take(15).ToList());
        var strategy = new OpeningRangeBreakoutStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.Empty(signals);
    }

    [Fact]
    public void EntrySignals_FirstCloseAboveRangeHigh_FiresBullishOnlyOnce()
    {
        var bars = BuildRangeThenBothBreakouts().Take(17).ToList(); // through 09:31 (still above, no re-fire)
        var context = Context(bars);
        var strategy = new OpeningRangeBreakoutStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        var entries = signals.Where(s => s.Kind == "Entry").ToList();
        var entry = Assert.Single(entries);
        Assert.Equal("Bullish", entry.Direction);
        Assert.Equal(bars[15].Time, entry.TimeUtc); // fires on the FIRST breakout bar (09:30), not 09:31
    }

    [Fact]
    public void EntrySignals_LaterCloseBelowRangeLow_FiresBearishIndependentlyOfTheEarlierBullishBreakout()
    {
        var bars = BuildRangeThenBothBreakouts(); // all 19 bars - both breakouts
        var context = Context(bars);
        var strategy = new OpeningRangeBreakoutStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        var entries = signals.Where(s => s.Kind == "Entry").ToList();
        Assert.Equal(2, entries.Count);
        Assert.Contains(entries, e => e.Direction == "Bullish");
        Assert.Contains(entries, e => e.Direction == "Bearish");
    }

    [Fact]
    public void Simulate_FirstBullishBreakout_ProducesABuyCallTrade()
    {
        var bars = BuildRangeThenBothBreakouts().Take(17).ToList();
        var optionBars = bars.Select(b => new Candle(b.Time, 50, 55, 45, 50)).ToList();
        var context = Context(bars, (_, isCall) => isCall ? optionBars : Array.Empty<Candle>());
        var strategy = new OpeningRangeBreakoutStrategy();

        var trades = strategy.Simulate(context, Parameters());

        var trade = Assert.Single(trades);
        Assert.Equal("Bullish", trade.Direction);
        Assert.Equal("Buy", trade.Side);
        Assert.Equal("CE", trade.OptionType);
    }

    [Fact]
    public void EntrySignals_DirectionFilterExcludesTheOppositeSide_RejectsInsteadOfEntering()
    {
        var bars = BuildRangeThenBothBreakouts().Take(17).ToList();
        var context = Context(bars);
        var strategy = new OpeningRangeBreakoutStrategy();

        var signals = strategy.EntrySignals(context, Parameters(direction: 2 /* downside only */));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish" && s.Summary.Contains("downside only"));
    }

    [Fact]
    public void EntrySignals_ANewDay_GetsItsOwnFreshRangeAndCanFireAgain()
    {
        // Two independent trading days, each with the exact same range-then-breakout shape - the
        // second day's breakout must fire even though the first day left brokeUp/brokeDown both
        // set, since nothing about the range or which sides already broke out should carry
        // overnight.
        var day1 = BuildRangeThenBothBreakouts().Take(17).ToList(); // Bullish breakout only
        var day2Start = new DateTimeOffset(2026, 1, 6, 3, 45, 0, TimeSpan.Zero);
        var day2 = BuildRangeThenBothBreakouts(day2Start).Take(17).ToList();
        var bars = day1.Concat(day2).ToList();
        var context = Context(bars);
        var strategy = new OpeningRangeBreakoutStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        var entries = signals.Where(s => s.Kind == "Entry").ToList();
        Assert.Equal(2, entries.Count);
        Assert.All(entries, e => Assert.Equal("Bullish", e.Direction));
    }
}

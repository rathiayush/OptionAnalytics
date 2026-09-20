using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers SweepIfvgTrendlineBreakStrategy's entry rule: a liquidity sweep that also
/// inverts a prior fair-value gap at the same bar, a break of a trendline through the last two
/// confirmed swing highs/lows found before that bar, and an entry on the later retrace into the
/// inverted gap. Fixtures use one 1-minute bar per hourly bucket, each spaced 60 minutes apart in
/// wall-clock UTC time, so BacktestUtil.AggregateCandles's own hourly aggregation reproduces each
/// one exactly - the same technique DailyBiasSweepFvgStrategyTests uses, including its own trailing
/// filler bar to stop the final real bar from being dropped as an "incomplete" bucket.</summary>
public sealed class SweepIfvgTrendlineBreakStrategyTests
{
    private static readonly DateOnly Day = new(2026, 1, 12);

    private static Candle HourBar(int utcHour, decimal open, decimal high, decimal low, decimal close) =>
        new(new DateTimeOffset(Day.Year, Day.Month, Day.Day, utcHour, 0, 0, TimeSpan.Zero), open, high, low, close);

    /// <summary>Bars 1 and 3 are confirmed swing highs (110 then 105 - a declining resistance
    /// line); bar 6 sweeps below the bars[4]/bars[5] channel low, and its own close (98) already
    /// closes back above the bearish gap left by bars[3]/bars[5] (High 95, Low 88) - sweep and
    /// inversion confirmed together. Bar 7 closes above the declining trendline (projected 95 at
    /// index 7); bar 8 retraces into the inverted gap and is where the entry fires. Bar 9 is a
    /// trailing filler only.</summary>
    private static List<Candle> BullishSetup() => new()
    {
        HourBar(0, 100, 100, 95, 98),
        HourBar(1, 98, 110, 96, 105),  // swing high candidate (110)
        HourBar(2, 105, 95, 90, 92),   // confirms bar 1 as a swing high
        HourBar(3, 92, 105, 95, 100),  // swing high candidate (105) - declining from 110
        HourBar(4, 100, 90, 85, 95),   // confirms bar 3 as a swing high; channel contributor
        HourBar(5, 95, 88, 80, 85),    // channel contributor; gap's third candle vs bar 3
        HourBar(6, 80, 100, 65, 98),   // sweep (Low 65 <= 80-10) + inversion (Close 98 > gap High 95)
        HourBar(7, 98, 110, 96, 108),  // trendline break (Close 108 > projected 95)
        HourBar(8, 108, 108, 90, 100), // retrace (Low 90 <= gap High 95) - entry here
        HourBar(9, 100, 100, 100, 100), // trailing filler
    };

    /// <summary>Exact mirror (200-value) of BullishSetup - every high/low relationship flips, so
    /// this must read as a bearish sweep+inversion+trendline-break+retrace instead.</summary>
    private static List<Candle> BearishSetup() => new()
    {
        HourBar(0, 100, 105, 100, 102),
        HourBar(1, 102, 104, 90, 95),
        HourBar(2, 95, 110, 105, 108),
        HourBar(3, 108, 105, 95, 100),
        HourBar(4, 100, 115, 110, 105),
        HourBar(5, 105, 120, 112, 115),
        HourBar(6, 120, 135, 100, 102),
        HourBar(7, 102, 104, 90, 92),
        HourBar(8, 92, 110, 92, 100),
        HourBar(9, 100, 100, 100, 100),
    };

    private static BacktestStrategyContext Context(IReadOnlyList<Candle> oneMinBars) => new()
    {
        Underlying = "NIFTY",
        TimeframeMinutes = 1,
        Step = 50,
        SpotBars = oneMinBars,
        SpotBarsOneMinute = oneMinBars,
        SpotVolumeBarsOneMinute = Array.Empty<CandleWithVolume>(),
        ConfluenceSignalsAscending = Array.Empty<BacktestSignal>(),
        AllSignals = Array.Empty<BacktestSignal>(),
        ObvCeSeries = Array.Empty<ObvPoint>(),
        ObvPeSeries = Array.Empty<ObvPoint>(),
        CdvCeSeries = Array.Empty<ObvPoint>(),
        CdvPeSeries = Array.Empty<ObvPoint>(),
        GetOptionBars = (_, _) => Array.Empty<Candle>(),
        GetOptionBarsOneMinute = (_, _) => Array.Empty<Candle>(),
        AtmCeBars = Array.Empty<Candle>(),
        AtmPeBars = Array.Empty<Candle>(),
        AtmCeVolumeBars = Array.Empty<CandleWithVolume>(),
        AtmPeVolumeBars = Array.Empty<CandleWithVolume>(),
        AtmStrike = null,
    };

    private static Dictionary<string, decimal> Parameters(Action<Dictionary<string, decimal>>? overrides = null)
    {
        var p = new Dictionary<string, decimal>
        {
            ["side"] = OptionTradeSimulator.SideBuy,
            ["otmSteps"] = 1,
            ["squareOffMinutes"] = 0,
            ["signalStartMinutes"] = 0,
            ["excludeLastDays"] = 0,
            ["maxHoldingBars"] = 0,
            ["direction"] = 0,
            ["sweepLookbackBars"] = 2,
            ["sweepBufferPoints"] = 10,
            ["ifvgLookbackBars"] = 2,
            ["trendlineLookaheadBars"] = 10,
            ["retraceLookaheadBars"] = 5,
            ["stopBufferPoints"] = 5,
            ["riskRewardMultiple"] = 3,
        };
        overrides?.Invoke(p);
        return p;
    }

    [Fact]
    public void NoSignal_WhenNoSweepEverHappens()
    {
        var bars = Enumerable.Range(0, 5).Select(h => HourBar(h, 100, 100, 100, 100)).ToList();

        var signals = new SweepIfvgTrendlineBreakStrategy().EntrySignals(Context(bars), Parameters());

        Assert.Empty(signals);
    }

    [Fact]
    public void BullishEntry_FiresOnTheRetraceIntoTheInvertedGap()
    {
        var signals = new SweepIfvgTrendlineBreakStrategy().EntrySignals(Context(BullishSetup()), Parameters());

        var signal = Assert.Single(signals);
        Assert.Equal("Entry", signal.Kind);
        Assert.Equal("Bullish", signal.Direction);
        Assert.Contains("FVG [88-95]", signal.Summary);
        Assert.Contains("stop 83", signal.Summary); // gap Low 88 - stopBufferPoints 5
        Assert.Contains("target 151", signal.Summary); // entry 100, risk 17, 1:3 -> 100 + 51
    }

    [Fact]
    public void BearishEntry_FiresOnTheRetraceIntoTheInvertedGap_Mirror()
    {
        var signals = new SweepIfvgTrendlineBreakStrategy().EntrySignals(Context(BearishSetup()), Parameters());

        var signal = Assert.Single(signals);
        Assert.Equal("Entry", signal.Kind);
        Assert.Equal("Bearish", signal.Direction);
    }

    [Fact]
    public void DirectionFilter_SkipsBullishEntryWhenBearishOnly()
    {
        var signals = new SweepIfvgTrendlineBreakStrategy().EntrySignals(Context(BullishSetup()), Parameters(p => p["direction"] = 2)); // bearish only

        var signal = Assert.Single(signals);
        Assert.Equal("Rejected", signal.Kind);
        Assert.Contains("bearish only", signal.Summary);
    }

    [Fact]
    public void NoEntry_WhenTheInvertedGapIsInvalidatedBeforeAnyRetrace()
    {
        var bars = BullishSetup();
        // Replace bar 8 (the retrace) with a bar that closes BELOW the gap's own Low (88) instead -
        // the inverted gap is broken before it was ever retraced into.
        bars[8] = HourBar(8, 108, 108, 70, 80);

        var signals = new SweepIfvgTrendlineBreakStrategy().EntrySignals(Context(bars), Parameters());

        Assert.Empty(signals);
    }
}

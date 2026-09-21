using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers DailyBiasSweepFvgStrategy's entry rule: daily HH/HL vs LL/LH structure sets the
/// session's bias, then on the 1-hour chart a liquidity sweep against that bias followed by a
/// fair-value gap, entering on the later retrace into the gap.
///
/// Fixtures use one 1-minute bar per day for the seven days that only exist to build daily swing
/// structure (BuildDailyBars reads a day's own High/Low from whatever bars fall on it - a single
/// bar is enough), then five 1-minute bars for the trading day itself, each spaced exactly 60
/// minutes apart in wall-clock time so BacktestUtil.AggregateCandles's own hourly aggregation turns
/// each one into exactly one hourly bar with that same bar's own OHLC - the simplest way to control
/// the resulting hourly series precisely without needing true minute-by-minute granularity.</summary>
public sealed class DailyBiasSweepFvgStrategyTests
{
    private static Candle DailyMarker(DateOnly day, decimal high, decimal low) =>
        new(IstClock.AtIstTime(day, 555), (high + low) / 2, high, low, (high + low) / 2);

    // UTC-hour-aligned so each becomes its own clean hourly bar - see this class's own doc comment.
    private static Candle HourBar(DateOnly day, int utcHour, decimal open, decimal high, decimal low, decimal close) =>
        new(new DateTimeOffset(day.Year, day.Month, day.Day, utcHour, 0, 0, TimeSpan.Zero), open, high, low, close);

    private static readonly DateOnly Day1 = new(2026, 1, 5);
    private static readonly DateOnly Day2 = new(2026, 1, 6);
    private static readonly DateOnly Day3 = new(2026, 1, 7);
    private static readonly DateOnly Day4 = new(2026, 1, 8);
    private static readonly DateOnly Day5 = new(2026, 1, 9);
    private static readonly DateOnly Day6 = new(2026, 1, 10);
    private static readonly DateOnly Day7 = new(2026, 1, 11);
    private static readonly DateOnly Today = new(2026, 1, 12);

    /// <summary>Days 1-7 built so Today reads a BULLISH bias: confirmed swing highs 95 (Day2) then
    /// 120 (Day5) - rising (HH); confirmed swing lows 80 (Day2) then 85 (Day4) - rising (HL). See
    /// this class's own worked-out table in the PR description for the neighbor-by-neighbor check.</summary>
    private static List<Candle> BullishBiasDailyHistory() => new()
    {
        DailyMarker(Day1, 100, 95),
        DailyMarker(Day2, 95, 80),   // swing low (80 < Day1's 95, < Day3's 90)
        DailyMarker(Day3, 110, 90),  // swing high (110 > Day2's 95, > Day4's 100)
        DailyMarker(Day4, 100, 85),  // swing low (85 < Day3's 90, < Day5's 95) - RISING from 80: HL
        DailyMarker(Day5, 120, 95),  // swing high (120 > Day4's 100, > Day6's 105) - RISING from 110: HH
        DailyMarker(Day6, 105, 100),
        DailyMarker(Day7, 100, 95),
    };

    /// <summary>Exact mirror of the bullish history (each OHLC value replaced by 200-value), which
    /// swaps every high/low relationship and so must read as BEARISH: confirmed swing highs falling
    /// 120 -> 115 (LH), confirmed swing lows falling 90 -> 80 (LL).</summary>
    private static List<Candle> BearishBiasDailyHistory() => new()
    {
        DailyMarker(Day1, 105, 100),
        DailyMarker(Day2, 120, 105),
        DailyMarker(Day3, 110, 90),
        DailyMarker(Day4, 115, 100),
        DailyMarker(Day5, 105, 80),
        DailyMarker(Day6, 100, 95),
        DailyMarker(Day7, 105, 100),
    };

    /// <summary>Sweeps below a recent low (h0/h1's own 100) then reverses, leaves a bullish FVG
    /// between h1's High (110) and h3's Low (115), and h4 retraces back into it. The trailing h5 bar
    /// exists only so BacktestUtil.AggregateCandles doesn't drop h4 as an "incomplete" trailing
    /// bucket (see its own doc comment) - h5 itself is never read.</summary>
    private static List<Candle> BullishSweepFvgSession(DateOnly day) => new()
    {
        HourBar(day, 4, 102, 105, 100, 103),  // 09:30 IST - channel bar 1
        HourBar(day, 5, 103, 110, 103, 108),  // 10:30 IST - channel bar 2 (recentHigh 110, recentLow 100)
        HourBar(day, 6, 100, 105, 85, 102),   // 11:30 IST - sweep: Low 85 <= 100-10, Close 102 > 100
        HourBar(day, 7, 112, 125, 115, 120),  // 12:30 IST - gap: h1.High(110) < h3.Low(115)
        HourBar(day, 8, 118, 120, 112, 118),  // 13:30 IST - retrace: Low 112 <= gap High 115
        HourBar(day, 9, 118, 118, 118, 118),  // trailing filler - keeps h4 from being dropped
    };

    /// <summary>Exact mirror (200-value) of the bullish session - sweeps above a recent high, leaves
    /// a bearish FVG, retraces back down into it.</summary>
    private static List<Candle> BearishSweepFvgSession(DateOnly day) => new()
    {
        HourBar(day, 4, 98, 100, 95, 97),
        HourBar(day, 5, 97, 97, 90, 92),
        HourBar(day, 6, 100, 115, 95, 98),
        HourBar(day, 7, 88, 85, 75, 80),
        HourBar(day, 8, 82, 88, 80, 82),
        HourBar(day, 9, 82, 82, 82, 82), // trailing filler - see the bullish session's own comment
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
        CeOiIvBand = Array.Empty<OiIvPoint>(),
        PeOiIvBand = Array.Empty<OiIvPoint>(),
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
            ["fvgLookaheadBars"] = 1,
            ["retraceLookaheadBars"] = 1,
            ["stopBufferPoints"] = 5,
            ["riskRewardMultiple"] = 3,
        };
        overrides?.Invoke(p);
        return p;
    }

    [Fact]
    public void NoTrade_WhenThereIsNotEnoughDailyHistoryToJudgeAnyBias()
    {
        var bars = new List<Candle> { DailyMarker(Day1, 100, 95) };
        bars.AddRange(BullishSweepFvgSession(Today));

        var signals = new DailyBiasSweepFvgStrategy().EntrySignals(Context(bars), Parameters());

        Assert.Empty(signals);
    }

    [Fact]
    public void BullishBias_EntersOnTheSweepThenFvgRetrace()
    {
        var bars = BullishBiasDailyHistory();
        bars.AddRange(BullishSweepFvgSession(Today));

        var signals = new DailyBiasSweepFvgStrategy().EntrySignals(Context(bars), Parameters());

        var signal = Assert.Single(signals);
        Assert.Equal("Entry", signal.Kind);
        Assert.Equal("Bullish", signal.Direction);
        Assert.Contains("Swept 85", signal.Summary);
        Assert.Contains("FVG [110-115]", signal.Summary);
    }

    // The real bug this exists to catch: an earlier version reset the sweep channel (and any
    // pending sweep/FVG) at every calendar-day boundary, so it only ever started scanning a day
    // once that SAME day had MORE than sweepLookbackBars hourly bars - never true for a real
    // ~6-7-bar trading day at the DEFAULT sweepLookbackBars (20) or anything close to it. This adds
    // 20 flat filler hourly bars on Day7 (the day right before Today - safe to widen since Day7 was
    // never itself a swing point in BullishBiasDailyHistory's own confirmed HH/HL sequence) ahead of
    // the session, then runs with the real default sweepLookbackBars - only correct if the channel
    // is allowed to look back ACROSS that day boundary. The filler's own flat value (105) sits
    // between the session's own recentLow(100)/recentHigh(110), so it changes nothing about which
    // bars the channel picks up - same sweep/gap/retrace, same expected values as the test above.
    [Fact]
    public void BullishBias_StillFires_WhenSweepLookbackBarsExceedsASingleDaysOwnBarCount()
    {
        var bars = BullishBiasDailyHistory();
        bars.AddRange(Enumerable.Range(0, 20).Select(h => HourBar(Day7, h, 105, 105, 105, 105)));
        bars.AddRange(BullishSweepFvgSession(Today));

        var signals = new DailyBiasSweepFvgStrategy().EntrySignals(Context(bars), Parameters(p =>
        {
            p["sweepLookbackBars"] = 20; // the real, documented default - not the test suite's own tiny 2
            p["fvgLookaheadBars"] = 1;
            p["retraceLookaheadBars"] = 1;
        }));

        var signal = Assert.Single(signals);
        Assert.Equal("Entry", signal.Kind);
        Assert.Equal("Bullish", signal.Direction);
        Assert.Contains("Swept 85", signal.Summary);
        Assert.Contains("FVG [110-115]", signal.Summary);
    }

    [Fact]
    public void BearishBias_EntersOnTheSweepThenFvgRetrace_Mirror()
    {
        var bars = BearishBiasDailyHistory();
        bars.AddRange(BearishSweepFvgSession(Today));

        var signals = new DailyBiasSweepFvgStrategy().EntrySignals(Context(bars), Parameters());

        var signal = Assert.Single(signals);
        Assert.Equal("Entry", signal.Kind);
        Assert.Equal("Bearish", signal.Direction);
    }

    [Fact]
    public void DirectionFilter_SkipsBullishEntryWhenBearishOnly()
    {
        var bars = BullishBiasDailyHistory();
        bars.AddRange(BullishSweepFvgSession(Today));

        var signals = new DailyBiasSweepFvgStrategy().EntrySignals(Context(bars), Parameters(p => p["direction"] = 2)); // bearish only

        var signal = Assert.Single(signals);
        Assert.Equal("Rejected", signal.Kind);
        Assert.Contains("bearish only", signal.Summary);
    }

    [Fact]
    public void NoTrade_WhenTheBiasSideDoesNotMatchTheSweepSetup()
    {
        // A bullish-bias day's own structure never presents a BEARISH sweep setup (RunSession only
        // even looks for a sweep on the bias's own side), so wiring the bearish sweep session onto a
        // bullish-bias day's history produces nothing.
        var bars = BullishBiasDailyHistory();
        bars.AddRange(BearishSweepFvgSession(Today));

        var signals = new DailyBiasSweepFvgStrategy().EntrySignals(Context(bars), Parameters());

        Assert.Empty(signals);
    }
}

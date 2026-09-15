using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers SrFlowSellStrategy's entry rule: a rolling 30-minute support/resistance channel
/// (built here from a single fully-closed prior 30-min bar via srLookbackBars=1, to keep fixtures
/// small), a wick-rejection of that level firing immediately, and a decisive close through it
/// starting a pending breakout that a later retest resolves - continuing with the breakout if OBV
/// is both rising and ACCELERATING on the winning leg over the retest, reversing as a fakeout if
/// not. All fixtures use 1-minute bars as both SpotBars and SpotBarsOneMinute (TimeframeMinutes=1),
/// and flowMode=ObvOnly so only ObvCeSeries/ObvPeSeries need populating.</summary>
public sealed class SrFlowSellStrategyTests
{
    // 09:00 IST - deliberately NOT 09:15 (NSE's real session start): BacktestUtil.AggregateCandles
    // buckets a 30-minute timeframe by absolute epoch (equivalently, IST clock :00/:30 boundaries -
    // IST's own UTC+5:30 offset is itself a whole number of 30-minute buckets, so the two line up),
    // not by session-relative time, so a fixture anchored at the real 09:15 open would straddle two
    // buckets instead of forming one clean one. This is an existing characteristic of the shared
    // helper (also true for every other strategy's own 30-minute aggregation), not something this
    // test fixture works around dishonestly - only the epoch alignment matters here, not what real
    // wall-clock session time it happens to be.
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 30, 0, TimeSpan.Zero);

    private static Candle Bar(int index, decimal open, decimal high, decimal low, decimal close) =>
        new(T0.AddMinutes(index), open, high, low, close);

    // Bars 0..29 - exactly one clean 30-min bucket, closing at bar index 30's own time, with
    // resistance 105 / support 95 (High/Low of every bar in it).
    private static List<Candle> FirstBucket() =>
        Enumerable.Range(0, 30).Select(i => Bar(i, 100, 105, 95, 100)).ToList();

    private static BacktestStrategyContext Context(IReadOnlyList<Candle> spotBars, IReadOnlyList<ObvPoint>? obvCe = null) => new()
    {
        Underlying = "NIFTY",
        TimeframeMinutes = 1,
        Step = 50,
        SpotBars = spotBars,
        SpotBarsOneMinute = spotBars,
        SpotVolumeBarsOneMinute = Array.Empty<CandleWithVolume>(),
        ConfluenceSignalsAscending = Array.Empty<BacktestSignal>(),
        AllSignals = Array.Empty<BacktestSignal>(),
        ObvCeSeries = obvCe ?? Array.Empty<ObvPoint>(),
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

    private static Dictionary<string, decimal> Parameters() => new()
    {
        ["side"] = OptionTradeSimulator.SideSell,
        ["otmSteps"] = 2,
        ["slPoints"] = 10,
        ["tpPoints"] = 20,
        ["squareOffMinutes"] = 0,
        ["signalStartMinutes"] = 0, // disabled - keeps these fixtures independent of wall-clock IST
        ["excludeLastDays"] = 0,
        ["direction"] = 0, // both sides
        ["srLookbackBars"] = 1,
        ["levelBreakBufferPoints"] = 2,
        ["retestTolerancePoints"] = 2,
        ["maxRetestBars"] = 5,
        ["flowLookbackBars"] = 4,
        ["flowMode"] = 0, // OBV only
    };

    [Fact]
    public void NoSignal_BeforeTheSrChannelHasEnoughClosedHistory()
    {
        var bars = FirstBucket(); // the bucket itself never closes within this fixture (no bar 30)

        var signals = new SrFlowSellStrategy().EntrySignals(Context(bars), Parameters());

        Assert.Empty(signals);
    }

    [Fact]
    public void Rejection_AtResistance_FiresBearishImmediately_NoRetestNeeded()
    {
        var bars = FirstBucket();
        // Wicks to 108 (>= resistance 105) but closes back at 102 (<= 105 - 2 buffer).
        bars.Add(Bar(30, 105, 108, 101, 102));

        var signals = new SrFlowSellStrategy().EntrySignals(Context(bars), Parameters());

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal("Bearish", entry.Direction);
        Assert.StartsWith("Rejection:", entry.Summary);
        Assert.Equal(bars[30].Time, entry.TimeUtc);
    }

    [Fact]
    public void Rejection_AtSupport_FiresBullishImmediately()
    {
        var bars = FirstBucket();
        // Wicks to 92 (<= support 95) but closes back at 97 (>= 95 + 2 buffer).
        bars.Add(Bar(30, 95, 99, 92, 97));

        var signals = new SrFlowSellStrategy().EntrySignals(Context(bars), Parameters());

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal("Bullish", entry.Direction);
        Assert.StartsWith("Rejection:", entry.Summary);
    }

    [Fact]
    public void Breakout_ConfirmedByRisingAcceleratingObv_ContinuesInTheBreakoutDirection()
    {
        var bars = FirstBucket();
        bars.Add(Bar(30, 106, 112, 105, 110)); // decisive close above 105 + 2 -> pending Bullish breakout
        bars.Add(Bar(31, 110, 110, 106, 108)); // retest: Low 106 <= 105 + 2

        // CE OBV over the 4-bar lookback ending at the retest bar (27..31): rise 100->103 in the
        // first half, then 103->120 in the second - accelerating.
        var ce = new[]
        {
            new ObvPoint(T0.AddMinutes(27), 100),
            new ObvPoint(T0.AddMinutes(28), 101),
            new ObvPoint(T0.AddMinutes(29), 103),
            new ObvPoint(T0.AddMinutes(30), 108),
            new ObvPoint(T0.AddMinutes(31), 120),
        };

        var signals = new SrFlowSellStrategy().EntrySignals(Context(bars, ce), Parameters());

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal("Bullish", entry.Direction);
        Assert.StartsWith("Breakout:", entry.Summary);
        Assert.Equal(bars[31].Time, entry.TimeUtc);
    }

    [Fact]
    public void Breakout_NotAccelerating_FiresFakeoutReversalInstead()
    {
        var bars = FirstBucket();
        bars.Add(Bar(30, 106, 112, 105, 110)); // same breakout as above
        bars.Add(Bar(31, 110, 110, 106, 108)); // same retest as above

        // Same CE OBV rise overall (100 -> 111) but SLOWING, not accelerating: +8 in the first half,
        // only +3 in the second.
        var ce = new[]
        {
            new ObvPoint(T0.AddMinutes(27), 100),
            new ObvPoint(T0.AddMinutes(28), 104),
            new ObvPoint(T0.AddMinutes(29), 108),
            new ObvPoint(T0.AddMinutes(30), 110),
            new ObvPoint(T0.AddMinutes(31), 111),
        };

        var signals = new SrFlowSellStrategy().EntrySignals(Context(bars, ce), Parameters());

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal("Bearish", entry.Direction); // reverses back into the range
        Assert.StartsWith("Fakeout:", entry.Summary);
        Assert.Equal(bars[31].Time, entry.TimeUtc);
    }

    [Fact]
    public void PendingBreakout_ExpiresWithNoSignal_WhenPriceNeverComesBackToRetest()
    {
        var bars = FirstBucket();
        bars.Add(Bar(30, 106, 112, 105, 110)); // decisive close -> pending Bullish breakout
        // 6 more bars (i - 30 reaches 6, past maxRetestBars=5), Low always well clear of a retest
        // (needs to be <= 107 to count - these all stay at 108+).
        for (var i = 31; i <= 36; i++) bars.Add(Bar(i, 110, 112, 108, 110));

        var signals = new SrFlowSellStrategy().EntrySignals(Context(bars), Parameters());

        Assert.Empty(signals);
    }

    [Fact]
    public void DirectionFilter_BearishOnly_RejectsAWouldBeBullishRejectionEntry()
    {
        var bars = FirstBucket();
        bars.Add(Bar(30, 95, 99, 92, 97)); // the same support rejection as its own dedicated test

        var parameters = Parameters();
        parameters["direction"] = 2; // bearish only

        var signals = new SrFlowSellStrategy().EntrySignals(Context(bars), parameters);

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish" && s.Summary.Contains("bearish only"));
    }
}

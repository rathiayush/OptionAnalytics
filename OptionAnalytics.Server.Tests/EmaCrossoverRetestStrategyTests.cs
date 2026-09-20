using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers EmaCrossoverRetestStrategy's entry rule against real EmaCrossoverDetector EMA
/// math (fastEmaPeriod=3, slowEmaPeriod=5 here, purely to keep fixtures short - the same math runs
/// at the real 20/50 default). Bar values were derived by first running the real EMA series
/// (EmaCrossoverDetector.EmaSeries/DirectionSeries) against a candidate fixture and reading off the
/// actual numbers, not by hand-deriving the EMA formula - the comments below record what that run
/// showed, not an independent prediction.
///
/// Shared fixture, both directions: 6 flat seed bars, then a steady ramp (each bar's own Low/High
/// pinned close to its OWN Close, never the prior bar's, so nothing dips down to the still-catching-
/// up fast EMA by accident) that confirms the crossover on the very first ramp bar, then two
/// deliberate deep-wick-but-held bars that each count as one retest. The bearish fixture is this
/// same series reflected through 350 (EMA is a linear filter, so C - EmaSeries(x) == EmaSeries(C -
/// x) exactly - confirmed by running both series and comparing) - not an independent construction,
/// so it exercises the exact same code path with the signs flipped.</summary>
public sealed class EmaCrossoverRetestStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero);

    private static Candle Bar(int index, decimal open, decimal high, decimal low, decimal close) =>
        new(T0.AddMinutes(index), open, high, low, close);

    // Confirms Bullish on bar 6 (fast 105 > slow 103.33, close 110 above both); bar 11 is retest #1
    // (Low 130 dips under fast 144.16, Close 148 back above it); bar 12 is a clean ramp bar (High
    // 158.5 stays under... no dip, no retest); bar 13 is retest #2 (Low 135 under fast 153.54,
    // Close 156 back above it) - the entry bar.
    private static List<Candle> BullishFixture()
    {
        var bars = new List<Candle>();
        for (var i = 0; i < 6; i++) bars.Add(Bar(i, 100, 100, 100, 100));
        bars.Add(Bar(6, 100, 110.5m, 109.5m, 110));
        bars.Add(Bar(7, 110, 120.5m, 119.5m, 120));
        bars.Add(Bar(8, 120, 130.5m, 129.5m, 130));
        bars.Add(Bar(9, 130, 140.5m, 139.5m, 140));
        bars.Add(Bar(10, 140, 150.5m, 149.5m, 150));
        bars.Add(Bar(11, 150, 150.5m, 130, 148)); // retest 1
        bars.Add(Bar(12, 148, 158.5m, 157.5m, 158));
        bars.Add(Bar(13, 158, 158.5m, 135, 156)); // retest 2 -> entry
        return bars;
    }

    // The bullish fixture reflected through 350 - see this class's own doc comment.
    private static List<Candle> BearishFixture()
    {
        var bars = new List<Candle>();
        for (var i = 0; i < 6; i++) bars.Add(Bar(i, 250, 250, 250, 250));
        bars.Add(Bar(6, 250, 240.5m, 239.5m, 240));
        bars.Add(Bar(7, 240, 230.5m, 229.5m, 230));
        bars.Add(Bar(8, 230, 220.5m, 219.5m, 220));
        bars.Add(Bar(9, 220, 210.5m, 209.5m, 210));
        bars.Add(Bar(10, 210, 200.5m, 199.5m, 200));
        bars.Add(Bar(11, 200, 220, 199.5m, 202)); // retest 1
        bars.Add(Bar(12, 202, 192.5m, 191.5m, 192));
        bars.Add(Bar(13, 192, 215, 191.5m, 194)); // retest 2 -> entry
        return bars;
    }

    private static BacktestStrategyContext Context(
        IReadOnlyList<Candle> spotBars, IReadOnlyList<ObvPoint>? obvCe = null, IReadOnlyList<ObvPoint>? obvPe = null) => new()
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
        ObvPeSeries = obvPe ?? Array.Empty<ObvPoint>(),
        CdvCeSeries = Array.Empty<ObvPoint>(),
        CdvPeSeries = Array.Empty<ObvPoint>(),
        GetOptionBars = (_, _) => Array.Empty<Candle>(),
        GetOptionBarsOneMinute = (_, _) => Array.Empty<Candle>(),
        AtmCeBars = Array.Empty<Candle>(),
        AtmPeBars = Array.Empty<Candle>(),
        AtmCeVolumeBars = Array.Empty<CandleWithVolume>(),
        AtmPeVolumeBars = Array.Empty<CandleWithVolume>(),
        AtmStrike = null,
        OpenInterest = null,
    };

    private static Dictionary<string, decimal> Parameters() => new()
    {
        ["side"] = OptionTradeSimulator.SideBuy,
        ["otmSteps"] = 1,
        ["slPoints"] = 10,
        ["tpPoints"] = 20,
        ["squareOffMinutes"] = 0,
        ["signalStartMinutes"] = 0,
        ["excludeLastDays"] = 0,
        ["direction"] = 0, // both sides
        ["fastEmaPeriod"] = 3,
        ["slowEmaPeriod"] = 5,
        ["requiredRetests"] = 2,
        ["exitOnEmaBreak"] = 1,
    };

    [Fact]
    public void Bullish_FiresEntry_OnTheSecondRetestsOwnConfirmationBar()
    {
        var bars = BullishFixture();

        var signals = new EmaCrossoverRetestStrategy().EntrySignals(Context(bars), Parameters());

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal("Bullish", entry.Direction);
        Assert.Equal(bars[13].Time, entry.TimeUtc);
        Assert.Contains("retest 2/2", entry.Summary);
    }

    [Fact]
    public void Bearish_FiresEntry_OnTheSecondRetestsOwnConfirmationBar()
    {
        var bars = BearishFixture();

        var signals = new EmaCrossoverRetestStrategy().EntrySignals(Context(bars), Parameters());

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal("Bearish", entry.Direction);
        Assert.Equal(bars[13].Time, entry.TimeUtc);
    }

    [Fact]
    public void NoEntry_AfterOnlyOneRetest()
    {
        var bars = BullishFixture().Take(12).ToList(); // stop right after retest 1 (bar 11), before retest 2

        var signals = new EmaCrossoverRetestStrategy().EntrySignals(Context(bars), Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
    }

    [Fact]
    public void PendingSetup_IsAbandoned_WhenSpotClosesBackThroughTheSlowEma_BeforeRetestsComplete()
    {
        var bars = BullishFixture().Take(12).ToList(); // through retest 1 only (RetestsSeen = 1)
        // A hard drop, closing well below wherever the slow EMA has reached (~138 at this point) -
        // invalidates the pending bullish setup outright.
        bars.Add(Bar(12, 148, 148, 100, 110));
        bars.Add(Bar(13, 110, 120, 105, 115));
        // A wick+bounce shaped exactly like what retest #2 would have looked like, had the setup
        // survived - must NOT fire, since there is no pending setup left for it to complete.
        bars.Add(Bar(14, 115, 125, 105, 120));

        var signals = new EmaCrossoverRetestStrategy().EntrySignals(Context(bars), Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
    }

    [Fact]
    public void RequireFlowConfirmation_OffByDefault_EntersRegardlessOfFlow()
    {
        var bars = BullishFixture();
        // PE dominant, not CE - would FAIL a bullish flow check if the filter were on.
        var ce = new[] { new ObvPoint(T0.AddMinutes(8), 100), new ObvPoint(T0.AddMinutes(13), 100) };
        var pe = new[] { new ObvPoint(T0.AddMinutes(8), 50), new ObvPoint(T0.AddMinutes(13), 150) };

        var signals = new EmaCrossoverRetestStrategy().EntrySignals(Context(bars, ce, pe), Parameters());

        Assert.Contains(signals, s => s.Kind == "Entry");
    }

    [Fact]
    public void RequireFlowConfirmation_On_RejectsWhenFlowDoesNotFavorTheDirection()
    {
        var bars = BullishFixture();
        var ce = new[] { new ObvPoint(T0.AddMinutes(8), 100), new ObvPoint(T0.AddMinutes(13), 100) };
        var pe = new[] { new ObvPoint(T0.AddMinutes(8), 50), new ObvPoint(T0.AddMinutes(13), 150) };
        var parameters = Parameters();
        parameters["requireFlowConfirmation"] = 1;
        parameters["flowLookbackBars"] = 5;

        var signals = new EmaCrossoverRetestStrategy().EntrySignals(Context(bars, ce, pe), parameters);

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish" && s.Summary.Contains("flow"));
    }

    [Fact]
    public void RequireFlowConfirmation_On_EntersWhenFlowFavorsAndRisesTowardTheDirection()
    {
        var bars = BullishFixture();
        // CE above PE and rising over the lookback - favors the Bullish entry this setup would fire.
        var ce = new[] { new ObvPoint(T0.AddMinutes(8), 100), new ObvPoint(T0.AddMinutes(13), 140) };
        var pe = new[] { new ObvPoint(T0.AddMinutes(8), 100), new ObvPoint(T0.AddMinutes(13), 100) };
        var parameters = Parameters();
        parameters["requireFlowConfirmation"] = 1;
        parameters["flowLookbackBars"] = 5;

        var signals = new EmaCrossoverRetestStrategy().EntrySignals(Context(bars, ce, pe), parameters);

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal("Bullish", entry.Direction);
    }

    [Fact]
    public void MinFlowRisePercent_AcceptsExactlyAtTheThresholdAndRejectsJustOver()
    {
        var bars = BullishFixture();
        // CE: 100 -> 130 over the lookback - exactly a 30% rise, with PE flat and always below.
        var ce = new[] { new ObvPoint(T0.AddMinutes(8), 100), new ObvPoint(T0.AddMinutes(13), 130) };
        var pe = new[] { new ObvPoint(T0.AddMinutes(8), 50), new ObvPoint(T0.AddMinutes(13), 50) };
        var parameters = Parameters();
        parameters["requireFlowConfirmation"] = 1;
        parameters["flowLookbackBars"] = 5;
        parameters["flowMode"] = 0; // OBV only

        parameters["minFlowRisePercent"] = 30;
        Assert.Contains(new EmaCrossoverRetestStrategy().EntrySignals(Context(bars, ce, pe), parameters), s => s.Kind == "Entry");

        parameters["minFlowRisePercent"] = 31;
        Assert.DoesNotContain(new EmaCrossoverRetestStrategy().EntrySignals(Context(bars, ce, pe), parameters), s => s.Kind == "Entry");
    }

    [Fact]
    public void MinFlowRisePercentZero_KeepsThePlainAnyRiseReading()
    {
        var bars = BullishFixture();
        // The same modest rise still passes when the threshold is off (0, the default) - adding
        // this parameter must not tighten the existing "any rise" behavior on its own.
        var ce = new[] { new ObvPoint(T0.AddMinutes(8), 100), new ObvPoint(T0.AddMinutes(13), 101) };
        var pe = new[] { new ObvPoint(T0.AddMinutes(8), 50), new ObvPoint(T0.AddMinutes(13), 50) };
        var parameters = Parameters();
        parameters["requireFlowConfirmation"] = 1;
        parameters["flowLookbackBars"] = 5;
        parameters["flowMode"] = 0; // OBV only
        parameters["minFlowRisePercent"] = 0;

        var signals = new EmaCrossoverRetestStrategy().EntrySignals(Context(bars, ce, pe), parameters);

        Assert.Contains(signals, s => s.Kind == "Entry");
    }

    [Fact]
    public void DirectionFilter_BearishOnly_RejectsAWouldBeBullishEntry()
    {
        var bars = BullishFixture();
        var parameters = Parameters();
        parameters["direction"] = 2; // bearish only

        var signals = new EmaCrossoverRetestStrategy().EntrySignals(Context(bars), parameters);

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish" && s.Summary.Contains("bearish only"));
    }
}

using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers OiUnwindStrategy's entry rule: finding the strongest CE/PE OI wall near ATM
/// (blending absolute OI and today's buildup via oiChangeWeightPercent), and firing only once price
/// FIRST presses into that wall (the previous bar was still clearly outside its zone) while that
/// wall's own writers are both covering (OI down from baseline) and still on their winning side of
/// the strike with a decayed premium (SellersInProfit). Every fixture uses exactly two 1-minute
/// SpotBars - see the strategy's own doc comment for why only the most recent bar is ever
/// evaluated (OpenInterest is a live snapshot with no history of its own).</summary>
public sealed class OiUnwindStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero);
    private static readonly DateOnly Day = new(2026, 1, 5);

    private static Candle Bar(int minute, decimal close) => new(T0.AddMinutes(minute), close, close, close, close);

    private static BacktestStrategyContext Context(IReadOnlyList<Candle> spotBars, OiChainSnapshot? oi, int? atmStrike = 24000) => new()
    {
        Underlying = "NIFTY",
        TimeframeMinutes = 1,
        Step = 50,
        SpotBars = spotBars,
        SpotBarsOneMinute = spotBars,
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
        AtmStrike = atmStrike,
        OpenInterest = oi,
    };

    private static Dictionary<string, decimal> Parameters(Action<Dictionary<string, decimal>>? overrides = null)
    {
        var p = new Dictionary<string, decimal>
        {
            ["side"] = OptionTradeSimulator.SideBuy,
            ["otmSteps"] = 1,
            ["slPoints"] = 10,
            ["tpPoints"] = 20,
            ["squareOffMinutes"] = 0,
            ["signalStartMinutes"] = 0, // disabled - keeps fixtures independent of wall-clock IST
            ["excludeLastDays"] = 0,
            ["maxHoldingBars"] = 0,
            ["direction"] = 0, // both sides
            ["oiScanSteps"] = 5,
            ["oiChangeWeightPercent"] = 50,
            ["oiUnwindThresholdPercent"] = 10,
            ["premiumDecayThresholdPercent"] = 10,
            ["levelZonePoints"] = 20,
        };
        overrides?.Invoke(p);
        return p;
    }

    private static OiChainSnapshot Snapshot(Dictionary<decimal, OiStrikeSnapshot> baseline, Dictionary<decimal, OiStrikeSnapshot> current) =>
        new(Day, T0, baseline, current);

    [Fact]
    public void NoSignal_WhenOpenInterestIsNull()
    {
        var bars = new[] { Bar(0, 24070), Bar(1, 24090) };
        var context = Context(bars, oi: null);

        var signals = new OiUnwindStrategy().EntrySignals(context, Parameters());

        Assert.Empty(signals);
    }

    [Fact]
    public void NoSignal_WhenBaselineIsEmpty()
    {
        // The morning capture hasn't happened yet (see OpenInterestHostedService.
        // BaselineCaptureMinutesOfDay) - Current can already be populated, but an empty Baseline
        // means "not ready", not "no OI anywhere".
        var bars = new[] { Bar(0, 24070), Bar(1, 24090) };
        var current = new Dictionary<decimal, OiStrikeSnapshot> { [24100] = new(800_000, 100m, null, null) };
        var oi = Snapshot(new Dictionary<decimal, OiStrikeSnapshot>(), current);

        var signals = new OiUnwindStrategy().EntrySignals(Context(bars, oi), Parameters());

        Assert.Empty(signals);
    }

    [Fact]
    public void BullishEntry_FiresWhenPriceReachesResistance_WithWritersCoveringAndInProfit()
    {
        var bars = new[] { Bar(0, 24070), Bar(1, 24090) }; // prev clearly below the 24080 zone, then presses in and holds
        var baseline = new Dictionary<decimal, OiStrikeSnapshot> { [24100] = new(1_000_000, 150m, null, null) };
        var current = new Dictionary<decimal, OiStrikeSnapshot> { [24100] = new(800_000, 100m, null, null) }; // OI -20%, premium -33%
        var oi = Snapshot(baseline, current);

        var signals = new OiUnwindStrategy().EntrySignals(Context(bars, oi), Parameters());

        var signal = Assert.Single(signals);
        Assert.Equal("Entry", signal.Kind);
        Assert.Equal("Bullish", signal.Direction);
        Assert.Contains("resistance 24100", signal.Summary);
    }

    [Fact]
    public void Rejected_WhenOiHasNotUnwoundEnough()
    {
        var bars = new[] { Bar(0, 24070), Bar(1, 24090) };
        var baseline = new Dictionary<decimal, OiStrikeSnapshot> { [24100] = new(1_000_000, 150m, null, null) };
        var current = new Dictionary<decimal, OiStrikeSnapshot> { [24100] = new(950_000, 100m, null, null) }; // only -5%, below the 10% threshold
        var oi = Snapshot(baseline, current);

        var signals = new OiUnwindStrategy().EntrySignals(Context(bars, oi), Parameters());

        var signal = Assert.Single(signals);
        Assert.Equal("Rejected", signal.Kind);
        Assert.Contains("unwinding=False", signal.Summary);
    }

    [Fact]
    public void Rejected_WhenPremiumHasNotDecayedEnough()
    {
        var bars = new[] { Bar(0, 24070), Bar(1, 24090) };
        var baseline = new Dictionary<decimal, OiStrikeSnapshot> { [24100] = new(1_000_000, 150m, null, null) };
        var current = new Dictionary<decimal, OiStrikeSnapshot> { [24100] = new(800_000, 145m, null, null) }; // OI unwound, premium barely moved (-3.3%)
        var oi = Snapshot(baseline, current);

        var signals = new OiUnwindStrategy().EntrySignals(Context(bars, oi), Parameters());

        var signal = Assert.Single(signals);
        Assert.Equal("Rejected", signal.Kind);
        Assert.Contains("sellers in profit=False", signal.Summary);
    }

    [Fact]
    public void Rejected_WhenSpotIsAlreadyPastTheStrike_SellersNoLongerInProfit()
    {
        // A big bullish gap: prev bar was below the zone, but the new bar jumps clean through and
        // past the strike itself - CE writers there are no longer on their winning side at all,
        // whatever OI/premium happen to show.
        var bars = new[] { Bar(0, 24070), Bar(1, 24160) };
        var baseline = new Dictionary<decimal, OiStrikeSnapshot> { [24100] = new(1_000_000, 150m, null, null) };
        var current = new Dictionary<decimal, OiStrikeSnapshot> { [24100] = new(800_000, 100m, null, null) };
        var oi = Snapshot(baseline, current);

        var signals = new OiUnwindStrategy().EntrySignals(Context(bars, oi), Parameters());

        var signal = Assert.Single(signals);
        Assert.Equal("Rejected", signal.Kind);
        Assert.Contains("sellers in profit=False", signal.Summary);
    }

    [Fact]
    public void BearishEntry_FiresAtSupport_Mirror()
    {
        var bars = new[] { Bar(0, 23930), Bar(1, 23910) }; // prev clearly above the 23920 zone, then presses down and holds
        var baseline = new Dictionary<decimal, OiStrikeSnapshot> { [23900] = new(null, null, 1_000_000, 150m) };
        var current = new Dictionary<decimal, OiStrikeSnapshot> { [23900] = new(null, null, 800_000, 100m) };
        var oi = Snapshot(baseline, current);

        var signals = new OiUnwindStrategy().EntrySignals(Context(bars, oi), Parameters());

        var signal = Assert.Single(signals);
        Assert.Equal("Entry", signal.Kind);
        Assert.Equal("Bearish", signal.Direction);
        Assert.Contains("support 23900", signal.Summary);
    }

    [Fact]
    public void NoSignalAtAll_WhenPriceWasAlreadyInsideTheZoneOnThePreviousBar()
    {
        // Not a FRESH test of the level - both bars already sit inside the zone, so this is a stale
        // grind rather than the "just reached it" moment the strategy fires on. Idle silence, same
        // as every other bar with nothing happening.
        var bars = new[] { Bar(0, 24085), Bar(1, 24090) };
        var baseline = new Dictionary<decimal, OiStrikeSnapshot> { [24100] = new(1_000_000, 150m, null, null) };
        var current = new Dictionary<decimal, OiStrikeSnapshot> { [24100] = new(800_000, 100m, null, null) };
        var oi = Snapshot(baseline, current);

        var signals = new OiUnwindStrategy().EntrySignals(Context(bars, oi), Parameters());

        Assert.Empty(signals);
    }

    [Fact]
    public void DirectionFilter_SkipsBearishEntryWhenLongOnly()
    {
        var bars = new[] { Bar(0, 23930), Bar(1, 23910) };
        var baseline = new Dictionary<decimal, OiStrikeSnapshot> { [23900] = new(null, null, 1_000_000, 150m) };
        var current = new Dictionary<decimal, OiStrikeSnapshot> { [23900] = new(null, null, 800_000, 100m) };
        var oi = Snapshot(baseline, current);

        var signals = new OiUnwindStrategy().EntrySignals(Context(bars, oi), Parameters(p => p["direction"] = 1)); // Bullish only

        var signal = Assert.Single(signals);
        Assert.Equal("Rejected", signal.Kind);
        Assert.Contains("bullish only", signal.Summary);
    }

    [Fact]
    public void WallSelection_PrefersAbsoluteOi_WhenWeightIsZero()
    {
        // Two CE candidates: 24050 has by far the bigger absolute OI but hasn't moved at all since
        // this morning; 24100 is small in absolute terms but has BUILT UP the most. With
        // oiChangeWeightPercent=0 (absolute OI only), 24050 must win the wall - and since its OI
        // hasn't unwound at all, the result is a Rejected row naming IT, not 24100. Bars sit inside
        // BOTH strikes' own zones (24030+ and 24080+) so whichever wall wins is the only thing this
        // test is isolating.
        var bars = new[] { Bar(0, 24025), Bar(1, 24085) };
        var baseline = new Dictionary<decimal, OiStrikeSnapshot>
        {
            [24050] = new(2_000_000, 100m, null, null),
            [24100] = new(100_000, 100m, null, null),
        };
        var current = new Dictionary<decimal, OiStrikeSnapshot>
        {
            [24050] = new(2_000_000, 100m, null, null), // unchanged
            [24100] = new(150_000, 100m, null, null), // built up +50,000
        };
        var oi = Snapshot(baseline, current);

        var signals = new OiUnwindStrategy().EntrySignals(Context(bars, oi), Parameters(p => p["oiChangeWeightPercent"] = 0));

        var signal = Assert.Single(signals);
        Assert.Contains("resistance 24050", signal.Summary);
    }

    [Fact]
    public void WallSelection_PrefersOiBuildup_WhenWeightIsMaxed()
    {
        // Same two candidates as above, but oiChangeWeightPercent=100 (buildup only) - 24100 (the
        // one building up) must win the wall instead, even though 24050 still has the bigger
        // absolute OI.
        var bars = new[] { Bar(0, 24025), Bar(1, 24085) };
        var baseline = new Dictionary<decimal, OiStrikeSnapshot>
        {
            [24050] = new(2_000_000, 100m, null, null),
            [24100] = new(100_000, 100m, null, null),
        };
        var current = new Dictionary<decimal, OiStrikeSnapshot>
        {
            [24050] = new(2_000_000, 100m, null, null),
            [24100] = new(150_000, 100m, null, null),
        };
        var oi = Snapshot(baseline, current);

        var signals = new OiUnwindStrategy().EntrySignals(Context(bars, oi), Parameters(p => p["oiChangeWeightPercent"] = 100));

        var signal = Assert.Single(signals);
        Assert.Contains("resistance 24100", signal.Summary);
    }
}

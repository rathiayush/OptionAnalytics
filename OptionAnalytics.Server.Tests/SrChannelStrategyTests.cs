using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers SrChannelStrategy: the end-to-end pivot-break entry against real Skender
/// GetPivots output (pivotPeriod=2, purely to keep fixtures short - the real default is 10), plus a
/// direct look at ComputeChannels' own pivot-clustering/ranking math (made internal for exactly this
/// reason - see its own doc comment) since engineering a real price fixture that produces two
/// mergeable Skender pivots close enough together, at a chosen strength ordering, would be far more
/// fragile than just handing it a pivot list directly.</summary>
public sealed class SrChannelStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero);

    private static Candle Bar(int index, decimal price) => new(T0.AddMinutes(index), price, price, price, price);

    // Dip (low pivot) at index 2 (value 100), confirmed at index 4 (2 + pivotPeriod). The resulting
    // single-pivot channel [100,100] then holds flat until a later close breaks below it - bar 6
    // (close 95, prior close 108 was still >= 100).
    private static List<Candle> BearishFixture() =>
        new[] { 110m, 105m, 100m, 105m, 110m, 108m, 95m, 90m, 85m }.Select((p, i) => Bar(i, p)).ToList();

    // The bearish fixture reflected through 200 - a peak (resistance channel [100,100]) at index 2,
    // confirmed at index 4, broken above at index 6 (close 105, prior close 92 was still <= 100).
    private static List<Candle> BullishFixture() =>
        new[] { 90m, 95m, 100m, 95m, 90m, 92m, 105m, 110m, 115m }.Select((p, i) => Bar(i, p)).ToList();

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
            ["signalStartMinutes"] = 0,
            ["excludeLastDays"] = 0,
            ["direction"] = 0, // both sides
            ["pivotPeriod"] = 2,
            ["ppSource"] = 0, // High/Low
            ["channelWidthPercent"] = 5,
            ["minStrength"] = 1,
            ["maxChannels"] = 6,
            ["loopbackBars"] = 290,
            ["requireFlowConfirmation"] = 0,
            ["flowLookbackBars"] = 5,
            ["minFlowRisePercent"] = 0,
            ["flowMode"] = FlowConfirmation.ModeEither,
        };
        overrides?.Invoke(p);
        return p;
    }

    [Fact]
    public void Bearish_FiresEntry_WhenCloseBreaksBelowTheConfirmedChannel()
    {
        var bars = BearishFixture();

        var signals = new SrChannelStrategy().EntrySignals(Context(bars), Parameters());

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal("Bearish", entry.Direction);
        Assert.Equal(bars[6].Time, entry.TimeUtc);
    }

    [Fact]
    public void Bullish_FiresEntry_WhenCloseBreaksAboveTheConfirmedChannel()
    {
        var bars = BullishFixture();

        var signals = new SrChannelStrategy().EntrySignals(Context(bars), Parameters());

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal("Bullish", entry.Direction);
        Assert.Equal(bars[6].Time, entry.TimeUtc);
    }

    [Fact]
    public void NoEntry_BeforeThePivotHasConfirmed()
    {
        // Stops right at the break (index 6) but the pivot only confirms at index 4 - truncating to
        // index 5 removes the breaking bar entirely, so no channel exists yet and nothing should fire.
        var bars = BearishFixture().Take(6).ToList();

        var signals = new SrChannelStrategy().EntrySignals(Context(bars), Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
    }

    [Fact]
    public void RequireFlowConfirmation_OffByDefault_EntersRegardlessOfFlow()
    {
        var bars = BearishFixture();
        // PE dominant, not CE - would FAIL a bearish-favoring flow check if the filter were on.
        var ce = new[] { new ObvPoint(T0.AddMinutes(4), 500), new ObvPoint(T0.AddMinutes(6), 500) };
        var pe = new[] { new ObvPoint(T0.AddMinutes(4), 50), new ObvPoint(T0.AddMinutes(6), 60) };

        var signals = new SrChannelStrategy().EntrySignals(Context(bars, obvCe: ce, obvPe: pe), Parameters());

        Assert.Contains(signals, s => s.Kind == "Entry" && s.Direction == "Bearish");
    }

    [Fact]
    public void RequireFlowConfirmation_On_RejectsEntry_WhenFlowDoesNotFavorTheDirection()
    {
        var bars = BearishFixture();
        var ce = new[] { new ObvPoint(T0.AddMinutes(4), 500), new ObvPoint(T0.AddMinutes(6), 500) };
        var pe = new[] { new ObvPoint(T0.AddMinutes(4), 50), new ObvPoint(T0.AddMinutes(6), 60) };

        var signals = new SrChannelStrategy().EntrySignals(Context(bars, obvCe: ce, obvPe: pe), Parameters(p => p["requireFlowConfirmation"] = 1));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bearish" && s.Summary.Contains("flow does not favor"));
    }

    [Fact]
    public void ComputeChannels_MergesTwoPivotsWithinTheWidthLimit_IntoOneWiderChannel()
    {
        // Two lows 8 apart, a 300-bar High/Low range of 100 (bars 0 and 1) -> channelWidth = 100 *
        // 10% = 10, wide enough to merge them into a single [92,100] channel worth 40 (20 per pivot).
        // loopbackBars=0 with a non-overlapping bar 2 at the current index keeps the overlap bonus at
        // exactly zero, so the assertion isolates the merge math from that separate bonus.
        var bars = new[] { Bar(0, 0m), Bar(1, 100m), Bar(2, 50m) }.ToList();
        var pivots = new List<(decimal Value, int ConfirmIndex)> { (100m, 0), (92m, 1) };

        var channels = SrChannelStrategy.ComputeChannels(pivots, bars, currentIndex: 2, channelWidthPercent: 10m, minStrengthUnits: 20m, loopbackBars: 0, maxChannels: 6);

        var channel = Assert.Single(channels);
        Assert.Equal(100m, channel.Top);
        Assert.Equal(92m, channel.Bottom);
        Assert.Equal(40m, channel.Strength);
    }

    [Fact]
    public void ComputeChannels_KeepsTwoPivotsSeparate_WhenTooFarApartToMerge()
    {
        // Same two pivots, but a channelWidth of 5 is too narrow to merge an 8-point gap - two
        // independent single-pivot channels come out instead, strongest (by overlap bonus) first.
        var bars = new[] { Bar(0, 100m), Bar(1, 92m) }.ToList();
        var pivots = new List<(decimal Value, int ConfirmIndex)> { (100m, 0), (92m, 1) };

        var channels = SrChannelStrategy.ComputeChannels(pivots, bars, currentIndex: 1, channelWidthPercent: 5m, minStrengthUnits: 20m, loopbackBars: 290, maxChannels: 6);

        Assert.Equal(2, channels.Count);
        Assert.Contains(channels, c => c.Top == 100m && c.Bottom == 100m);
        Assert.Contains(channels, c => c.Top == 92m && c.Bottom == 92m);
    }

    [Fact]
    public void ComputeChannels_DropsAChannel_BelowMinimumStrength()
    {
        var bars = new[] { Bar(0, 100m) }.ToList();
        var pivots = new List<(decimal Value, int ConfirmIndex)> { (100m, 0) };

        // One lone pivot is worth strength 20 (no overlap bonus - the single bar's own High/Low is
        // 100/100, so it still adds 1, giving 21 - use a threshold above that to force a drop).
        var channels = SrChannelStrategy.ComputeChannels(pivots, bars, currentIndex: 0, channelWidthPercent: 5m, minStrengthUnits: 25m, loopbackBars: 290, maxChannels: 6);

        Assert.Empty(channels);
    }
}

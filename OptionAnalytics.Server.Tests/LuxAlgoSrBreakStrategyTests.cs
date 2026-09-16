using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers LuxAlgoSrBreakStrategy's pivot-confirmed S/R break entry against real
/// Skender.Stock.Indicators GetPivots output (leftBars=rightBars=2 here, purely to keep fixtures
/// short - the real default is 15/15). The bullish fixture is the bearish one reflected through 200
/// (a dip becomes a peak and vice versa) - not an independent construction, so it exercises the same
/// code path with the signs flipped, same convention EmaCrossoverRetestStrategyTests uses.</summary>
public sealed class LuxAlgoSrBreakStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero);

    private static Candle Bar(int index, decimal price) => new(T0.AddMinutes(index), price, price, price, price);

    // Dip (low pivot) at index 2 (value 100), confirmed at index 4 (2 + rightBars). Support then
    // holds flat at 100 until a later bar's close crosses under it - bar 6 (close 95, prior close
    // 108 was still >= 100).
    private static List<Candle> BearishFixture() =>
        new[] { 110m, 105m, 100m, 105m, 110m, 108m, 95m, 90m, 85m }.Select((p, i) => Bar(i, p)).ToList();

    // The bearish fixture reflected through 200 - a peak (resistance) at index 2 (value 100),
    // confirmed at index 4, crossed over at index 6 (close 105, prior close 92 was still <= 100).
    private static List<Candle> BullishFixture() =>
        new[] { 90m, 95m, 100m, 95m, 90m, 92m, 105m, 110m, 115m }.Select((p, i) => Bar(i, p)).ToList();

    private static BacktestStrategyContext Context(IReadOnlyList<Candle> spotBars, IReadOnlyList<CandleWithVolume>? volumeBars = null) => new()
    {
        Underlying = "NIFTY",
        TimeframeMinutes = 1,
        Step = 50,
        SpotBars = spotBars,
        SpotBarsOneMinute = spotBars,
        SpotVolumeBarsOneMinute = volumeBars ?? Array.Empty<CandleWithVolume>(),
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
            ["slPoints"] = 10,
            ["tpPoints"] = 20,
            ["squareOffMinutes"] = 0,
            ["signalStartMinutes"] = 0,
            ["excludeLastDays"] = 0,
            ["direction"] = 0, // both sides
            ["leftBars"] = 2,
            ["rightBars"] = 2,
            ["requireVolumeConfirmation"] = 0,
            ["volumeShortEma"] = 5,
            ["volumeLongEma"] = 10,
            ["volumeThreshold"] = 20,
        };
        overrides?.Invoke(p);
        return p;
    }

    [Fact]
    public void Bearish_FiresEntry_WhenCloseCrossesUnderTheConfirmedSupportPivot()
    {
        var bars = BearishFixture();

        var signals = new LuxAlgoSrBreakStrategy().EntrySignals(Context(bars), Parameters());

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal("Bearish", entry.Direction);
        Assert.Equal(bars[6].Time, entry.TimeUtc);
    }

    [Fact]
    public void Bullish_FiresEntry_WhenCloseCrossesOverTheConfirmedResistancePivot()
    {
        var bars = BullishFixture();

        var signals = new LuxAlgoSrBreakStrategy().EntrySignals(Context(bars), Parameters());

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal("Bullish", entry.Direction);
        Assert.Equal(bars[6].Time, entry.TimeUtc);
    }

    [Fact]
    public void NoEntry_BeforeThePivotHasConfirmed()
    {
        // Stops right at the cross (index 6) but the pivot only confirms at index 4 - truncating to
        // index 5 removes the crossing bar entirely, so nothing should fire.
        var bars = BearishFixture().Take(6).ToList();

        var signals = new LuxAlgoSrBreakStrategy().EntrySignals(Context(bars), Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
    }

    [Fact]
    public void RequireVolumeConfirmation_OffByDefault_EntersWithNoVolumeDataAtAll()
    {
        var bars = BearishFixture();

        // No volume bars supplied at all - the default (off) must not care.
        var signals = new LuxAlgoSrBreakStrategy().EntrySignals(Context(bars), Parameters());

        Assert.Contains(signals, s => s.Kind == "Entry" && s.Direction == "Bearish");
    }

    [Fact]
    public void RequireVolumeConfirmation_On_RejectsEntry_WhenNoVolumeDataIsAvailable()
    {
        var bars = BearishFixture();

        // Turned on with no volume series at all - the oscillator can never be ready, so the gate
        // must block rather than silently ignore itself (the whole reason it defaults off).
        var signals = new LuxAlgoSrBreakStrategy().EntrySignals(Context(bars), Parameters(p => p["requireVolumeConfirmation"] = 1));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bearish" && s.Summary.Contains("not ready"));
    }
}

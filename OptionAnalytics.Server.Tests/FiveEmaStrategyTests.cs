using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers FiveEmaStrategy's alert-candle/break entry rule (the Subhasish Pani "5 EMA"
/// setup) against real EmaCrossoverDetector EMA math (emaPeriod=5 here, the real default, over a
/// long enough flat seed that the EMA settles right at the seed price before anything interesting
/// happens - keeps the fixtures easy to reason about without hand-deriving the EMA formula).</summary>
public sealed class FiveEmaStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero);

    private static Candle Bar(int index, decimal open, decimal high, decimal low, decimal close) =>
        new(T0.AddMinutes(index), open, high, low, close);

    private static List<Candle> FlatSeed(decimal price, int count = 10)
    {
        var bars = new List<Candle>();
        for (var i = 0; i < count; i++) bars.Add(Bar(i, price, price, price, price));
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
            ["emaPeriod"] = 5,
            ["direction"] = 0, // both sides
            ["alertMaxAgeBars"] = 0,
            ["exitOnEmaTouch"] = 1,
            ["requireFlowConfirmation"] = 0,
            ["flowLookbackBars"] = 5,
            ["minFlowRisePercent"] = 0,
            ["flowMode"] = FlowConfirmation.ModeEither,
            ["requireRsiConfirmation"] = 0,
            ["rsiPeriod"] = 3,
            ["rsiBullThreshold"] = 60,
            ["rsiBearThreshold"] = 40,
            ["requireAdxConfirmation"] = 0,
            ["adxPeriod"] = 3,
            ["adxMinStrength"] = 25,
            ["requireMacdConfirmation"] = 0,
            ["macdFastPeriod"] = 3,
            ["macdSlowPeriod"] = 5,
            ["macdSignalPeriod"] = 2,
            ["requireSuperTrendConfirmation"] = 0,
            ["superTrendPeriod"] = 3,
            ["superTrendMultiplier"] = 3,
        };
        overrides?.Invoke(p);
        return p;
    }

    [Fact]
    public void Bullish_FiresEntry_WhenALaterCandleBreaksAboveTheAlertCandlesHigh()
    {
        var bars = FlatSeed(100);
        bars.Add(Bar(10, 100, 89, 88, 88.5m)); // alert candle: entirely below EMA (~100)
        bars.Add(Bar(11, 88.5m, 90, 88, 89.5m)); // breaks above the alert candle's high (89) -> entry

        var signals = new FiveEmaStrategy().EntrySignals(Context(bars), Parameters());

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal("Bullish", entry.Direction);
        Assert.Equal(bars[11].Time, entry.TimeUtc);
    }

    [Fact]
    public void Bearish_FiresEntry_WhenALaterCandleBreaksBelowTheAlertCandlesLow()
    {
        var bars = FlatSeed(100);
        bars.Add(Bar(10, 100, 112, 111, 111.5m)); // alert candle: entirely above EMA (~100)
        bars.Add(Bar(11, 111.5m, 112, 110, 110.5m)); // breaks below the alert candle's low (111) -> entry

        var signals = new FiveEmaStrategy().EntrySignals(Context(bars), Parameters());

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal("Bearish", entry.Direction);
        Assert.Equal(bars[11].Time, entry.TimeUtc);
    }

    [Fact]
    public void AlertCandle_RollsForwardToTheMostRecentQualifyingCandle()
    {
        var bars = FlatSeed(100);
        bars.Add(Bar(10, 100, 112, 111, 111.5m)); // short alert candle, low 111
        bars.Add(Bar(11, 111.5m, 113, 112, 112.5m)); // also entirely above EMA, doesn't break bar 10's low (112 > 111) -> rolls the alert to THIS candle, low 112
        // Breaks the ROLLED alert (111.5 < 112) but NOT the original bar 10 alert (111.5 > 111) -
        // only fires if the rollover actually happened.
        bars.Add(Bar(12, 112.5m, 113, 111.5m, 112));

        var signals = new FiveEmaStrategy().EntrySignals(Context(bars), Parameters());

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal("Bearish", entry.Direction);
        Assert.Equal(bars[12].Time, entry.TimeUtc);
    }

    [Fact]
    public void RequireFlowConfirmation_OffByDefault_EntersRegardlessOfFlow()
    {
        var bars = FlatSeed(100);
        bars.Add(Bar(10, 100, 89, 88, 88.5m));
        bars.Add(Bar(11, 88.5m, 90, 88, 89.5m));
        // PE dominant, not CE - would FAIL a bullish flow check if the filter were on.
        var ce = new[] { new ObvPoint(T0.AddMinutes(5), 100), new ObvPoint(T0.AddMinutes(11), 100) };
        var pe = new[] { new ObvPoint(T0.AddMinutes(5), 50), new ObvPoint(T0.AddMinutes(11), 500) };

        var signals = new FiveEmaStrategy().EntrySignals(Context(bars, ce, pe), Parameters());

        Assert.Contains(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
    }

    [Fact]
    public void RequireFlowConfirmation_On_RejectsEntry_WhenFlowDoesNotFavorTheDirection()
    {
        var bars = FlatSeed(100);
        bars.Add(Bar(10, 100, 89, 88, 88.5m));
        bars.Add(Bar(11, 88.5m, 90, 88, 89.5m));
        var ce = new[] { new ObvPoint(T0.AddMinutes(5), 100), new ObvPoint(T0.AddMinutes(11), 100) };
        var pe = new[] { new ObvPoint(T0.AddMinutes(5), 50), new ObvPoint(T0.AddMinutes(11), 500) };

        var signals = new FiveEmaStrategy().EntrySignals(Context(bars, ce, pe), Parameters(p => p["requireFlowConfirmation"] = 1));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish");
    }

    [Fact]
    public void RequireRsiConfirmation_On_RejectsEntry_WhenThresholdCanNeverBeMet()
    {
        var bars = FlatSeed(100);
        bars.Add(Bar(10, 100, 89, 88, 88.5m));
        bars.Add(Bar(11, 88.5m, 90, 88, 89.5m));

        // RSI never exceeds 100, so a bullish-above-200 threshold can never confirm - proves the
        // gate genuinely blocks when enabled, without needing to hand-derive the real RSI value.
        var signals = new FiveEmaStrategy().EntrySignals(Context(bars), Parameters(p =>
        {
            p["requireRsiConfirmation"] = 1;
            p["rsiBullThreshold"] = 200;
        }));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
    }

    [Fact]
    public void RequireRsiConfirmation_On_AllowsEntry_WhenThresholdIsTriviallyMet()
    {
        var bars = FlatSeed(100);
        bars.Add(Bar(10, 100, 89, 88, 88.5m));
        bars.Add(Bar(11, 88.5m, 90, 88, 89.5m));

        // rsiBullThreshold=0 confirms as soon as RSI has any reading at all, once warmed up.
        var signals = new FiveEmaStrategy().EntrySignals(Context(bars), Parameters(p =>
        {
            p["requireRsiConfirmation"] = 1;
            p["rsiBullThreshold"] = 0;
        }));

        Assert.Contains(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
    }
}

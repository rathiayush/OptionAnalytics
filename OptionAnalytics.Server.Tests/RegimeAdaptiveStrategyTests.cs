using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers RegimeAdaptiveStrategy's full 15M-&gt;5M-&gt;3M-&gt;1M cascade end to end. Needs a
/// LONG fixture (thousands of 1-minute bars) since the 15-minute regime alone needs ~55 fifteen-
/// minute bars (825 minutes) just to warm up its own EMA50 - built as a repeating "climb, then a
/// sharp 10-minute pullback, then resume" cycle so the 1-minute EMA5/13 pullback-rejection trigger
/// fires repeatedly once the whole cascade is confirmed to line up (via a temporary Assert.Fail dump
/// of every signal this fixture produces, the same "confirm the real output before asserting on it"
/// approach LuxAlgoSrBreakStrategyTests' own history used for GetPivots).
///
/// confirm3SlopeMinPercent/entry1SlopeMinPercent are set to 0 in these tests specifically (not this
/// strategy's own production defaults of 0.025%/0.015%) - a SHARP V-shaped synthetic pullback (the
/// simplest fixture to build and reason about) reads a genuinely negative EMA slope on the 3-minute/
/// 1-minute charts for the few bars right at the bottom of the dip, which a real, noisier market's
/// own gentler pullbacks would not necessarily do - disabling just these two slope gates isolates the
/// rest of the cascade (regime score, EMA stacks, ADX, VWAP side, RSI-neutral) rather than requiring a
/// second, much fussier fixture shape purely to also satisfy them.</summary>
public sealed class RegimeAdaptiveStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero); // 09:15 IST

    // Climbs by 0.6/bar for 50 bars, then a sharp 10-bar pullback of -1.0/bar, repeating every 60
    // bars - confirmed (via a diagnostic dump) to produce a full-cascade Bullish entry once per
    // cycle, at the bar the 1-minute EMA5 crosses back over EMA13 as the climb resumes.
    private static List<Candle> UptrendFixture(int bars = 6000)
    {
        var result = new List<Candle>(bars);
        var price = 20000m;
        for (var i = 0; i < bars; i++)
        {
            var open = price;
            var inPullback = i % 60 >= 50;
            price += inPullback ? -1.0m : 0.6m;
            var close = price;
            result.Add(new Candle(T0.AddMinutes(i), open, Math.Max(open, close), Math.Min(open, close), close));
        }
        return result;
    }

    // An independent (not reflected) descending construction, same cycle shape with every role
    // sign-flipped - confirmed via the same diagnostic dump to produce the exact mirrored result
    // (identical entry count and timing, Bearish throughout).
    private static List<Candle> DowntrendFixture(int bars = 6000)
    {
        var result = new List<Candle>(bars);
        var price = 20000m;
        for (var i = 0; i < bars; i++)
        {
            var open = price;
            var inBounce = i % 60 >= 50;
            price += inBounce ? 1.0m : -0.6m;
            var close = price;
            result.Add(new Candle(T0.AddMinutes(i), open, Math.Max(open, close), Math.Min(open, close), close));
        }
        return result;
    }

    private static List<CandleWithVolume> Volume(IReadOnlyList<Candle> bars) =>
        bars.Select(b => new CandleWithVolume(b.Time, b.Open, b.High, b.Low, b.Close, 1000)).ToList();

    private static BacktestStrategyContext Context(
        IReadOnlyList<Candle> oneMinuteBars, IReadOnlyList<ObvPoint>? obvCe = null, IReadOnlyList<ObvPoint>? obvPe = null) => new()
    {
        Underlying = "NIFTY",
        TimeframeMinutes = 1,
        Step = 50,
        SpotBars = oneMinuteBars,
        SpotBarsOneMinute = oneMinuteBars,
        SpotVolumeBarsOneMinute = Volume(oneMinuteBars),
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
            ["noNewEntriesAfterMinutes"] = 0,
            ["excludeLastDays"] = 0,
            ["direction"] = 0,
            ["regime15EmaFast"] = 20,
            ["regime15EmaSlow"] = 50,
            ["regime15SlopeMinPercent"] = 0.010m,
            ["regime15AdxMin"] = 20,
            ["regimeScoreMin"] = 3,
            ["regimeScoreFull"] = 4,
            ["setup5EmaFast"] = 9,
            ["setup5EmaSlow"] = 21,
            ["setup5AdxMin"] = 20,
            ["confirm3EmaFast"] = 7,
            ["confirm3EmaSlow"] = 20,
            ["confirm3AdxMin"] = 15,
            ["confirm3SlopeMinPercent"] = 0m, // see class doc comment
            ["entry1EmaFast"] = 5,
            ["entry1EmaSlow"] = 13,
            ["entry1AdxMin"] = 10,
            ["entry1SlopeMinPercent"] = 0m, // see class doc comment
            ["cascadeSlopeLookbackBars"] = 3,
            ["cascadeAdxPeriod"] = 14,
            ["atrPeriod"] = 14,
            ["atrNormalHighPercent"] = 1.5m,
            ["atrExtremePercent"] = 2.5m,
            ["rangeAtrMultiple"] = 1.5m,
            ["rsiPeriod"] = 14,
            ["rsiNeutralLow"] = 40,
            ["rsiNeutralHigh"] = 60,
            ["requireFlowConfirmation"] = 0,
            ["flowLookbackBars"] = 5,
            ["minFlowRisePercent"] = 0,
            ["flowMode"] = FlowConfirmation.ModeEither,
        };
        overrides?.Invoke(p);
        return p;
    }

    [Fact]
    public void Bullish_FiresRepeatedCascadeEntries_OnASustainedUptrendWithPeriodicPullbacks()
    {
        var bars = UptrendFixture();

        var signals = new RegimeAdaptiveStrategy().EntrySignals(Context(bars), Parameters());
        var entries = signals.Where(s => s.Kind == "Entry").ToList();

        Assert.NotEmpty(entries);
        Assert.All(entries, e => Assert.Equal("Bullish", e.Direction));
        Assert.All(entries, e => Assert.Contains("regime Bullish", e.Summary));
        Assert.All(entries, e => Assert.Contains("5M setup ok -> 3M confirmed -> 1M pullback rejection", e.Summary));
        // Well past the 750-minute warmup the 15-minute EMA50 needs (50 fifteen-minute bars) - a real
        // cascade result, not an artifact of the fixture's own early, still-warming-up bars.
        Assert.All(entries, e => Assert.True(e.TimeUtc >= T0.AddMinutes(750)));
        // Entries keep firing across the whole fixture, not just in one early burst - signals are
        // newest-first, so entries[0] is the LATEST one.
        Assert.True(entries[0].TimeUtc >= T0.AddMinutes(bars.Count - 500));
    }

    [Fact]
    public void Bearish_FiresRepeatedCascadeEntries_OnASustainedDowntrendWithPeriodicBounces()
    {
        var bars = DowntrendFixture();

        var signals = new RegimeAdaptiveStrategy().EntrySignals(Context(bars), Parameters());
        var entries = signals.Where(s => s.Kind == "Entry").ToList();

        Assert.NotEmpty(entries);
        Assert.All(entries, e => Assert.Equal("Bearish", e.Direction));
        Assert.All(entries, e => Assert.Contains("regime Bearish", e.Summary));
    }

    [Fact]
    public void NoSignalsAtAll_WhenTooFewOneMinuteBarsExistForA15MinuteRegime()
    {
        var bars = UptrendFixture(500); // well short of the ~55*15=825 minimum for a 15-minute EMA50 warm-up

        var signals = new RegimeAdaptiveStrategy().EntrySignals(Context(bars), Parameters());

        Assert.Empty(signals);
    }

    [Fact]
    public void RequireFlowConfirmation_OffByDefaultInTheseTests_EntersRegardlessOfFlow()
    {
        var bars = UptrendFixture();
        // PE dominant, not CE - would FAIL a bullish-favoring flow check if the filter were on.
        var ce = new[] { new ObvPoint(T0, 50), new ObvPoint(T0.AddMinutes(bars.Count - 1), 60) };
        var pe = new[] { new ObvPoint(T0, 500), new ObvPoint(T0.AddMinutes(bars.Count - 1), 500) };

        var signals = new RegimeAdaptiveStrategy().EntrySignals(Context(bars, obvCe: ce, obvPe: pe), Parameters());

        Assert.Contains(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
    }

    [Fact]
    public void RequireFlowConfirmation_On_RejectsEntries_WhenFlowDoesNotFavorTheDirection()
    {
        var bars = UptrendFixture();
        var ce = new[] { new ObvPoint(T0, 50), new ObvPoint(T0.AddMinutes(bars.Count - 1), 60) };
        var pe = new[] { new ObvPoint(T0, 500), new ObvPoint(T0.AddMinutes(bars.Count - 1), 500) };

        var signals = new RegimeAdaptiveStrategy().EntrySignals(Context(bars, obvCe: ce, obvPe: pe), Parameters(p => p["requireFlowConfirmation"] = 1));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish" && s.Summary.Contains("flow does not favor"));
    }

    [Fact]
    public void ExtremeVolatility_RejectsEveryCascadeEntry()
    {
        var bars = UptrendFixture();

        // This fixture's own bar-to-bar ATR% is a small fraction of a percent (a ~0.6-1.0 point move
        // on a ~20000 price level) - a threshold effectively at zero guarantees every bar reads as
        // Extreme, regardless of what that natural ATR% actually is.
        var signals = new RegimeAdaptiveStrategy().EntrySignals(Context(bars), Parameters(p => p["atrExtremePercent"] = 0.0001m));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("Extreme volatility"));
    }

    [Fact]
    public void Side_DefaultsToSell_UnlikeEveryOtherStrategyHere()
    {
        var strategy = new RegimeAdaptiveStrategy();
        Assert.Equal(OptionTradeSimulator.SideSell, strategy.Parameters.Single(p => p.Key == "side").Default);
    }

    [Fact]
    public void RequireFlowConfirmation_DefaultsOnForThisStrategy()
    {
        var strategy = new RegimeAdaptiveStrategy();
        Assert.Equal(1m, strategy.Parameters.Single(p => p.Key == "requireFlowConfirmation").Default);
    }
}

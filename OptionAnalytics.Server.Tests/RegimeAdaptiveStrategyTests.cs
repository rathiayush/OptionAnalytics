using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;
using Skender.Stock.Indicators;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers RegimeAdaptiveStrategy's full 15M-&gt;5M-&gt;3M-&gt;1M cascade end to end. Needs a
/// LONG fixture (thousands of 1-minute bars) since the 15-minute regime alone needs ~55 fifteen-
/// minute bars (825 minutes) just to warm up its own EMA50 - built as a repeating "climb, then a
/// sharp 20-minute pullback, then resume" cycle so the 1-minute EMA5/13 pullback-rejection trigger
/// fires repeatedly once the whole cascade is confirmed to line up (via a temporary Assert.Fail dump
/// of every signal this fixture produces, the same "confirm the real output before asserting on it"
/// approach LuxAlgoSrBreakStrategyTests' own history used for GetPivots).
///
/// The cycle/step numbers here (100-bar cycle, 20-bar pullback, -0.6/+0.4 point steps) were re-picked
/// after fixing a look-ahead bias in AlignStepToTime/AlignToTime (both now compare each bar's own
/// CLOSE time across timeframes instead of its open time - see their own doc comments): the 1-minute
/// EMA5/13 cross and the now-honestly-lagging 3-minute confirmation bar no longer land on the exact
/// same synthetic bar under the old 60/50/10 shape, which is why entry1CrossWithinBars exists (see
/// the strategy's own doc comment) and why this fixture's numbers changed - re-verified via a
/// diagnostic dump that this shape produces 17 full-cascade entries, evenly spread, not a one-off.
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

    // Climbs by 0.4/bar for 80 bars, then a sharp 20-bar pullback of -0.6/bar, repeating every 100
    // bars - confirmed (via a diagnostic dump) to produce 17 full-cascade Bullish entries across the
    // fixture, at the bar the 1-minute EMA5 crosses back over EMA13 (within entry1CrossWithinBars) as
    // the climb resumes.
    private static List<Candle> UptrendFixture(int bars = 6000)
    {
        var result = new List<Candle>(bars);
        var price = 20000m;
        for (var i = 0; i < bars; i++)
        {
            var open = price;
            var inPullback = i % 100 >= 80;
            price += inPullback ? -0.6m : 0.4m;
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
            var inBounce = i % 100 >= 80;
            price += inBounce ? 0.6m : -0.4m;
            var close = price;
            result.Add(new Candle(T0.AddMinutes(i), open, Math.Max(open, close), Math.Min(open, close), close));
        }
        return result;
    }

    // Same shape as UptrendFixture but with a 300-bar cycle (divisible by 1x, 3x, 5x... page
    // timeframes) so the cascade's REGIME/SETUP/CONFIRM/ENTRY layers still land on clean bucket
    // boundaries once re-based to a non-1-minute page timeframe - used only by the timeframe-scaling
    // test below, confirmed via a diagnostic dump to produce entries at tf=3 (45M/15M/9M/3M layers).
    private static List<Candle> ScalableUptrendFixture(int bars = 20000)
    {
        var result = new List<Candle>(bars);
        var price = 20000m;
        for (var i = 0; i < bars; i++)
        {
            var open = price;
            var inPullback = i % 300 >= 240;
            price += inPullback ? -0.2m : 0.13333m;
            var close = price;
            result.Add(new Candle(T0.AddMinutes(i), open, Math.Max(open, close), Math.Min(open, close), close));
        }
        return result;
    }

    private static List<CandleWithVolume> Volume(IReadOnlyList<Candle> bars) =>
        bars.Select(b => new CandleWithVolume(b.Time, b.Open, b.High, b.Low, b.Close, 1000)).ToList();

    private static BacktestStrategyContext Context(
        IReadOnlyList<Candle> oneMinuteBars, IReadOnlyList<ObvPoint>? obvCe = null, IReadOnlyList<ObvPoint>? obvPe = null, int timeframeMinutes = 1) => new()
    {
        Underlying = "NIFTY",
        TimeframeMinutes = timeframeMinutes,
        Step = 50,
        SpotBars = timeframeMinutes == 1 ? oneMinuteBars : BacktestUtil.AggregateCandles(oneMinuteBars, timeframeMinutes),
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
    public void CascadeLayers_ScaleWithThePageOwnSelectedTimeframe_NotFixedRealClockMinutes()
    {
        var bars = ScalableUptrendFixture();

        // Page set to a 3-minute timeframe: REGIME/SETUP/CONFIRM/ENTRY should re-base to
        // 45/15/9/3 minutes (15x/5x/3x/1x of 3), not stay pinned at 15/5/3/1 real minutes.
        var signals = new RegimeAdaptiveStrategy().EntrySignals(Context(bars, timeframeMinutes: 3), Parameters());
        var entries = signals.Where(s => s.Kind == "Entry").ToList();

        Assert.NotEmpty(entries);
        Assert.All(entries, e => Assert.Equal("Bullish", e.Direction));
        Assert.All(entries, e => Assert.Contains("45M regime Bullish", e.Summary));
        Assert.All(entries, e => Assert.Contains("15M setup ok -> 9M confirmed -> 3M pullback rejection", e.Summary));
    }

    [Fact]
    public void NoSignalsAtAll_WhenTooFewOneMinuteBarsExistForA15MinuteRegime()
    {
        var bars = UptrendFixture(500); // well short of the ~55*15=825 minimum for a 15-minute EMA50 warm-up

        var signals = new RegimeAdaptiveStrategy().EntrySignals(Context(bars), Parameters());

        Assert.Empty(signals);
    }

    [Fact]
    public void ExtremeVolatility_RejectsEveryCascadeEntry()
    {
        var bars = UptrendFixture();

        // This fixture's own bar-to-bar ATR% is a small fraction of a percent (a ~0.4-0.6 point move
        // on a ~20000 price level) - a threshold effectively at zero guarantees every bar reads as
        // Extreme, regardless of what that natural ATR% actually is.
        var signals = new RegimeAdaptiveStrategy().EntrySignals(Context(bars), Parameters(p => p["atrExtremePercent"] = 0.0001m));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("reads Volatile"));
    }

    [Fact]
    public void Side_DefaultsToSell_UnlikeEveryOtherStrategyHere()
    {
        var strategy = new RegimeAdaptiveStrategy();
        Assert.Equal(OptionTradeSimulator.SideSell, strategy.Parameters.Single(p => p.Key == "side").Default);
    }

    [Fact]
    public void HasNoCdvObvFlowConfirmationParameter_ItWasRemovedByExplicitRequest()
    {
        var strategy = new RegimeAdaptiveStrategy();
        Assert.DoesNotContain(strategy.Parameters, p => p.Key is "requireFlowConfirmation" or "flowLookbackBars" or "minFlowRisePercent" or "flowMode");
    }

    // ---- ComputeVolatileReasons: direct unit tests against the internal detector (made internal
    // for exactly this reason - see its own doc comment) with small, hand-built candle sequences,
    // rather than needing a full cascade fixture that also happens to trip a price-action trigger at
    // the exact volatile bar. Each test disables every OTHER signal (a very high ratio/percent
    // effectively never fires) so it isolates the one being tested. ----

    private static List<Candle> CalmThenOneBar(Candle oddBar, int calmBars = 25)
    {
        var bars = new List<Candle>();
        for (var i = 0; i < calmBars; i++) bars.Add(new Candle(T0.AddMinutes(i), 100m, 100.5m, 99.5m, 100m));
        bars.Add(oddBar);
        return bars;
    }

    private static (List<decimal?> AtrPage, List<decimal?> AtrPercentPage) Atr(IReadOnlyList<Candle> bars, int period = 14)
    {
        var quotes = bars.Select(c => new Quote { Date = c.Time.UtcDateTime, Open = c.Open, High = c.High, Low = c.Low, Close = c.Close, Volume = 0 }).ToList();
        var atr = quotes.GetAtr(period).Select(r => (decimal?)r.Atr).ToList();
        var atrPercent = bars.Select((b, i) => atr[i] is { } a && b.Close != 0 ? (decimal?)(a / b.Close * 100m) : null).ToList();
        return (atr, atrPercent);
    }

    [Fact]
    public void ComputeVolatileReasons_FlagsAtrExpansion_WhenATRSpikesRelativeToItsOwnAverage()
    {
        var bars = CalmThenOneBar(new Candle(T0.AddMinutes(25), 100m, 130m, 100m, 115m)); // a single huge-range bar
        var (atrPage, atrPercentPage) = Atr(bars);

        var reasons = RegimeAdaptiveStrategy.ComputeVolatileReasons(
            bars, atrPage, atrPercentPage, atrExtremePercent: 1000m, atrAverageLookbackBars: 20, atrExpansionRatio: 1.5m, largeCandleRatio: 1000m, gapAtrMultiple: 1000m);

        Assert.Null(reasons[24]); // still calm the bar before
        Assert.NotNull(reasons[25]);
        Assert.Contains("ATR expanded", reasons[25]);
    }

    [Fact]
    public void ComputeVolatileReasons_FlagsALargeCandle_RelativeToItsOwnAverageRange()
    {
        var bars = CalmThenOneBar(new Candle(T0.AddMinutes(25), 100m, 130m, 100m, 115m));
        var (atrPage, atrPercentPage) = Atr(bars);

        var reasons = RegimeAdaptiveStrategy.ComputeVolatileReasons(
            bars, atrPage, atrPercentPage, atrExtremePercent: 1000m, atrAverageLookbackBars: 20, atrExpansionRatio: 1000m, largeCandleRatio: 2m, gapAtrMultiple: 1000m);

        Assert.NotNull(reasons[25]);
        Assert.Contains("large candle", reasons[25]);
    }

    [Fact]
    public void ComputeVolatileReasons_FlagsAnOpeningGap_EvenWhenThatBarsOwnRangeIsTight()
    {
        // Bar 25 gaps 15 points up from bar 24's close, but its OWN High-Low range is as tight as
        // every calm bar around it - isolates the gap check from the large-candle one.
        var bars = CalmThenOneBar(new Candle(T0.AddMinutes(25), 115m, 115.5m, 114.5m, 115m));
        var (atrPage, atrPercentPage) = Atr(bars);

        var reasons = RegimeAdaptiveStrategy.ComputeVolatileReasons(
            bars, atrPage, atrPercentPage, atrExtremePercent: 1000m, atrAverageLookbackBars: 20, atrExpansionRatio: 1000m, largeCandleRatio: 1000m, gapAtrMultiple: 1m);

        Assert.NotNull(reasons[25]);
        Assert.Contains("opening gap", reasons[25]);
    }

    [Fact]
    public void ComputeVolatileReasons_FlagsNothing_OnACalmSteadySeries()
    {
        var bars = new List<Candle>();
        for (var i = 0; i < 30; i++) bars.Add(new Candle(T0.AddMinutes(i), 100m, 100.5m, 99.5m, 100m));
        var (atrPage, atrPercentPage) = Atr(bars);

        var reasons = RegimeAdaptiveStrategy.ComputeVolatileReasons(
            bars, atrPage, atrPercentPage, atrExtremePercent: 2.5m, atrAverageLookbackBars: 20, atrExpansionRatio: 1.5m, largeCandleRatio: 2m, gapAtrMultiple: 1m);

        Assert.All(reasons, Assert.Null);
    }
}

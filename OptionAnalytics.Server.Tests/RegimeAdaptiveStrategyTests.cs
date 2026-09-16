using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers the full rewrite of RegimeAdaptiveStrategy per the user's own detailed
/// "ADAPTIVE OPTIONS SELLING STRATEGY" specification - see the class's own doc comment for the
/// exact rules. REGIME classification itself (ClassifyRegime) is tested directly with small,
/// hand-built indicator series - confirmed via a diagnostic dump that a block-wide perturbation
/// self-dilutes its own rolling average, so only the LAST few bars are perturbed, keeping the
/// rolling average close to the untouched baseline. End-to-end fixtures then cover the cascade of
/// entry/exit/concurrency behaviour built on top of that classification.</summary>
public sealed class RegimeAdaptiveStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero);

    // A steady uptrend (ADX/DI + EMA slope all confirm) - confirmed via a diagnostic dump to read
    // Trend/Bullish throughout once past warmup.
    private static List<Candle> TrendFixture(int bars = 6000, decimal step = 0.5m)
    {
        var result = new List<Candle>(bars);
        var price = 20000m;
        for (var i = 0; i < bars; i++)
        {
            var open = price;
            price += step;
            var close = price;
            result.Add(new Candle(T0.AddMinutes(i), open, Math.Max(open, close) + 0.3m, Math.Min(open, close) - 0.3m, close));
        }
        return result;
    }

    // A steady sine-wave oscillation - confirmed via a diagnostic dump to read Neutral throughout
    // (its own ATR%/BB-width stay roughly constant relative to their own rolling average, so it
    // never dips far enough below to read as the stricter Range - Neutral is RANGE's own sibling in
    // this design and shares the identical Short Strangle execution, so this still exercises that
    // path end to end).
    private static List<Candle> RangeFixture(int bars = 6000, decimal amplitude = 15m, int period = 40)
    {
        var result = new List<Candle>(bars);
        var mid = 20000m;
        for (var i = 0; i < bars; i++)
        {
            var open = mid + amplitude * (decimal)Math.Sin(2 * Math.PI * i / period);
            var close = mid + amplitude * (decimal)Math.Sin(2 * Math.PI * (i + 1) / period);
            result.Add(new Candle(T0.AddMinutes(i), open, Math.Max(open, close) + 0.2m, Math.Min(open, close) - 0.2m, close));
        }
        return result;
    }

    private static List<CandleWithVolume> Volume(IReadOnlyList<Candle> bars) =>
        bars.Select(b => new CandleWithVolume(b.Time, b.Open, b.High, b.Low, b.Close, 1000)).ToList();

    private static BacktestStrategyContext Context(IReadOnlyList<Candle> oneMin, int timeframeMinutes = 1)
    {
        // A flat, never-moving synthetic premium for every strike - lets Simulate() produce real
        // (non-NoData) trades without needing to model actual option pricing, which is not this
        // test's concern; every trade here is expected to resolve via time/regime-change/EndOfDay,
        // never StopLoss/TakeProfit, since the premium literally never moves.
        var oneMinOption = oneMin.Select(b => new Candle(b.Time, 100m, 100.5m, 99.5m, 100m)).ToList();
        return new()
        {
            Underlying = "NIFTY",
            TimeframeMinutes = timeframeMinutes,
            Step = 50,
            SpotBars = timeframeMinutes == 1 ? oneMin : BacktestUtil.AggregateCandles(oneMin, timeframeMinutes),
            SpotBarsOneMinute = oneMin,
            SpotVolumeBarsOneMinute = Volume(oneMin),
            ConfluenceSignalsAscending = Array.Empty<BacktestSignal>(),
            AllSignals = Array.Empty<BacktestSignal>(),
            ObvCeSeries = Array.Empty<ObvPoint>(),
            ObvPeSeries = Array.Empty<ObvPoint>(),
            CdvCeSeries = Array.Empty<ObvPoint>(),
            CdvPeSeries = Array.Empty<ObvPoint>(),
            GetOptionBars = (_, _) => timeframeMinutes == 1 ? oneMinOption : BacktestUtil.AggregateCandles(oneMinOption, timeframeMinutes),
            GetOptionBarsOneMinute = (_, _) => oneMinOption,
            AtmCeBars = Array.Empty<Candle>(),
            AtmPeBars = Array.Empty<Candle>(),
            AtmCeVolumeBars = Array.Empty<CandleWithVolume>(),
            AtmPeVolumeBars = Array.Empty<CandleWithVolume>(),
            AtmStrike = null,
        };
    }

    private static Dictionary<string, decimal> Parameters(Action<Dictionary<string, decimal>>? overrides = null)
    {
        var p = new RegimeAdaptiveStrategy().Parameters.ToDictionary(x => x.Key, x => x.Default);
        p["signalStartMinutes"] = 0;
        p["noNewEntriesAfterMinutes"] = 0;
        overrides?.Invoke(p);
        return p;
    }

    [Fact]
    public void Trend_FiresSingleLegDirectionalEntries_MatchingTheSustainedUptrend()
    {
        var bars = TrendFixture();

        var signals = new RegimeAdaptiveStrategy().EntrySignals(Context(bars), Parameters());
        var entries = signals.Where(s => s.Kind == "Entry").ToList();

        Assert.NotEmpty(entries);
        Assert.All(entries, e => Assert.Equal("Bullish", e.Direction));
        Assert.All(entries, e => Assert.Contains("Trend regime Bullish", e.Summary));
        Assert.All(entries, e => Assert.Contains("sell PE", e.Summary));
    }

    [Fact]
    public void RangeOrNeutral_FiresBothLegsAtOnce_AsAShortStrangle()
    {
        var bars = RangeFixture();

        var signals = new RegimeAdaptiveStrategy().EntrySignals(Context(bars), Parameters());
        var entries = signals.Where(s => s.Kind == "Entry").ToList();

        Assert.NotEmpty(entries);
        var bullish = entries.Count(e => e.Direction == "Bullish");
        var bearish = entries.Count(e => e.Direction == "Bearish");
        // Every qualifying bar fires BOTH legs together - equal counts, not just "some of each".
        Assert.Equal(bullish, bearish);
        Assert.All(entries, e => Assert.Contains("Short Strangle", e.Summary));
    }

    [Fact]
    public void RangeOrNeutral_TheTwoLegsAreGenuinelyConcurrentPositions_NotOneAtATime()
    {
        var bars = RangeFixture();

        var trades = new RegimeAdaptiveStrategy().Simulate(Context(bars), Parameters());
        var ceWindows = trades.Where(t => t.OptionType == "CE" && t.EntryTimeUtc is not null && t.ExitTimeUtc is not null)
            .Select(t => (Start: t.EntryTimeUtc!.Value, End: t.ExitTimeUtc!.Value)).ToList();
        var peWindows = trades.Where(t => t.OptionType == "PE" && t.EntryTimeUtc is not null && t.ExitTimeUtc is not null)
            .Select(t => (Start: t.EntryTimeUtc!.Value, End: t.ExitTimeUtc!.Value)).ToList();

        Assert.NotEmpty(ceWindows);
        Assert.NotEmpty(peWindows);
        // At least one CE window genuinely overlaps a PE window in time - proof the two legs really
        // held open simultaneously (via two independent OptionTradeSimulator.Run calls), not that
        // one leg waited for the other to close first the way a single shared signal stream would.
        Assert.Contains(ceWindows, ce => peWindows.Any(pe => ce.Start < pe.End && pe.Start < ce.End));
    }

    [Fact]
    public void NoSignalsAtAll_WhenTooFewOneMinuteBarsExistForA15MinuteRegime()
    {
        var bars = TrendFixture(500); // well short of the 15-minute regime's own warmup

        var signals = new RegimeAdaptiveStrategy().EntrySignals(Context(bars), Parameters());

        Assert.Empty(signals);
    }

    [Fact]
    public void Trend_DirectionFilter_BlocksTheDisallowedSide()
    {
        var bars = TrendFixture(); // a Bullish-only uptrend

        var signals = new RegimeAdaptiveStrategy().EntrySignals(Context(bars), Parameters(p => p["direction"] = 2m /* ShortOnly */));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("direction filter"));
    }

    [Fact]
    public void HasNoStaticSideOrOtmStepsOrPointBasedSlTpParameters_ThoseAreComputedInternallyNow()
    {
        var strategy = new RegimeAdaptiveStrategy();
        Assert.DoesNotContain(strategy.Parameters, p => p.Key is "side" or "otmSteps" or "slPoints" or "tpPoints");
        Assert.Contains(strategy.Parameters, p => p.Key == "baseOtmSteps");
        Assert.Contains(strategy.Parameters, p => p.Key == "baseProfitTargetPercent");
        Assert.Contains(strategy.Parameters, p => p.Key == "baseStopLossPercent");
    }

    [Fact]
    public void DefaultsForTimeframe_GivesEachOfTheFourSelectableTimeframesItsOwnDistinctBaseValues()
    {
        var strategy = new RegimeAdaptiveStrategy();

        var byTimeframe = new[] { 1, 3, 5, 15 }
            .Select(tf => BacktestUtil.ApplyTimeframeDefaults(strategy, tf))
            .Select(ps => (
                Otm: ps.Single(p => p.Key == "baseOtmSteps").Default,
                Pt: ps.Single(p => p.Key == "baseProfitTargetPercent").Default,
                Sl: ps.Single(p => p.Key == "baseStopLossPercent").Default,
                Hold: ps.Single(p => p.Key == "baseMaxHoldingMinutes").Default))
            .ToList();

        Assert.Equal(4, byTimeframe.Select(x => (x.Pt, x.Sl, x.Hold)).Distinct().Count());
        // The spec's own exact 5-minute defaults.
        Assert.Equal((38m, 75m, 150m), (byTimeframe[2].Pt, byTimeframe[2].Sl, byTimeframe[2].Hold));
    }

    // ---- ClassifyRegime: direct unit tests against the internal classifier (made internal for
    // exactly this reason) with small, hand-built indicator series. A block-wide perturbation was
    // confirmed (via a diagnostic dump) to self-dilute its own rolling average - only the LAST few
    // bars are perturbed here, keeping the rolling average close to the untouched baseline so the
    // CURRENT bar's ratio-to-average genuinely spikes/contracts the way a real regime shift would. ----

    private static decimal?[] Flat(int n, decimal v) => Enumerable.Repeat((decimal?)v, n).ToArray();

    private static decimal?[] FlatThenLastFew(int n, decimal baseline, decimal lastValue, int lastCount = 3)
    {
        var a = Flat(n, baseline);
        for (var i = n - lastCount; i < n; i++) a[i] = lastValue;
        return a;
    }

    [Fact]
    public void ClassifyRegime_FlagsHighVol_WhenAtrPercentSpikesAboveItsOwnAverage_WithAdxConfirming()
    {
        const int n = 80;
        var (type, _) = RegimeAdaptiveStrategy.ClassifyRegime(
            atrPct: FlatThenLastFew(n, 1.0m, 2.5m), bbWidth: Flat(n, 2m), adx: Flat(n, 30m), pdi: Flat(n, 10m), mdi: Flat(n, 5m), ema: Flat(n, 100m),
            rollingAverageLookback: 20, emaSlopeLookback: 5, trendSlopeConsistentBars: 4,
            highVolAtrPctRatio: 1.2m, highVolBbWidthRatio: 1.4m, highVolAdxMin: 22m,
            trendAdxMin: 28m, trendDiSpreadMin: 12m,
            rangeAtrPctRatio: 0.85m, rangeAdxMax: 20m, rangeBbWidthRatio: 0.9m);

        Assert.Equal("HighVol", type[^1]);
    }

    [Fact]
    public void ClassifyRegime_FlagsTrend_WhenAdxDiAndSustainedEmaSlopeAllAgree()
    {
        const int n = 80;
        var risingEma = Enumerable.Range(0, n).Select(i => (decimal?)(100m + i)).ToArray();

        var (type, direction) = RegimeAdaptiveStrategy.ClassifyRegime(
            atrPct: Flat(n, 1.0m), bbWidth: Flat(n, 2m), adx: Flat(n, 35m), pdi: Flat(n, 30m), mdi: Flat(n, 10m), ema: risingEma,
            rollingAverageLookback: 20, emaSlopeLookback: 5, trendSlopeConsistentBars: 4,
            highVolAtrPctRatio: 1.2m, highVolBbWidthRatio: 1.4m, highVolAdxMin: 22m,
            trendAdxMin: 28m, trendDiSpreadMin: 12m,
            rangeAtrPctRatio: 0.85m, rangeAdxMax: 20m, rangeBbWidthRatio: 0.9m);

        Assert.Equal("Trend", type[^1]);
        Assert.Equal("Bullish", direction[^1]);
    }

    [Fact]
    public void ClassifyRegime_FlagsRange_WhenAtrPercentAndBbWidthBothContractBelowTheirOwnAverage()
    {
        const int n = 80;
        var (type, direction) = RegimeAdaptiveStrategy.ClassifyRegime(
            atrPct: FlatThenLastFew(n, 1.0m, 0.5m), bbWidth: FlatThenLastFew(n, 2m, 1.0m), adx: Flat(n, 15m), pdi: Flat(n, 10m), mdi: Flat(n, 9m), ema: Flat(n, 100m),
            rollingAverageLookback: 20, emaSlopeLookback: 5, trendSlopeConsistentBars: 4,
            highVolAtrPctRatio: 1.2m, highVolBbWidthRatio: 1.4m, highVolAdxMin: 22m,
            trendAdxMin: 28m, trendDiSpreadMin: 12m,
            rangeAtrPctRatio: 0.85m, rangeAdxMax: 20m, rangeBbWidthRatio: 0.9m);

        Assert.Equal("Range", type[^1]);
        Assert.Null(direction[^1]);
    }

    [Fact]
    public void ClassifyRegime_FlagsNeutral_WhenNothingElseMatches()
    {
        const int n = 80;
        var (type, direction) = RegimeAdaptiveStrategy.ClassifyRegime(
            atrPct: Flat(n, 1.0m), bbWidth: Flat(n, 2m), adx: Flat(n, 15m), pdi: Flat(n, 10m), mdi: Flat(n, 9m), ema: Flat(n, 100m),
            rollingAverageLookback: 20, emaSlopeLookback: 5, trendSlopeConsistentBars: 4,
            highVolAtrPctRatio: 1.2m, highVolBbWidthRatio: 1.4m, highVolAdxMin: 22m,
            trendAdxMin: 28m, trendDiSpreadMin: 12m,
            rangeAtrPctRatio: 0.85m, rangeAdxMax: 20m, rangeBbWidthRatio: 0.9m);

        Assert.Equal("Neutral", type[^1]);
        Assert.Null(direction[^1]);
    }

    [Fact]
    public void ClassifyRegime_ReturnsNull_BeforeEnoughWarmupDataExists()
    {
        const int n = 5; // well short of rollingAverageLookback=20
        var (type, _) = RegimeAdaptiveStrategy.ClassifyRegime(
            atrPct: Flat(n, 1.0m), bbWidth: Flat(n, 2m), adx: Flat(n, 15m), pdi: Flat(n, 10m), mdi: Flat(n, 9m), ema: Flat(n, 100m),
            rollingAverageLookback: 20, emaSlopeLookback: 5, trendSlopeConsistentBars: 4,
            highVolAtrPctRatio: 1.2m, highVolBbWidthRatio: 1.4m, highVolAdxMin: 22m,
            trendAdxMin: 28m, trendDiSpreadMin: 12m,
            rangeAtrPctRatio: 0.85m, rangeAdxMax: 20m, rangeBbWidthRatio: 0.9m);

        Assert.All(type, Assert.Null);
    }
}

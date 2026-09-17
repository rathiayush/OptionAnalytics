using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers CdvObvFlowStrategy - see its own doc comment for the "each of the three lookback
/// windows has its own independently-tunable threshold, all three must pass" design worked out with
/// the user.
///
/// Fixtures use small lookback windows (2/3/4 bars instead of the real 5/10/15) purely to keep them
/// short, plus a PURE EXPONENTIAL series for OBV/PE so every bar's own %-change over ANY window is
/// the same constant ((rate)^window - 1) * 100 - easy to hand-verify rather than needing a diagnostic
/// dump, and it means every bar from the point the longest window has enough history onward
/// independently qualifies (this is expected, not a bug - see KathyLienEma20Ema200StrategyTests' own
/// doc comment for the same "a clean synthetic ramp legitimately re-qualifies every bar" reasoning).</summary>
public sealed class CdvObvFlowStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero);

    private static List<ObvPoint> ExponentialSeries(int bars, decimal start, decimal ratePerBar) =>
        Enumerable.Range(0, bars).Select(i => new ObvPoint(T0.AddMinutes(i), start * (decimal)Math.Pow((double)ratePerBar, i))).ToList();

    private static List<Candle> FlatSpotBars(int bars) =>
        Enumerable.Range(0, bars).Select(i => new Candle(T0.AddMinutes(i), 20000m, 20000m, 20000m, 20000m)).ToList();

    private static BacktestStrategyContext Context(
        IReadOnlyList<ObvPoint> obvCe, IReadOnlyList<ObvPoint> obvPe, IReadOnlyList<ObvPoint>? cdvCe = null, IReadOnlyList<ObvPoint>? cdvPe = null)
    {
        var spotBars = FlatSpotBars(20);
        var optionBars = spotBars.Select(b => new Candle(b.Time, 100m, 100.5m, 99.5m, 100m)).ToList();
        return new()
        {
            Underlying = "NIFTY",
            TimeframeMinutes = 1,
            Step = 50,
            SpotBars = spotBars,
            SpotBarsOneMinute = spotBars,
            SpotVolumeBarsOneMinute = spotBars.Select(b => new CandleWithVolume(b.Time, b.Open, b.High, b.Low, b.Close, 1000)).ToList(),
            ConfluenceSignalsAscending = Array.Empty<BacktestSignal>(),
            AllSignals = Array.Empty<BacktestSignal>(),
            ObvCeSeries = obvCe,
            ObvPeSeries = obvPe,
            CdvCeSeries = cdvCe ?? obvCe,
            CdvPeSeries = cdvPe ?? obvPe,
            GetOptionBars = (_, _) => optionBars,
            GetOptionBarsOneMinute = (_, _) => optionBars,
            AtmCeBars = Array.Empty<Candle>(),
            AtmPeBars = Array.Empty<Candle>(),
            AtmCeVolumeBars = Array.Empty<CandleWithVolume>(),
            AtmPeVolumeBars = Array.Empty<CandleWithVolume>(),
            AtmStrike = null,
        };
    }

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
            ["lookback1Bars"] = 2,
            ["threshold1Percent"] = 30,
            ["lookback2Bars"] = 3,
            ["threshold2Percent"] = 30,
            ["lookback3Bars"] = 4,
            ["threshold3Percent"] = 30,
            ["flowMode"] = FlowConfirmation.ModeEither,
        };
        overrides?.Invoke(p);
        return p;
    }

    [Fact]
    public void BullishFlow_FiresEntries_WhenCeRisesAndPeFallsAcrossAllThreeWindows()
    {
        // CE grows 10%/bar, PE decays 10%/bar - every bar's own %-change over 2/3/4 bars is a
        // constant ~21%/33%/46% (CE) and ~-19%/-27%/-34% (PE), giving a combined score around 60%,
        // comfortably clearing the 30% default threshold.
        var obvCe = ExponentialSeries(20, 100, 1.1m);
        var obvPe = ExponentialSeries(20, 100, 0.9m);

        var signals = new CdvObvFlowStrategy().EntrySignals(Context(obvCe, obvPe), Parameters());
        var entries = signals.Where(s => s.Kind == "Entry").ToList();

        Assert.NotEmpty(entries);
        Assert.All(entries, e => Assert.Equal("Bullish", e.Direction));
        // Bar index 4 is the first with enough history for the 4-bar window.
        Assert.Contains(entries, e => e.TimeUtc == T0.AddMinutes(4));
    }

    [Fact]
    public void BearishFlow_FiresEntries_WhenCeFallsAndPeRisesAcrossAllThreeWindows()
    {
        var obvCe = ExponentialSeries(20, 100, 0.9m);
        var obvPe = ExponentialSeries(20, 100, 1.1m);

        var signals = new CdvObvFlowStrategy().EntrySignals(Context(obvCe, obvPe), Parameters());
        var entries = signals.Where(s => s.Kind == "Entry").ToList();

        Assert.NotEmpty(entries);
        Assert.All(entries, e => Assert.Equal("Bearish", e.Direction));
    }

    [Fact]
    public void NoEntry_WhenNoWindowClearsItsOwnThreshold()
    {
        // A gentle 2%/bar move: the CE-PE spread over 2/3/4 bars is only ~8%/12%/16%, nowhere near
        // any window's own 30% default threshold.
        var obvCe = ExponentialSeries(20, 100, 1.02m);
        var obvPe = ExponentialSeries(20, 100, 0.98m);

        var signals = new CdvObvFlowStrategy().EntrySignals(Context(obvCe, obvPe), Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
    }

    [Fact]
    public void EachWindowsThresholdIsIndependentlyTunable_RaisingOneAloneBlocksAnOtherwiseValidEntry()
    {
        // Same 10%/bar CE growth and 10%/bar PE decay as BullishFlow_FiresEntries - window 2's own
        // spread (~60%, over its 3-bar lookback) clears its default 30% threshold comfortably, but
        // raising JUST threshold2Percent past that (to 90%) should block the whole bar, since ALL
        // THREE windows must clear their own threshold, not most of them.
        var obvCe = ExponentialSeries(20, 100, 1.1m);
        var obvPe = ExponentialSeries(20, 100, 0.9m);

        var signalsBefore = new CdvObvFlowStrategy().EntrySignals(Context(obvCe, obvPe), Parameters());
        var signalsAfter = new CdvObvFlowStrategy().EntrySignals(Context(obvCe, obvPe), Parameters(p => p["threshold2Percent"] = 90m));

        Assert.Contains(signalsBefore, s => s.Kind == "Entry"); // confirms the fixture would otherwise fire
        Assert.DoesNotContain(signalsAfter, s => s.Kind == "Entry");
    }

    [Fact]
    public void NoEntry_WhenTheWindowsDisagree_OneRisingOneFalling()
    {
        // A steady rise (100 + 10*bar) through bar 11, then bar 12 dips just BELOW bar 11 but stays
        // ABOVE bar 8 - so at bar 12 the 2-bar window reads a small FALL (195 vs bar-10's 200) while
        // the 3- and 4-bar windows still read a RISE (195 vs bar-9's 190, and vs bar-8's 180). Mixed
        // signs across the three windows means neither "rising in all three" (Bullish) nor "falling
        // in all three" (Bearish) holds - no entry either way at that bar, regardless of what PE
        // does (PE is a clean decay throughout, so it never becomes the reason for the mismatch).
        var obvCe = Enumerable.Range(0, 20).Select(i => new ObvPoint(T0.AddMinutes(i), i == 12 ? 195m : 100m + i * 10m)).ToList();
        var obvPe = ExponentialSeries(20, 100, 0.9m);

        var signals = new CdvObvFlowStrategy().EntrySignals(Context(obvCe, obvPe), Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry" && s.TimeUtc == T0.AddMinutes(12));
    }

    [Fact]
    public void Direction_ShortOnly_BlocksBullishEntries()
    {
        var obvCe = ExponentialSeries(20, 100, 1.1m);
        var obvPe = ExponentialSeries(20, 100, 0.9m);

        var signals = new CdvObvFlowStrategy().EntrySignals(Context(obvCe, obvPe), Parameters(p => p["direction"] = 2m /* ShortOnly */));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("bearish only"));
    }

    [Fact]
    public void FlowMode_ObvOnly_IgnoresCdvEvenWhenCdvAlsoConfirms()
    {
        // OBV confirms bullish; CDV is flat (no series movement -> PercentChange never computable,
        // so CDV's own agreement check always fails) - ObvOnly should still fire since it never
        // looks at CDV at all.
        var obvCe = ExponentialSeries(20, 100, 1.1m);
        var obvPe = ExponentialSeries(20, 100, 0.9m);
        var flatCdv = Enumerable.Range(0, 20).Select(i => new ObvPoint(T0.AddMinutes(i), 100m)).ToList();

        var signals = new CdvObvFlowStrategy().EntrySignals(
            Context(obvCe, obvPe, flatCdv, flatCdv), Parameters(p => p["flowMode"] = FlowConfirmation.ModeObvOnly));

        Assert.Contains(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
    }

    [Fact]
    public void FlowMode_Both_RequiresCdvToConfirmTooEvenWhenObvAlreadyDoes()
    {
        var obvCe = ExponentialSeries(20, 100, 1.1m);
        var obvPe = ExponentialSeries(20, 100, 0.9m);
        var flatCdv = Enumerable.Range(0, 20).Select(i => new ObvPoint(T0.AddMinutes(i), 100m)).ToList();

        var signals = new CdvObvFlowStrategy().EntrySignals(
            Context(obvCe, obvPe, flatCdv, flatCdv), Parameters(p => p["flowMode"] = FlowConfirmation.ModeBoth));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
    }

    [Fact]
    public void Simulate_TakesTradesOnTheBullishLeg_MatchingTheEntrySignals()
    {
        var obvCe = ExponentialSeries(20, 100, 1.1m);
        var obvPe = ExponentialSeries(20, 100, 0.9m);

        var trades = new CdvObvFlowStrategy().Simulate(Context(obvCe, obvPe), Parameters());

        Assert.NotEmpty(trades);
        Assert.All(trades, t => Assert.Equal("CE", t.OptionType)); // Buy + Bullish -> buy CE
    }
}

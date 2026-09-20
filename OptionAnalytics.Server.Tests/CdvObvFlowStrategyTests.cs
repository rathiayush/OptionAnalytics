using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers CdvObvFlowStrategy - see its own doc comment for why the ORIGINAL %-of-cumulative-
/// total measure was replaced with a normalized FlowScore (net window move / this leg's own recent
/// typical single-bar move), and why the exit rule is a continuous re-check of that same score
/// rather than a raw consecutive-falling-bars count.
///
/// Fixtures use small lookback windows (2/3/4 bars instead of the real 5/10/15) and a small
/// flowNormalizationBars (5 instead of 30) purely to keep them short. A CONSTANT-DELTA (arithmetic,
/// not exponential) series for CE/PE makes every window's own FlowScore exactly +-1.0 once there is
/// enough history - the net move over any window exactly equals windowBars times the (constant)
/// per-bar delta, and the normalizer is that same constant, so they cancel to 1.0 regardless of the
/// window length or the delta's own size. This is the direct proof the new measure is scale-
/// independent (unlike the old %-of-cumulative-total one).</summary>
public sealed class CdvObvFlowStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero);

    private static List<ObvPoint> ConstantSlopeSeries(int bars, decimal start, decimal deltaPerBar) =>
        Enumerable.Range(0, bars).Select(i => new ObvPoint(T0.AddMinutes(i), start + i * deltaPerBar)).ToList();

    private static List<Candle> FlatSpotBars(int bars) =>
        Enumerable.Range(0, bars).Select(i => new Candle(T0.AddMinutes(i), 20000m, 20000m, 20000m, 20000m)).ToList();

    private static BacktestStrategyContext Context(
        IReadOnlyList<ObvPoint> obvCe, IReadOnlyList<ObvPoint> obvPe, IReadOnlyList<ObvPoint>? cdvCe = null, IReadOnlyList<ObvPoint>? cdvPe = null,
        IReadOnlyList<Candle>? optionBarsOverride = null)
    {
        var spotBars = FlatSpotBars(30);
        var optionBars = optionBarsOverride ?? spotBars.Select(b => new Candle(b.Time, 100m, 100.5m, 99.5m, 100m)).ToList();
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
            OpenInterest = null,
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
            ["flowNormalizationBars"] = 5,
            ["flowMode"] = FlowConfirmation.ModeEither,
            ["flowExitLookbackBars"] = 0,
            ["flowExitThresholdPercent"] = 0,
        };
        overrides?.Invoke(p);
        return p;
    }

    [Fact]
    public void BullishFlow_FiresEntries_WhenCeRisesAndPeFallsConsistently()
    {
        // CE +1/bar, PE -1/bar - a perfectly consistent slope scores exactly +100%/-100% on every
        // window once there is enough history (index 5, since flowNormalizationBars=5 needs bars
        // 1..5), comfortably clearing the 30% default threshold.
        var obvCe = ConstantSlopeSeries(30, 100, 1);
        var obvPe = ConstantSlopeSeries(30, 100, -1);

        var signals = new CdvObvFlowStrategy().EntrySignals(Context(obvCe, obvPe), Parameters());
        var entries = signals.Where(s => s.Kind == "Entry").ToList();

        Assert.NotEmpty(entries);
        Assert.All(entries, e => Assert.Equal("Bullish", e.Direction));
        Assert.Contains(entries, e => e.TimeUtc == T0.AddMinutes(5));
    }

    [Fact]
    public void BearishFlow_FiresEntries_WhenCeFallsAndPeRisesConsistently()
    {
        var obvCe = ConstantSlopeSeries(30, 100, -1);
        var obvPe = ConstantSlopeSeries(30, 100, 1);

        var signals = new CdvObvFlowStrategy().EntrySignals(Context(obvCe, obvPe), Parameters());
        var entries = signals.Where(s => s.Kind == "Entry").ToList();

        Assert.NotEmpty(entries);
        Assert.All(entries, e => Assert.Equal("Bearish", e.Direction));
    }

    [Fact]
    public void NoEntry_WhenFlowIsChoppyRatherThanConsistentlyTrending()
    {
        // Both legs alternate +-5/4 deltas (mirrored) - a small net drift (+-1 every 2 bars) buried
        // in much bigger bar-to-bar noise (average |delta| ~4.6). This is exactly the "sideways/
        // choppy" case the OLD %-of-cumulative-total measure could not reliably reject (a growing
        // cumulative total still LOOKS like a rise by %), but the new normalized score correctly
        // scores each leg low (~+-10%, since the net move barely exceeds a single typical bar's own
        // noise) - spread stays well under the 30% threshold, so it's rejected. (Both legs choppy,
        // not just one - a lopsided fixture where only one leg is choppy while the other cleanly
        // trends would let the CLEAN leg's own strength carry the spread over threshold on its own,
        // which is a real but different case from "both sides are just noise".)
        var obvCe = new List<ObvPoint>();
        var obvPe = new List<ObvPoint>();
        decimal ceValue = 100;
        decimal peValue = 100;
        for (var i = 0; i < 30; i++)
        {
            obvCe.Add(new ObvPoint(T0.AddMinutes(i), ceValue));
            obvPe.Add(new ObvPoint(T0.AddMinutes(i), peValue));
            ceValue += i % 2 == 0 ? 5 : -4;
            peValue += i % 2 == 0 ? -5 : 4;
        }

        var signals = new CdvObvFlowStrategy().EntrySignals(Context(obvCe, obvPe), Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
    }

    [Fact]
    public void EachWindowsThresholdIsIndependentlyTunable_RaisingOneAloneBlocksAnOtherwiseValidEntry()
    {
        // Every window scores exactly 200% (CE +100% minus PE -100%) on the consistent-slope fixture -
        // raising JUST threshold2Percent past that (to 300%) should block the whole bar, since ALL
        // THREE windows must clear their own threshold, not most of them.
        var obvCe = ConstantSlopeSeries(30, 100, 1);
        var obvPe = ConstantSlopeSeries(30, 100, -1);

        var signalsBefore = new CdvObvFlowStrategy().EntrySignals(Context(obvCe, obvPe), Parameters());
        var signalsAfter = new CdvObvFlowStrategy().EntrySignals(Context(obvCe, obvPe), Parameters(p => p["threshold2Percent"] = 300m));

        Assert.Contains(signalsBefore, s => s.Kind == "Entry"); // confirms the fixture would otherwise fire
        Assert.DoesNotContain(signalsAfter, s => s.Kind == "Entry");
    }

    [Fact]
    public void Direction_ShortOnly_BlocksBullishEntries()
    {
        var obvCe = ConstantSlopeSeries(30, 100, 1);
        var obvPe = ConstantSlopeSeries(30, 100, -1);

        var signals = new CdvObvFlowStrategy().EntrySignals(Context(obvCe, obvPe), Parameters(p => p["direction"] = 2m /* ShortOnly */));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("bearish only"));
    }

    [Fact]
    public void FlowMode_ObvOnly_IgnoresCdvEvenWhenCdvAlsoConfirms()
    {
        // OBV confirms bullish; CDV is flat (no series movement -> AverageAbsBarDelta is 0, so
        // FlowScore is never computable, and CDV's own agreement check always fails) - ObvOnly
        // should still fire since it never looks at CDV at all.
        var obvCe = ConstantSlopeSeries(30, 100, 1);
        var obvPe = ConstantSlopeSeries(30, 100, -1);
        var flatCdv = Enumerable.Range(0, 30).Select(i => new ObvPoint(T0.AddMinutes(i), 100m)).ToList();

        var signals = new CdvObvFlowStrategy().EntrySignals(
            Context(obvCe, obvPe, flatCdv, flatCdv), Parameters(p => p["flowMode"] = FlowConfirmation.ModeObvOnly));

        Assert.Contains(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
    }

    [Fact]
    public void FlowMode_Both_RequiresCdvToConfirmTooEvenWhenObvAlreadyDoes()
    {
        var obvCe = ConstantSlopeSeries(30, 100, 1);
        var obvPe = ConstantSlopeSeries(30, 100, -1);
        var flatCdv = Enumerable.Range(0, 30).Select(i => new ObvPoint(T0.AddMinutes(i), 100m)).ToList();

        var signals = new CdvObvFlowStrategy().EntrySignals(
            Context(obvCe, obvPe, flatCdv, flatCdv), Parameters(p => p["flowMode"] = FlowConfirmation.ModeBoth));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
    }

    [Fact]
    public void Simulate_TakesTradesOnTheBullishLeg_MatchingTheEntrySignals()
    {
        var obvCe = ConstantSlopeSeries(30, 100, 1);
        var obvPe = ConstantSlopeSeries(30, 100, -1);

        var trades = new CdvObvFlowStrategy().Simulate(Context(obvCe, obvPe), Parameters());

        Assert.NotEmpty(trades);
        Assert.All(trades, t => Assert.Equal("CE", t.OptionType)); // Buy + Bullish -> buy CE
    }

    // CE rises at a constant +1/bar through index 8, then goes perfectly FLAT (no further change)
    // from index 9 onward - directly "flowing in my direction, then goes sideways", the user's own
    // framing for when they want out.
    private static List<ObvPoint> RisingThenFlatCe()
    {
        var series = new List<ObvPoint>();
        for (var i = 0; i <= 8; i++) series.Add(new ObvPoint(T0.AddMinutes(i), 100 + i));
        for (var i = 9; i < 30; i++) series.Add(new ObvPoint(T0.AddMinutes(i), 108m));
        return series;
    }

    [Fact]
    public void Simulate_ExitsAsFlowStopLoss_WhenTheRisingLegGoesSideways()
    {
        var obvCe = RisingThenFlatCe();
        var obvPe = ConstantSlopeSeries(30, 100, -1); // unrelated to this check - a Bullish trade only watches CE

        var trades = new CdvObvFlowStrategy().Simulate(Context(obvCe, obvPe), Parameters(p =>
        {
            p["flowExitLookbackBars"] = 2;
            p["flowExitThresholdPercent"] = 0;
        }));

        var trade = trades.Single(t => t.SignalTimeUtc == T0.AddMinutes(5));
        Assert.Equal("FlowStopLoss", trade.ExitReason);
        // The 2-bar window's own net move first reaches exactly 0 once it sits entirely inside the
        // flat region, at index 10 - the option bar there triggers the exit, whose own real close
        // instant is one bar later.
        Assert.Equal(T0.AddMinutes(11), trade.ExitTimeUtc);
    }

    [Fact]
    public void Simulate_ProfitableTrade_RidesPastAFlowWeakBar_ThenExitsOnceProfitFades()
    {
        // Per explicit request: a weakening flow should never override a trade already ahead. Same
        // entry/flow-weak timing as Simulate_ExitsAsFlowStopLoss_WhenTheRisingLegGoesSideways (the
        // flow-weak deadline lands at bar 10, unaffected by option premium), but this time the
        // premium is IN PROFIT (110 vs a 100 entry) right at bars 10-11 - the exit must be skipped
        // there. Bar 12 drops to 95 (no longer in profit, but not the ordinary 10-point stop either)
        // - the flow exit fires there instead.
        var obvCe = RisingThenFlatCe();
        var obvPe = ConstantSlopeSeries(30, 100, -1);
        var optionBars = FlatSpotBars(30).Select((b, i) => i switch
        {
            < 10 => new Candle(b.Time, 100m, 100.5m, 99.5m, 100m), // entry fills at 100
            < 12 => new Candle(b.Time, 110m, 110.5m, 109.5m, 110m), // in profit - flow exit must be skipped
            _ => new Candle(b.Time, 95m, 95.5m, 94.5m, 95m), // profit faded - flow exit can fire now
        }).ToList();

        var trades = new CdvObvFlowStrategy().Simulate(Context(obvCe, obvPe, optionBarsOverride: optionBars), Parameters(p =>
        {
            p["flowExitLookbackBars"] = 2;
            p["flowExitThresholdPercent"] = 0;
        }));

        var trade = trades.Single(t => t.SignalTimeUtc == T0.AddMinutes(5));
        Assert.Equal("FlowStopLoss", trade.ExitReason);
        Assert.Equal(95m, trade.ExitPrice);
        Assert.Equal(T0.AddMinutes(13), trade.ExitTimeUtc); // bar 12's own real close instant
    }

    [Fact]
    public void Simulate_FlowExitDisabledByDefault_NeverFiresFlowStopLoss()
    {
        var obvCe = RisingThenFlatCe();
        var obvPe = ConstantSlopeSeries(30, 100, -1);

        // Same fixture as above, but flowExitLookbackBars is left off (0, the default).
        var trades = new CdvObvFlowStrategy().Simulate(Context(obvCe, obvPe), Parameters());

        var trade = trades.Single(t => t.SignalTimeUtc == T0.AddMinutes(5));
        Assert.NotEqual("FlowStopLoss", trade.ExitReason);
    }

    [Fact]
    public void Simulate_BearishTrade_MonitorsPeForTheReversal_NotCe()
    {
        var obvPe = RisingThenFlatCe();
        var obvCe = ConstantSlopeSeries(30, 100, -1);

        var trades = new CdvObvFlowStrategy().Simulate(Context(obvCe, obvPe), Parameters(p =>
        {
            p["flowExitLookbackBars"] = 2;
            p["flowExitThresholdPercent"] = 0;
        }));

        var trade = trades.Single(t => t.SignalTimeUtc == T0.AddMinutes(5));
        Assert.Equal("PE", trade.OptionType); // Buy + Bearish -> buy PE
        Assert.Equal("FlowStopLoss", trade.ExitReason);
        Assert.Equal(T0.AddMinutes(11), trade.ExitTimeUtc);
    }

    [Fact]
    public void Simulate_OnAMultiWeekBacktest_CompletesInLinearRatherThanQuadraticTime()
    {
        // A real "why is this taking so long" report traced to FlowScore/AverageAbsBarDelta each
        // doing a fresh linear scan (BacktestUtil.LastValueAtOrBefore) per lookup, called ~12 times
        // per bar with a 30-bar trailing average each - effectively quadratic over a multi-day
        // backtest. Fixed by aligning each series to bar indices once (SeriesStats) and reading a
        // precomputed prefix sum instead. 20,000 bars is roughly 7 weeks of 1-minute data - the
        // previous O(bars^2) approach took tens of seconds to minutes at this size in a local
        // repro; a generous 5-second ceiling here easily separates "still linear" from "regressed
        // back to quadratic" without being flaky on a slower CI box.
        const int bars = 20_000;
        var obvCe = ConstantSlopeSeries(bars, 100, 1);
        var obvPe = ConstantSlopeSeries(bars, 100, -1);
        var spotBars = Enumerable.Range(0, bars).Select(i => new Candle(T0.AddMinutes(i), 20000m, 20000m, 20000m, 20000m)).ToList();
        var optionBars = spotBars.Select(b => new Candle(b.Time, 100m, 100.5m, 99.5m, 100m)).ToList();
        var context = new BacktestStrategyContext
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
            CdvCeSeries = obvCe,
            CdvPeSeries = obvPe,
            GetOptionBars = (_, _) => optionBars,
            GetOptionBarsOneMinute = (_, _) => optionBars,
            AtmCeBars = Array.Empty<Candle>(),
            AtmPeBars = Array.Empty<Candle>(),
            AtmCeVolumeBars = Array.Empty<CandleWithVolume>(),
            AtmPeVolumeBars = Array.Empty<CandleWithVolume>(),
            AtmStrike = null,
            OpenInterest = null,
        };

        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        var trades = new CdvObvFlowStrategy().Simulate(context, Parameters(p => p["flowExitLookbackBars"] = 3));
        stopwatch.Stop();

        Assert.NotEmpty(trades);
        Assert.True(stopwatch.ElapsedMilliseconds < 5000, $"took {stopwatch.ElapsedMilliseconds}ms - expected O(bars), not O(bars^2)");
    }
}

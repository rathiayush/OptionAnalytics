using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// A pure order-flow momentum strategy (the user's own plan): CE's OBV/CDV rising while PE's is
/// falling means bullish flow (the mirror means bearish), measured across THREE lookback windows
/// (5/10/15 bars by default), EACH WITH ITS OWN THRESHOLD.
///
/// REWORKED after the first cut ("this isn't returning good results") - the actual bug, not just
/// mistuned numbers: OBV/CDV are CUMULATIVE RUNNING TOTALS, and the first cut measured a window's
/// move as a PERCENTAGE of that running total. That is not a stable measure through a session - early
/// in the day the running total sits near zero, so even a tiny real move reads as a huge (or
/// undefined - a near-zero/sign-flipped base was rejected outright) percentage; late in the day the
/// total has grown large, so the SAME real move reads as a tiny, easily-missed percentage. A single
/// tunable threshold cannot mean the same thing at both ends of the same day.
///
/// The fix: measure each window's own NET flow as a RAW DELTA (value now minus value N bars ago -
/// mathematically just the sum of that window's own per-bar deltas, since the series is a running
/// total), then NORMALIZE it against this leg's own recent "typical single-bar move"
/// (FlowNormalizationBars, the average |bar-over-bar change| over that many trailing bars) rather
/// than against the cumulative total itself. The result - FlowScore - is a dimensionless ratio stable
/// across the whole session: roughly 1.0 means "this window moved about as much as you'd expect if
/// EVERY bar in it pushed the same direction by one typical bar's worth", 0 means no net progress
/// (sideways/choppy), negative means net decline - regardless of what the day's cumulative total
/// happens to be at that moment.
///
/// Per window w: CE's FlowScore has to be positive AND PE's negative, AND the combined spread
/// (CeScore_w - PeScore_w) has to clear THAT window's own Threshold(1/2/3)Percent. ALL THREE windows
/// have to pass their own check - not an average - so raising one window's own threshold tightens
/// only that window. Bearish is the exact mirror. Which of OBV/CDV (or both, or either) has to
/// confirm is the existing FlowConfirmation.ModeParameter toggle every other strategy here uses.
///
/// DISPLAYED AS A PERCENTAGE, per explicit request - the raw 0-ish-to-1-ish ratio FlowScore itself
/// returns (see above: 1.0 = "moved like every bar pushed one typical bar's worth") reads awkwardly
/// next to this app's other percent-based parameters, so every threshold and the summary text below
/// multiply it by 100 (0.3 becomes "30%", 1.0 becomes "100%") purely for a familiar unit. This is
/// NOT a reintroduction of the ORIGINAL bug (see above) - that measured a window's move as a percent
/// of OBV/CDV's own cumulative running total, which is what actually drifted through the day; this
/// percent is still computed from the exact same scale-stable FlowScore ratio, just relabeled.
///
/// EXIT: STOP/TARGET are the standard shared points-based 10/20 (1:2) default. OPTIONAL on top
/// (FlowExitLookbackBars, 0 = off, the default) - directly the user's own stated trading style:
/// "I want the lookback bars to keep flowing in my direction; the moment it goes sideways or starts
/// falling, I get out." Once in a trade, the SAME leg that justified entry (CE for Bullish, PE for
/// Bearish) has its OWN FlowScore recomputed EVERY bar over this (typically shorter, more reactive)
/// window; the instant that score (again as a %) drops to or below FlowExitThresholdPercent (0 =
/// sideways-or-worse, the default), the trade exits immediately as a stop-loss rather than waiting for
/// the premium's own
/// stop/target to eventually catch up. This replaces the first cut's cruder "N raw consecutive
/// falling bars" rule with the same lookback-window measure entry itself uses, continuously
/// re-checked - and which measure's own weakness counts is, again, the same FlowMode toggle.
///
/// This flow-based stop-loss only ever cuts a LOSING (or breakeven) trade short - per explicit
/// request ("when strategy is in profit do not hit flow SL"), it never fires on a bar where the
/// trade is CURRENTLY ahead on premium (see OptionTradeSimulator.Run's own
/// ignoreSignalExitsWhileInProfit). A trade already in profit rides on toward its own stop/target/
/// day-close instead, even while the flow itself has gone sideways or reversed; the flow check
/// keeps watching every subsequent bar too, so it can still fire later if that profit fades back out.
///
/// PERFORMANCE: the naive way to answer "what was this series' value at bar i" - a fresh linear scan
/// (BacktestUtil.LastValueAtOrBefore) from the start of the series every single time - is what every
/// OTHER strategy here does too, but they only ever call it once or twice per bar. This strategy calls
/// it far more (3 windows x CE/PE x OBV/CDV, each also needing a 30-bar trailing average), which
/// turned a per-bar cost that is normally trivial into a genuinely quadratic one over a multi-day
/// backtest (confirmed as the actual cause of a real "why is this taking so long" report). Fixed by
/// ALIGNING each series to context.SpotBars' own bar indices ONCE up front (SeriesStats, a single
/// forward merge-scan - both a series and SpotBars are already time-ascending, so this never
/// backtracks) and precomputing a running prefix sum of the per-bar |delta| alongside it, so both a
/// window's own value lookup AND its normalizer's trailing average become a handful of array reads
/// and a subtraction - O(1) per FlowScore call instead of O(bars) - rather than changing anything
/// about what the strategy actually computes.
///
/// That fix alone was not enough: BuildFlowExits still walked forward from EVERY entry's own bar
/// looking for its first weak bar, and on a strongly one-directional session (continuous entries,
/// the flow never actually weakening for a long stretch) that is itself O(entries x bars) - measured
/// at 85 SECONDS for a 20,000-bar (roughly 7-week) backtest even after the first fix. Whether bar j
/// is weak never depends on which entry is asking, only on j itself, so ComputeNextWeakBar computes
/// it ONCE per leg direction via a single backward pass (bars.Count-1 down to 0, carrying the nearest
/// weak index forward) - every entry's own exit then becomes a single O(1) array read into that
/// shared result instead of its own independent forward walk.
/// </summary>
public sealed class CdvObvFlowStrategy : IBacktestStrategy
{
    public string Key => "cdv-obv-flow";
    public string Name => "CDV/OBV Rising/Falling Flow Momentum";
    public string Description => "CE's OBV/CDV rising while PE's is falling (or the mirror) across ALL of three lookback windows (5/10/15 bars by default) is the signal, each window scored as a % of a typical single bar's own move (NOT a raw % of the cumulative OBV/CDV total, which drifts through the day) against its own threshold. Optionally exits as a stop-loss the moment that same flow goes sideways or reverses while held.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.StopLossParameter(),
        OptionTradeSimulator.TakeProfitParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        OptionTradeSimulator.SignalStartTimeParameter(),
        OptionTradeSimulator.ExcludeLastDaysParameter(),
        OptionTradeSimulator.MaxHoldingTimeParameter(),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Bullish only"),
            new BacktestParameterOption(DirectionShortOnly, "Bearish only"),
        }),
        new BacktestParameterSpec("lookback1Bars", "Lookback window 1 (bars)", Default: 5, Min: 1, Max: 200, Step: 1),
        new BacktestParameterSpec("threshold1Percent", "Window 1's own flow score must reach at least (%)", Default: 30, Min: 0, Max: 500, Step: 5),
        new BacktestParameterSpec("lookback2Bars", "Lookback window 2 (bars)", Default: 10, Min: 1, Max: 200, Step: 1),
        new BacktestParameterSpec("threshold2Percent", "Window 2's own flow score must reach at least (%)", Default: 30, Min: 0, Max: 500, Step: 5),
        new BacktestParameterSpec("lookback3Bars", "Lookback window 3 (bars)", Default: 15, Min: 1, Max: 200, Step: 1),
        new BacktestParameterSpec("threshold3Percent", "Window 3's own flow score must reach at least (%)", Default: 30, Min: 0, Max: 500, Step: 5),
        new BacktestParameterSpec("flowNormalizationBars", "\"Typical single-bar move\" measured over (bars)", Default: 30, Min: 5, Max: 200, Step: 5),
        FlowConfirmation.ModeParameter("Require rising/falling agreement on"),
        new BacktestParameterSpec("flowExitLookbackBars", "Continuously re-check flow over (bars, 0 = off)", Default: 0, Min: 0, Max: 200, Step: 1),
        new BacktestParameterSpec("flowExitThresholdPercent", "Exit as stop-loss once that re-check score falls to or below (%)", Default: 0, Min: -500, Max: 500, Step: 5),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var evaluation = Evaluate(context, parameters);
        var flowExitLookbackBars = (int)parameters.GetValueOrDefault("flowExitLookbackBars", 0m);
        var flowExitThresholdPercent = parameters.GetValueOrDefault("flowExitThresholdPercent", 0m);
        var flowMode = parameters.GetValueOrDefault("flowMode", FlowConfirmation.ModeEither);
        var normalizationBars = Math.Max(1, (int)parameters.GetValueOrDefault("flowNormalizationBars", 30m));
        var signalExits = flowExitLookbackBars > 0
            ? BuildFlowExits(context, evaluation.EntryIndexes, evaluation.ObvCe, evaluation.ObvPe, evaluation.CdvCe, evaluation.CdvPe, flowExitLookbackBars, flowExitThresholdPercent, flowMode, normalizationBars)
            : null;
        // Per explicit request: a weakening flow should cut a LOSING trade short, never override one
        // already ahead - see Run's own doc comment on ignoreSignalExitsWhileInProfit.
        return OptionTradeSimulator.Run(context, evaluation.Entries, parameters, signalExits: signalExits, ignoreSignalExitsWhileInProfit: true);
    }

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private readonly record struct LookbackWindow(int Bars, decimal ThresholdPercent);

    /// <summary>One series' value at every one of context.SpotBars' own bar indices (Values[i] =
    /// BacktestUtil.LastValueAtOrBefore(series, bars[i].Time), but computed via a single forward
    /// merge-scan instead of a fresh linear scan per bar - both series and bars are already
    /// time-ascending, so one cursor into series only ever needs to move forward as i increases), plus
    /// a running prefix sum (and count, since a gap leaves a bar's own delta undefined) of the
    /// bar-over-bar |delta| - see this class's own doc comment for why. AbsDeltaSumPrefix[i]/
    /// AbsDeltaCountPrefix[i] cover deltas at indices 1..i (index 0 has no prior bar, so no delta of
    /// its own); both are 0 at index 0.</summary>
    private readonly record struct SeriesStats(decimal?[] Values, decimal[] AbsDeltaSumPrefix, int[] AbsDeltaCountPrefix);

    private static SeriesStats BuildSeriesStats(IReadOnlyList<ObvPoint> series, IReadOnlyList<Candle> bars)
    {
        var values = new decimal?[bars.Count];
        var sumPrefix = new decimal[bars.Count];
        var countPrefix = new int[bars.Count];

        var cursor = 0;
        decimal? current = null;
        for (var i = 0; i < bars.Count; i++)
        {
            while (cursor < series.Count && series[cursor].Time <= bars[i].Time)
            {
                current = series[cursor].Obv;
                cursor++;
            }
            values[i] = current;

            if (i > 0)
            {
                var delta = values[i] is { } now && values[i - 1] is { } prev ? (decimal?)Math.Abs(now - prev) : null;
                sumPrefix[i] = sumPrefix[i - 1] + (delta ?? 0);
                countPrefix[i] = countPrefix[i - 1] + (delta.HasValue ? 1 : 0);
            }
        }

        return new SeriesStats(values, sumPrefix, countPrefix);
    }

    /// <summary>The recent "typical single-bar move" for one series ending at bar index i - the mean
    /// of |value(k) - value(k-1)| over the trailing <paramref name="lookbackBars"/> native chart
    /// bars, read off the precomputed prefix sums in O(1). Null until there is enough history, or if
    /// every one of those bars was itself unreadable - a normalizer of zero/unknown scale can never
    /// produce a meaningful ratio.</summary>
    private static decimal? AverageAbsBarDelta(SeriesStats stats, int i, int lookbackBars)
    {
        var start = i - lookbackBars + 1;
        if (start < 1) return null;

        var sum = stats.AbsDeltaSumPrefix[i] - stats.AbsDeltaSumPrefix[start - 1];
        var count = stats.AbsDeltaCountPrefix[i] - stats.AbsDeltaCountPrefix[start - 1];
        return count > 0 ? sum / count : null;
    }

    /// <summary>windowBars' own net move (value now minus value windowBars bars ago), normalized by
    /// this same series' own recent typical single-bar move - see this class's own doc comment for
    /// why this replaces a raw percentage of the cumulative total. Null when there is not yet enough
    /// history for either the window or the normalizer, or the normalizer itself is zero (a flat
    /// series has no "typical move" to divide by).</summary>
    private static decimal? FlowScore(SeriesStats stats, int i, int windowBars, int normalizationBars)
    {
        if (i - windowBars < 0) return null;
        if (stats.Values[i] is not { } now) return null;
        if (stats.Values[i - windowBars] is not { } earlier) return null;
        if (AverageAbsBarDelta(stats, i, normalizationBars) is not { } avgAbs || avgAbs <= 0) return null;

        return (now - earlier) / (avgAbs * windowBars);
    }

    /// <summary>Every window's own CE/PE FlowScore check at one bar - confirmed only when EVERY
    /// window's own direction AND own threshold both hold; a single missing reading, wrong-direction
    /// window, or under-threshold window anywhere fails the whole leg. ceScore/peScore/spread are all
    /// FlowScore x 100 (a %) here, purely for a familiar unit - see this class's own doc comment.</summary>
    private static (bool BullishConfirmed, bool BearishConfirmed, IReadOnlyList<decimal> WindowScores) EvaluateLeg(
        SeriesStats ceStats, SeriesStats peStats, int i, IReadOnlyList<LookbackWindow> windows, int normalizationBars)
    {
        var bullishConfirmed = true;
        var bearishConfirmed = true;
        var scores = new decimal[windows.Count];

        for (var w = 0; w < windows.Count; w++)
        {
            var ce = FlowScore(ceStats, i, windows[w].Bars, normalizationBars);
            var pe = FlowScore(peStats, i, windows[w].Bars, normalizationBars);
            if (ce is not { } ceScore || pe is not { } peScore) return (false, false, scores);

            var spread = ceScore * 100m - peScore * 100m; // CE rising / PE falling both push this positive; the mirror pushes it negative.
            scores[w] = spread;

            if (!(ceScore > 0 && peScore < 0 && spread >= windows[w].ThresholdPercent)) bullishConfirmed = false;
            if (!(ceScore < 0 && peScore > 0 && -spread >= windows[w].ThresholdPercent)) bearishConfirmed = false;
        }

        return (bullishConfirmed, bearishConfirmed, scores);
    }

    /// <summary>For ONE leg (CE for Bullish entries, PE for Bearish), the nearest bar at or after
    /// EVERY index j where the flow has gone weak - a single BACKWARD pass (bars.Count-1 down to 0)
    /// carrying the most recent weak index forward, so "where does entry X's own exit land" becomes
    /// an O(1) array read afterward instead of walking forward from every entry independently.
    /// Whether the flow is weak at any one bar depends only on that bar's own FlowScore, never on
    /// which entry is asking - a dense run of entries (a strongly one-directional session, exactly
    /// the case that made this necessary - see this class's own doc comment on the quadratic
    /// per-entry forward walk this replaced) would otherwise redo most of the same walk once per
    /// entry.</summary>
    private static int?[] ComputeNextWeakBar(SeriesStats obvStats, SeriesStats cdvStats, int exitLookbackBars, decimal exitThresholdPercent, decimal flowMode, int normalizationBars, int barCount)
    {
        var nextWeak = new int?[barCount];
        int? nearest = null;
        for (var j = barCount - 1; j >= 0; j--)
        {
            // x 100 - the same % unit every threshold here uses, see this class's own doc comment.
            var obvWeak = FlowScore(obvStats, j, exitLookbackBars, normalizationBars) is { } ov && ov * 100m <= exitThresholdPercent;
            var cdvWeak = FlowScore(cdvStats, j, exitLookbackBars, normalizationBars) is { } cv && cv * 100m <= exitThresholdPercent;
            if (FlowConfirmation.Confirms(flowMode, obvWeak, cdvWeak)) nearest = j;
            nextWeak[j] = nearest;
        }
        return nextWeak;
    }

    /// <summary>The FIRST bar after each entry's own bar where the SAME leg that justified it (CE for
    /// Bullish, PE for Bearish) has gone weak becomes that trade's forced exit (not a further bar
    /// after it, consistent with every other forced-exit mechanism in this app) - a not-yet-computable
    /// score (not enough history right after entry) can never itself justify an exit, and
    /// ComputeNextWeakBar's own "no weak bar found" (null) leaves a trade with no forced exit at all,
    /// same as before. Takes the SAME SeriesStats Evaluate already built rather than rebuilding
    /// them.</summary>
    private static Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)> BuildFlowExits(
        BacktestStrategyContext context, IReadOnlyList<(int Index, DateTimeOffset Time, bool Bullish)> entryIndexes,
        SeriesStats obvCe, SeriesStats obvPe, SeriesStats cdvCe, SeriesStats cdvPe,
        int exitLookbackBars, decimal exitThresholdPercent, decimal flowMode, int normalizationBars)
    {
        var exits = new Dictionary<DateTimeOffset, (DateTimeOffset, string)>();
        var bars = context.SpotBars;
        var nextWeakBullish = ComputeNextWeakBar(obvCe, cdvCe, exitLookbackBars, exitThresholdPercent, flowMode, normalizationBars, bars.Count);
        var nextWeakBearish = ComputeNextWeakBar(obvPe, cdvPe, exitLookbackBars, exitThresholdPercent, flowMode, normalizationBars, bars.Count);

        foreach (var (entryIndex, entryTime, bullish) in entryIndexes)
        {
            var nextWeak = bullish ? nextWeakBullish : nextWeakBearish;
            if (entryIndex + 1 < bars.Count && nextWeak[entryIndex + 1] is { } weakIndex)
            {
                exits[entryTime] = (bars[weakIndex].Time, "FlowStopLoss");
            }
        }

        return exits;
    }

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals,
        List<(int Index, DateTimeOffset Time, bool Bullish)> EntryIndexes,
        SeriesStats ObvCe, SeriesStats ObvPe, SeriesStats CdvCe, SeriesStats CdvPe) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var direction = parameters["direction"];
        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);
        var normalizationBars = Math.Max(1, (int)parameters.GetValueOrDefault("flowNormalizationBars", 30m));
        var windows = new[]
        {
            new LookbackWindow(Math.Max(1, (int)parameters["lookback1Bars"]), parameters.GetValueOrDefault("threshold1Percent", 30m)),
            new LookbackWindow(Math.Max(1, (int)parameters["lookback2Bars"]), parameters.GetValueOrDefault("threshold2Percent", 30m)),
            new LookbackWindow(Math.Max(1, (int)parameters["lookback3Bars"]), parameters.GetValueOrDefault("threshold3Percent", 30m)),
        };
        var flowMode = parameters.GetValueOrDefault("flowMode", FlowConfirmation.ModeEither);

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();
        var entryIndexes = new List<(int Index, DateTimeOffset Time, bool Bullish)>();

        var bars = context.SpotBars;
        var obvCeStats = BuildSeriesStats(context.ObvCeSeries, bars);
        var obvPeStats = BuildSeriesStats(context.ObvPeSeries, bars);
        var cdvCeStats = BuildSeriesStats(context.CdvCeSeries, bars);
        var cdvPeStats = BuildSeriesStats(context.CdvPeSeries, bars);
        if (bars.Count == 0) return (entries, signals, entryIndexes, obvCeStats, obvPeStats, cdvCeStats, cdvPeStats);

        for (var i = 0; i < bars.Count; i++)
        {
            var bar = bars[i];
            var beforeSignalStart = signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes;

            var obv = EvaluateLeg(obvCeStats, obvPeStats, i, windows, normalizationBars);
            var cdv = EvaluateLeg(cdvCeStats, cdvPeStats, i, windows, normalizationBars);

            var bullish = FlowConfirmation.Confirms(flowMode, obv.BullishConfirmed, cdv.BullishConfirmed);
            var bearish = FlowConfirmation.Confirms(flowMode, obv.BearishConfirmed, cdv.BearishConfirmed);
            if (!bullish && !bearish) continue;

            // Both directions confirming at once is not a real, actionable signal either way -
            // skipped outright rather than arbitrarily picking one side.
            if (bullish && bearish) continue;

            var dir = bullish ? "Bullish" : "Bearish";
            // Report whichever of OBV/CDV actually confirmed this direction (both, under ModeBoth) -
            // purely for a readable summary, not part of the decision itself.
            var obvConfirmedThisDirection = bullish ? obv.BullishConfirmed : obv.BearishConfirmed;
            var scores = obvConfirmedThisDirection ? obv.WindowScores : cdv.WindowScores;
            var windowBreakdown = string.Join(", ", windows.Select((win, i) => $"{win.Bars}-bar {(bullish ? scores[i] : -scores[i]):0.#}%>={win.ThresholdPercent:0.#}%"));
            var summary = $"CE {(bullish ? "rising" : "falling")} / PE {(bullish ? "falling" : "rising")} clearing its own threshold on all of {windows[0].Bars}/{windows[1].Bars}/{windows[2].Bars} bars ({FlowConfirmation.ModeLabel(flowMode)}): {windowBreakdown}";

            if (beforeSignalStart)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
            }
            else if (bullish && !takeLongs)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{summary} - skipped, bearish only"));
            }
            else if (bearish && !takeShorts)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{summary} - skipped, bullish only"));
            }
            else
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", dir, summary));
                entries.Add((bar.Time, dir));
                entryIndexes.Add((i, bar.Time, bullish));
            }
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList(), entryIndexes, obvCeStats, obvPeStats, cdvCeStats, cdvPeStats);
    }
}

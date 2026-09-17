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
/// (CeScore_w - PeScore_w) has to clear THAT window's own Threshold(1/2/3)Score. ALL THREE windows
/// have to pass their own check - not an average - so raising one window's own threshold tightens
/// only that window. Bearish is the exact mirror. Which of OBV/CDV (or both, or either) has to
/// confirm is the existing FlowConfirmation.ModeParameter toggle every other strategy here uses.
///
/// EXIT: STOP/TARGET are the standard shared points-based 10/20 (1:2) default. OPTIONAL on top
/// (FlowExitLookbackBars, 0 = off, the default) - directly the user's own stated trading style:
/// "I want the lookback bars to keep flowing in my direction; the moment it goes sideways or starts
/// falling, I get out." Once in a trade, the SAME leg that justified entry (CE for Bullish, PE for
/// Bearish) has its OWN FlowScore recomputed EVERY bar over this (typically shorter, more reactive)
/// window; the instant that score drops to or below FlowExitThresholdScore (0 = sideways-or-worse,
/// the default), the trade exits immediately as a stop-loss rather than waiting for the premium's own
/// stop/target to eventually catch up. This replaces the first cut's cruder "N raw consecutive
/// falling bars" rule with the same lookback-window measure entry itself uses, continuously
/// re-checked - and which measure's own weakness counts is, again, the same FlowMode toggle.
/// </summary>
public sealed class CdvObvFlowStrategy : IBacktestStrategy
{
    public string Key => "cdv-obv-flow";
    public string Name => "CDV/OBV Rising/Falling Flow Momentum";
    public string Description => "CE's OBV/CDV rising while PE's is falling (or the mirror) across ALL of three lookback windows (5/10/15 bars by default) is the signal, each window scored as a normalized ratio (not a raw % of the cumulative total, which drifts through the day) against its own threshold. Optionally exits as a stop-loss the moment that same flow goes sideways or reverses while held.";

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
        new BacktestParameterSpec("threshold1Score", "Window 1's own flow score must reach at least", Default: 0.3m, Min: 0, Max: 5, Step: 0.05m),
        new BacktestParameterSpec("lookback2Bars", "Lookback window 2 (bars)", Default: 10, Min: 1, Max: 200, Step: 1),
        new BacktestParameterSpec("threshold2Score", "Window 2's own flow score must reach at least", Default: 0.3m, Min: 0, Max: 5, Step: 0.05m),
        new BacktestParameterSpec("lookback3Bars", "Lookback window 3 (bars)", Default: 15, Min: 1, Max: 200, Step: 1),
        new BacktestParameterSpec("threshold3Score", "Window 3's own flow score must reach at least", Default: 0.3m, Min: 0, Max: 5, Step: 0.05m),
        new BacktestParameterSpec("flowNormalizationBars", "\"Typical single-bar move\" measured over (bars)", Default: 30, Min: 5, Max: 200, Step: 5),
        FlowConfirmation.ModeParameter("Require rising/falling agreement on"),
        new BacktestParameterSpec("flowExitLookbackBars", "Continuously re-check flow over (bars, 0 = off)", Default: 0, Min: 0, Max: 200, Step: 1),
        new BacktestParameterSpec("flowExitThresholdScore", "Exit as stop-loss once that re-check score falls to or below", Default: 0, Min: -5, Max: 5, Step: 0.05m),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var evaluation = Evaluate(context, parameters);
        var flowExitLookbackBars = (int)parameters.GetValueOrDefault("flowExitLookbackBars", 0m);
        var flowExitThresholdScore = parameters.GetValueOrDefault("flowExitThresholdScore", 0m);
        var flowMode = parameters.GetValueOrDefault("flowMode", FlowConfirmation.ModeEither);
        var normalizationBars = Math.Max(1, (int)parameters.GetValueOrDefault("flowNormalizationBars", 30m));
        var signalExits = flowExitLookbackBars > 0
            ? BuildFlowExits(context, evaluation.EntryIndexes, flowExitLookbackBars, flowExitThresholdScore, flowMode, normalizationBars)
            : null;
        return OptionTradeSimulator.Run(context, evaluation.Entries, parameters, signalExits: signalExits);
    }

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private readonly record struct LookbackWindow(int Bars, decimal ThresholdScore);

    /// <summary>The recent "typical single-bar move" for one series ending at bar index i - the mean
    /// of |value(k) - value(k-1)| over the trailing <paramref name="lookbackBars"/> native chart
    /// bars. Null until there is enough history, or if every one of those bars was itself unreadable
    /// (BacktestUtil.LastValueAtOrBefore missing a point) - a normalizer of zero/unknown scale can
    /// never produce a meaningful ratio.</summary>
    private static decimal? AverageAbsBarDelta(IReadOnlyList<ObvPoint> series, IReadOnlyList<Candle> bars, int i, int lookbackBars)
    {
        var start = i - lookbackBars + 1;
        if (start < 1) return null;

        decimal sum = 0;
        var count = 0;
        for (var k = start; k <= i; k++)
        {
            if (BacktestUtil.LastValueAtOrBefore(series, bars[k].Time) is not { } now) continue;
            if (BacktestUtil.LastValueAtOrBefore(series, bars[k - 1].Time) is not { } prev) continue;
            sum += Math.Abs(now - prev);
            count++;
        }
        return count > 0 ? sum / count : null;
    }

    /// <summary>windowBars' own net move (value now minus value windowBars bars ago), normalized by
    /// this same series' own recent typical single-bar move - see this class's own doc comment for
    /// why this replaces a raw percentage of the cumulative total. Null when there is not yet enough
    /// history for either the window or the normalizer, or the normalizer itself is zero (a flat
    /// series has no "typical move" to divide by).</summary>
    private static decimal? FlowScore(IReadOnlyList<ObvPoint> series, IReadOnlyList<Candle> bars, int i, int windowBars, int normalizationBars)
    {
        if (i - windowBars < 0) return null;
        if (BacktestUtil.LastValueAtOrBefore(series, bars[i].Time) is not { } now) return null;
        if (BacktestUtil.LastValueAtOrBefore(series, bars[i - windowBars].Time) is not { } earlier) return null;
        if (AverageAbsBarDelta(series, bars, i, normalizationBars) is not { } avgAbs || avgAbs <= 0) return null;

        return (now - earlier) / (avgAbs * windowBars);
    }

    /// <summary>Every window's own CE/PE FlowScore check at one bar - confirmed only when EVERY
    /// window's own direction AND own threshold both hold; a single missing reading, wrong-direction
    /// window, or under-threshold window anywhere fails the whole leg.</summary>
    private static (bool BullishConfirmed, bool BearishConfirmed, IReadOnlyList<decimal> WindowScores) EvaluateLeg(
        IReadOnlyList<ObvPoint> ceSeries, IReadOnlyList<ObvPoint> peSeries, IReadOnlyList<Candle> bars, int i, IReadOnlyList<LookbackWindow> windows, int normalizationBars)
    {
        var bullishConfirmed = true;
        var bearishConfirmed = true;
        var scores = new decimal[windows.Count];

        for (var w = 0; w < windows.Count; w++)
        {
            var ce = FlowScore(ceSeries, bars, i, windows[w].Bars, normalizationBars);
            var pe = FlowScore(peSeries, bars, i, windows[w].Bars, normalizationBars);
            if (ce is not { } ceScore || pe is not { } peScore) return (false, false, scores);

            var spread = ceScore - peScore; // CE rising / PE falling both push this positive; the mirror pushes it negative.
            scores[w] = spread;

            if (!(ceScore > 0 && peScore < 0 && spread >= windows[w].ThresholdScore)) bullishConfirmed = false;
            if (!(ceScore < 0 && peScore > 0 && -spread >= windows[w].ThresholdScore)) bearishConfirmed = false;
        }

        return (bullishConfirmed, bearishConfirmed, scores);
    }

    /// <summary>Walks forward from each entry's own bar, recomputing the FlowScore of the SAME leg
    /// that justified it (CE for Bullish, PE for Bearish) EVERY bar over flowExitLookbackBars - the
    /// FIRST bar that score falls to or below flowExitThresholdScore becomes the trade's forced exit
    /// (not a further bar after it, consistent with every other forced-exit mechanism in this app).
    /// A not-yet-computable score (not enough history right after entry) can never itself justify an
    /// exit - "no reading yet" is not "weak". Which measure's own weakness counts is the same
    /// FlowConfirmation.Confirms(flowMode, ...) combination entry itself uses.</summary>
    private static Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)> BuildFlowExits(
        BacktestStrategyContext context, IReadOnlyList<(int Index, DateTimeOffset Time, bool Bullish)> entryIndexes,
        int exitLookbackBars, decimal exitThresholdScore, decimal flowMode, int normalizationBars)
    {
        var exits = new Dictionary<DateTimeOffset, (DateTimeOffset, string)>();
        var bars = context.SpotBars;

        foreach (var (entryIndex, entryTime, bullish) in entryIndexes)
        {
            var obvSeries = bullish ? context.ObvCeSeries : context.ObvPeSeries;
            var cdvSeries = bullish ? context.CdvCeSeries : context.CdvPeSeries;

            for (var j = entryIndex + 1; j < bars.Count; j++)
            {
                var obvWeak = FlowScore(obvSeries, bars, j, exitLookbackBars, normalizationBars) is { } ov && ov <= exitThresholdScore;
                var cdvWeak = FlowScore(cdvSeries, bars, j, exitLookbackBars, normalizationBars) is { } cv && cv <= exitThresholdScore;

                if (FlowConfirmation.Confirms(flowMode, obvWeak, cdvWeak))
                {
                    exits[entryTime] = (bars[j].Time, "FlowStopLoss");
                    break;
                }
            }
        }

        return exits;
    }

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals, List<(int Index, DateTimeOffset Time, bool Bullish)> EntryIndexes) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var direction = parameters["direction"];
        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);
        var normalizationBars = Math.Max(1, (int)parameters.GetValueOrDefault("flowNormalizationBars", 30m));
        var windows = new[]
        {
            new LookbackWindow(Math.Max(1, (int)parameters["lookback1Bars"]), parameters.GetValueOrDefault("threshold1Score", 0.3m)),
            new LookbackWindow(Math.Max(1, (int)parameters["lookback2Bars"]), parameters.GetValueOrDefault("threshold2Score", 0.3m)),
            new LookbackWindow(Math.Max(1, (int)parameters["lookback3Bars"]), parameters.GetValueOrDefault("threshold3Score", 0.3m)),
        };
        var flowMode = parameters.GetValueOrDefault("flowMode", FlowConfirmation.ModeEither);

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();
        var entryIndexes = new List<(int Index, DateTimeOffset Time, bool Bullish)>();

        var bars = context.SpotBars;
        if (bars.Count == 0) return (entries, signals, entryIndexes);

        for (var i = 0; i < bars.Count; i++)
        {
            var bar = bars[i];
            var beforeSignalStart = signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes;

            var obv = EvaluateLeg(context.ObvCeSeries, context.ObvPeSeries, bars, i, windows, normalizationBars);
            var cdv = EvaluateLeg(context.CdvCeSeries, context.CdvPeSeries, bars, i, windows, normalizationBars);

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
            var windowBreakdown = string.Join(", ", windows.Select((win, i) => $"{win.Bars}-bar {(bullish ? scores[i] : -scores[i]):0.00}>={win.ThresholdScore:0.00}"));
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

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList(), entryIndexes);
    }
}

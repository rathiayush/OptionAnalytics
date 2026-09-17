using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// A pure order-flow momentum strategy (the user's own plan, given verbatim): CE's OBV/CDV rising
/// while PE's is falling means bullish flow (the mirror means bearish), measured across THREE
/// lookback windows (5/10/15 bars by default), EACH WITH ITS OWN THRESHOLD so the user can tune how
/// sensitive each window individually needs to be, rather than one shared number.
///
/// Per window w: CE's flow measure has to be rising (FlowConfirmation.PercentChange &gt; 0) AND PE's
/// falling (&lt; 0), AND the combined move - CeChange_w + (-PeChange_w), i.e. "how far the two legs
/// pulled apart" - has to clear THAT window's own ThresholdPercent (Threshold1/2/3Percent). A window
/// failing either the direction or its own threshold fails outright; ALL THREE windows have to pass
/// their own check for the bar to count as confirmed - not an average across them - which is what
/// actually gives per-window tuning meaning: raising Threshold2Percent alone tightens only the 10-bar
/// window without silently being watered down by the other two in a shared average. Bearish is the
/// exact mirror. Which of OBV/CDV (or both, or either) has to confirm is the existing
/// FlowConfirmation.ModeParameter toggle every other strategy here already uses.
///
/// Entry direction is Bullish/Bearish exactly as confirmed; STOP/TARGET are the standard shared
/// points-based 10/20 (1:2) default. OPTIONAL on top of that (FlowReversalExitBars, 0 = off, the
/// default): once in a trade, keep watching the SAME leg that was rising and justified the entry
/// (CE for a Bullish trade, PE for a Bearish one) - if it now FALLS for that many consecutive bars
/// in a row, the thesis that justified the trade has broken, so exit immediately as a stop-loss
/// rather than waiting for the premium's own stop/target to eventually catch up. Which measure's
/// reversal counts (OBV, CDV, either, or both) reuses the SAME FlowMode toggle entry itself uses -
/// if Both had to rise to enter, both have to fall to force this exit; if Either was enough to
/// enter, either reversing is enough to exit.
/// </summary>
public sealed class CdvObvFlowStrategy : IBacktestStrategy
{
    public string Key => "cdv-obv-flow";
    public string Name => "CDV/OBV Rising/Falling Flow Momentum";
    public string Description => "CE's OBV/CDV rising while PE's is falling (or the mirror) across ALL of three lookback windows (5/10/15 bars by default) is the signal - each window has its OWN threshold for how far CE and PE must have pulled apart, tunable independently. Whether OBV, CDV, either, or both have to confirm is also tunable.";

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
        new BacktestParameterSpec("threshold1Percent", "Window 1's own CE/PE spread must reach at least (%)", Default: 30, Min: 0, Max: 500, Step: 5),
        new BacktestParameterSpec("lookback2Bars", "Lookback window 2 (bars)", Default: 10, Min: 1, Max: 200, Step: 1),
        new BacktestParameterSpec("threshold2Percent", "Window 2's own CE/PE spread must reach at least (%)", Default: 30, Min: 0, Max: 500, Step: 5),
        new BacktestParameterSpec("lookback3Bars", "Lookback window 3 (bars)", Default: 15, Min: 1, Max: 200, Step: 1),
        new BacktestParameterSpec("threshold3Percent", "Window 3's own CE/PE spread must reach at least (%)", Default: 30, Min: 0, Max: 500, Step: 5),
        FlowConfirmation.ModeParameter("Require rising/falling agreement on"),
        new BacktestParameterSpec("flowReversalExitBars", "Exit as stop-loss if the entry's own rising leg falls for (bars, 0 = off)", Default: 0, Min: 0, Max: 50, Step: 1),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var evaluation = Evaluate(context, parameters);
        var flowReversalExitBars = (int)parameters.GetValueOrDefault("flowReversalExitBars", 0m);
        var flowMode = parameters.GetValueOrDefault("flowMode", FlowConfirmation.ModeEither);
        var signalExits = flowReversalExitBars > 0 ? BuildFlowReversalExits(context, evaluation.EntryIndexes, flowReversalExitBars, flowMode) : null;
        return OptionTradeSimulator.Run(context, evaluation.Entries, parameters, signalExits: signalExits);
    }

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    /// <summary>One lookback window's own bar count, converted to a TimeSpan, alongside its own
    /// threshold - see this class's own doc comment for why each window keeps its own number rather
    /// than sharing one.</summary>
    private readonly record struct LookbackWindow(TimeSpan Span, decimal ThresholdPercent, int Bars);

    /// <summary>Every window's own CE/PE spread check for one flow measure (OBV or CDV) at one bar -
    /// confirmed only when EVERY window's own direction AND own threshold both hold; a single missing
    /// reading, wrong-direction window, or under-threshold window anywhere fails the whole leg, since
    /// a partial picture cannot honestly claim "confirmed at every window checked".</summary>
    private static (bool BullishConfirmed, bool BearishConfirmed, IReadOnlyList<decimal> WindowScores) EvaluateLeg(
        IReadOnlyList<ObvPoint> ceSeries, IReadOnlyList<ObvPoint> peSeries, DateTimeOffset at, IReadOnlyList<LookbackWindow> windows)
    {
        var bullishConfirmed = true;
        var bearishConfirmed = true;
        var scores = new decimal[windows.Count];

        for (var w = 0; w < windows.Count; w++)
        {
            if (FlowConfirmation.PercentChange(ceSeries, at, windows[w].Span) is not { } ce ||
                FlowConfirmation.PercentChange(peSeries, at, windows[w].Span) is not { } pe)
            {
                return (false, false, scores);
            }

            var spread = ce - pe; // CE rising / PE falling both push this positive; the mirror pushes it negative.
            scores[w] = spread;

            if (!(ce > 0 && pe < 0 && spread >= windows[w].ThresholdPercent)) bullishConfirmed = false;
            if (!(ce < 0 && pe > 0 && -spread >= windows[w].ThresholdPercent)) bearishConfirmed = false;
        }

        return (bullishConfirmed, bearishConfirmed, scores);
    }

    /// <summary>Walks forward from each entry's own bar, counting consecutive bar-over-bar FALLS in
    /// the leg that was rising and justified that entry (CE for Bullish, PE for Bearish) - once a
    /// streak reaches <paramref name="reversalBars"/>, that bar becomes the trade's forced exit, at
    /// the FIRST bar the streak completes (not a further bar after it - consistent with every other
    /// forced-exit mechanism in this app). A missing reading anywhere breaks the streak back to zero
    /// rather than counting toward it - "no data" is not "falling". Which measure's own streak counts
    /// is the same FlowConfirmation.Confirms(flowMode, ...) combination entry itself uses.</summary>
    private static Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)> BuildFlowReversalExits(
        BacktestStrategyContext context, IReadOnlyList<(int Index, DateTimeOffset Time, bool Bullish)> entryIndexes, int reversalBars, decimal flowMode)
    {
        var exits = new Dictionary<DateTimeOffset, (DateTimeOffset, string)>();
        var bars = context.SpotBars;

        foreach (var (entryIndex, entryTime, bullish) in entryIndexes)
        {
            var obvSeries = bullish ? context.ObvCeSeries : context.ObvPeSeries;
            var cdvSeries = bullish ? context.CdvCeSeries : context.CdvPeSeries;
            var obvPrev = BacktestUtil.LastValueAtOrBefore(obvSeries, bars[entryIndex].Time);
            var cdvPrev = BacktestUtil.LastValueAtOrBefore(cdvSeries, bars[entryIndex].Time);
            var obvFallStreak = 0;
            var cdvFallStreak = 0;

            for (var j = entryIndex + 1; j < bars.Count; j++)
            {
                var obvNow = BacktestUtil.LastValueAtOrBefore(obvSeries, bars[j].Time);
                var cdvNow = BacktestUtil.LastValueAtOrBefore(cdvSeries, bars[j].Time);

                obvFallStreak = obvNow is { } ov && obvPrev is { } op && ov < op ? obvFallStreak + 1 : 0;
                cdvFallStreak = cdvNow is { } cv && cdvPrev is { } cp && cv < cp ? cdvFallStreak + 1 : 0;

                if (FlowConfirmation.Confirms(flowMode, obvFallStreak >= reversalBars, cdvFallStreak >= reversalBars))
                {
                    exits[entryTime] = (bars[j].Time, "FlowStopLoss");
                    break;
                }

                obvPrev = obvNow ?? obvPrev;
                cdvPrev = cdvNow ?? cdvPrev;
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
        var timeframeMinutes = Math.Max(1, context.TimeframeMinutes);
        var windows = new[]
        {
            new LookbackWindow(TimeSpan.FromMinutes(Math.Max(1, (int)parameters["lookback1Bars"]) * timeframeMinutes), parameters.GetValueOrDefault("threshold1Percent", 30m), (int)parameters["lookback1Bars"]),
            new LookbackWindow(TimeSpan.FromMinutes(Math.Max(1, (int)parameters["lookback2Bars"]) * timeframeMinutes), parameters.GetValueOrDefault("threshold2Percent", 30m), (int)parameters["lookback2Bars"]),
            new LookbackWindow(TimeSpan.FromMinutes(Math.Max(1, (int)parameters["lookback3Bars"]) * timeframeMinutes), parameters.GetValueOrDefault("threshold3Percent", 30m), (int)parameters["lookback3Bars"]),
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

            var obv = EvaluateLeg(context.ObvCeSeries, context.ObvPeSeries, bar.Time, windows);
            var cdv = EvaluateLeg(context.CdvCeSeries, context.CdvPeSeries, bar.Time, windows);

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

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList(), entryIndexes);
    }
}

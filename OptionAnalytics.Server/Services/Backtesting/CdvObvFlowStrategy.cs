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
/// points-based 10/20 (1:2) default, not a bespoke flow-based exit - kept plain, same call every
/// other strategy here makes when the underlying idea does not itself suggest a different rule.
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
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters);

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

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals) Evaluate(
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

        var bars = context.SpotBars;
        if (bars.Count == 0) return (entries, signals);

        foreach (var bar in bars)
        {
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
            }
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }
}

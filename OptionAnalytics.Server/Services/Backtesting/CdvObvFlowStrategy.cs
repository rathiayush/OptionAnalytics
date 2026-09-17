using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// A pure order-flow momentum strategy (the user's own plan, given verbatim): CE's OBV/CDV rising
/// while PE's is falling means bullish flow (the mirror means bearish), measured across THREE
/// lookback windows (5/10/15 bars by default) rather than just one, and combined into a single
/// score compared against a tunable threshold.
///
/// The exact combination, worked out with the user after their own "3-5-15... but the % will be a
/// different size on each window, so how do I combine them" question:
///
///   1. AGREEMENT ACROSS ALL THREE WINDOWS, not just on average - CE's flow measure must be rising
///      (FlowConfirmation.PercentChange &gt; 0) over EVERY ONE of the three lookback windows at once,
///      and PE's falling (&lt; 0) over all three, for a Bullish candidate (mirrored for Bearish). This
///      is the actual "catch a real, sustained trend rather than a one-bar blip" filter: noise
///      rarely agrees at every horizon checked; a genuine trend does. A single missing/unusable
///      reading (see PercentChange's own zero/sign-flip guard) anywhere disqualifies that bar
///      outright, same reasoning.
///   2. ONLY once that agreement holds, the SCORE is average(CE's three rise-%) + average(PE's three
///      fall-% as a positive magnitude) - averaging WITHIN a leg, not summing the three raw numbers,
///      is what keeps the score on one consistent percentage scale regardless of whether a window is
///      5 or 15 bars (a 15-bar window's % naturally runs bigger than a 5-bar one's on the same real
///      move, so summing all three raw would silently let whichever window swings hardest dominate
///      the threshold check instead of the move actually being genuine at every scale).
///   3. That one score is compared against ThresholdPercentParameter. The same steps 1-2 run
///      independently for OBV and for CDV; which of the two (or both, or either) has to clear it is
///      the existing FlowConfirmation.ModeParameter toggle every other strategy here already uses,
///      defaulting to Either.
///
/// Entry direction is Bullish/Bearish exactly as confirmed; STOP/TARGET are the standard shared
/// points-based 10/20 (1:2) default, not a bespoke flow-based exit - kept plain, same call every
/// other strategy here makes when the underlying idea does not itself suggest a different rule.
/// </summary>
public sealed class CdvObvFlowStrategy : IBacktestStrategy
{
    public string Key => "cdv-obv-flow";
    public string Name => "CDV/OBV Rising/Falling Flow Momentum";
    public string Description => "CE's OBV/CDV rising while PE's is falling (or the mirror) across ALL of three lookback windows (5/10/15 bars) is a candidate; the average rise/fall % across those windows must then clear a threshold to actually enter. Whether OBV, CDV, either, or both have to confirm is tunable.";

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
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Bullish only"),
            new BacktestParameterOption(DirectionShortOnly, "Bearish only"),
        }),
        new BacktestParameterSpec("lookback1Bars", "Lookback window 1 (bars)", Default: 5, Min: 1, Max: 200, Step: 1),
        new BacktestParameterSpec("lookback2Bars", "Lookback window 2 (bars)", Default: 10, Min: 1, Max: 200, Step: 1),
        new BacktestParameterSpec("lookback3Bars", "Lookback window 3 (bars)", Default: 15, Min: 1, Max: 200, Step: 1),
        FlowConfirmation.ModeParameter("Require rising/falling agreement on"),
        new BacktestParameterSpec("thresholdPercent", "Combined flow score must reach at least (%)", Default: 30, Min: 0, Max: 500, Step: 5),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters);

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    /// <summary>All three windows' CE/PE percent changes for one flow measure (OBV or CDV) at one
    /// bar - null (not confirmed) the moment any single reading is missing/unusable, since a partial
    /// picture cannot honestly claim agreement "across all three windows".</summary>
    private static (bool BullishConfirmed, bool BearishConfirmed, decimal BullishScore, decimal BearishScore) EvaluateLeg(
        IReadOnlyList<ObvPoint> ceSeries, IReadOnlyList<ObvPoint> peSeries, DateTimeOffset at, IReadOnlyList<TimeSpan> windows, decimal thresholdPercent)
    {
        var ceChanges = new decimal[windows.Count];
        var peChanges = new decimal[windows.Count];
        for (var w = 0; w < windows.Count; w++)
        {
            if (FlowConfirmation.PercentChange(ceSeries, at, windows[w]) is not { } ce) return (false, false, 0, 0);
            if (FlowConfirmation.PercentChange(peSeries, at, windows[w]) is not { } pe) return (false, false, 0, 0);
            ceChanges[w] = ce;
            peChanges[w] = pe;
        }

        var bullishAgreement = ceChanges.All(c => c > 0) && peChanges.All(p => p < 0);
        var bullishScore = bullishAgreement ? ceChanges.Average() + peChanges.Select(p => -p).Average() : 0;
        var bearishAgreement = ceChanges.All(c => c < 0) && peChanges.All(p => p > 0);
        var bearishScore = bearishAgreement ? ceChanges.Select(c => -c).Average() + peChanges.Average() : 0;

        return (bullishAgreement && bullishScore >= thresholdPercent, bearishAgreement && bearishScore >= thresholdPercent, bullishScore, bearishScore);
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
            TimeSpan.FromMinutes(Math.Max(1, (int)parameters["lookback1Bars"]) * timeframeMinutes),
            TimeSpan.FromMinutes(Math.Max(1, (int)parameters["lookback2Bars"]) * timeframeMinutes),
            TimeSpan.FromMinutes(Math.Max(1, (int)parameters["lookback3Bars"]) * timeframeMinutes),
        };
        var flowMode = parameters.GetValueOrDefault("flowMode", FlowConfirmation.ModeEither);
        var thresholdPercent = parameters.GetValueOrDefault("thresholdPercent", 30m);

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var bars = context.SpotBars;
        if (bars.Count == 0) return (entries, signals);

        foreach (var bar in bars)
        {
            var beforeSignalStart = signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes;

            var obv = EvaluateLeg(context.ObvCeSeries, context.ObvPeSeries, bar.Time, windows, thresholdPercent);
            var cdv = EvaluateLeg(context.CdvCeSeries, context.CdvPeSeries, bar.Time, windows, thresholdPercent);

            var bullish = FlowConfirmation.Confirms(flowMode, obv.BullishConfirmed, cdv.BullishConfirmed);
            var bearish = FlowConfirmation.Confirms(flowMode, obv.BearishConfirmed, cdv.BearishConfirmed);
            if (!bullish && !bearish) continue;

            // Both directions confirming at once is not a real, actionable signal either way -
            // skipped outright rather than arbitrarily picking one side.
            if (bullish && bearish) continue;

            var dir = bullish ? "Bullish" : "Bearish";
            var score = bullish ? Math.Max(obv.BullishScore, cdv.BullishScore) : Math.Max(obv.BearishScore, cdv.BearishScore);
            var summary = $"CE {(bullish ? "rising" : "falling")} / PE {(bullish ? "falling" : "rising")} across all of {parameters["lookback1Bars"]}/{parameters["lookback2Bars"]}/{parameters["lookback3Bars"]} bars ({FlowConfirmation.ModeLabel(flowMode)}), combined score {score:0.#}% >= {thresholdPercent:0.#}%";

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

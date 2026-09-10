using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// A pure order-flow strategy: no spot price action at all, just which side (CE or PE) the option
/// buyers are actually piling into.
///
///   BULLISH: CE leads PE for at least BarsThreshold straight bars, on whichever series(es)
///            ConfirmSource selects - call buying outpacing put buying.
///   BEARISH: the mirror - PE leads CE for the same span.
///
/// ConfirmSource picks how strict that lead has to be:
///   - Both (the default): CDV(CE) above CDV(PE) AND OBV(CE) above OBV(PE) at the same time - CDV
///     and OBV are computed from the same tick stream but weighted differently
///     (CdvUnderlyingState's sigmoid-moneyness-delta weighting vs OBV's plain by-bar-direction sum -
///     see BacktestStrategyContext's own doc comment on both series), so requiring them to agree
///     filters out a lead that is only a one-metric blip, the same reasoning
///     FiveEmaObvCrossoverStrategy already applies to a spot breakout.
///   - CDV only / OBV only: judged off that one series alone, for anyone who wants to test (or
///     trusts) one metric on its own rather than requiring agreement.
///
/// The bars-threshold requirement exists because a CE/PE lead can flip for one or two bars on
/// nothing more than a single large order before reverting - BarsThreshold is how many CONSECUTIVE
/// bars the same side has to stay ahead before this counts as a real move rather than a blip. Only
/// one signal fires per qualifying streak (right at the bar the threshold is first reached), not on
/// every bar the lead continues to hold afterward. A streak resets - and nothing carries overnight -
/// the moment the selected series stop agreeing (in Both mode), the lead flips outright, or the
/// trading day changes.
///
/// ThresholdPercent is a MAGNITUDE filter alongside that PERSISTENCE one: CE merely being a rupee
/// ahead of PE is not a lead worth trading on its own scale, so a bar only counts as favoring a side
/// once that side is ahead by at least this percentage. The percentage is measured as
/// (CE - PE) / (|CE| + |PE|) - the same bounded, sign-safe "imbalance ratio" order-flow measures
/// commonly use (a plain CE/PE ratio breaks the moment either total goes negative, which CDV/OBV
/// both do routinely) - so 0 (the default) means any nonzero lead counts, exactly as before this
/// parameter existed, and larger values demand a progressively more decisive imbalance.
/// </summary>
public sealed class CdvObvCrossoverStrategy : IBacktestStrategy
{
    public string Key => "cdv-obv-crossover";
    public string Name => "CDV + OBV CE/PE Crossover";
    public string Description => "Enters Bullish when CE leads PE by at least the threshold percentage for a run of consecutive bars (the bars threshold), or Bearish when PE leads CE the same way. ConfirmSource picks whether that lead is judged on CDV alone, OBV alone, or both agreeing at once (the default, which filters out a lead that is only a one-metric blip).";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    private const decimal ConfirmBoth = 0;
    private const decimal ConfirmCdvOnly = 1;
    private const decimal ConfirmObvOnly = 2;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.StopLossParameter(),
        OptionTradeSimulator.TakeProfitParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        OptionTradeSimulator.SignalStartTimeParameter(),
        new BacktestParameterSpec("barsThreshold", "CE/PE lead confirmed for (bars)", Default: 3, Min: 1, Max: 50, Step: 1),
        new BacktestParameterSpec("thresholdPercent", "Minimum CE/PE lead (%, 0 = off)", Default: 0, Min: 0, Max: 100, Step: 0.5m),
        new BacktestParameterSpec("confirmSource", "Confirm using", Default: ConfirmBoth, Min: ConfirmBoth, Max: ConfirmObvOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(ConfirmBoth, "CDV + OBV (both must agree)"),
            new BacktestParameterOption(ConfirmCdvOnly, "CDV only"),
            new BacktestParameterOption(ConfirmObvOnly, "OBV only"),
        }),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Longs only (CE leads)"),
            new BacktestParameterOption(DirectionShortOnly, "Shorts only (PE leads)"),
        }),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters);

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var barsThreshold = Math.Max(1, (int)parameters["barsThreshold"]);
        var thresholdPercent = parameters.GetValueOrDefault("thresholdPercent", 0m);
        var confirmSource = parameters.GetValueOrDefault("confirmSource", ConfirmBoth);
        var direction = parameters["direction"];
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);
        var metricLabel = confirmSource switch { ConfirmCdvOnly => "CDV", ConfirmObvOnly => "OBV", _ => "CDV and OBV" };
        var thresholdSuffix = thresholdPercent > 0 ? $" (>= {thresholdPercent}% lead)" : "";

        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        // Keyed by the same bucket-start Time as SpotBars - every series here is aggregated to the
        // same TimeframeMinutes off the same bucketing rule (BacktestUtil.AggregateLine), so a bar's
        // CDV/OBV values live under its own bar.Time exactly like OptionTradeSimulator already looks
        // up SpotBars by signal time.
        var cdvCeByTime = context.CdvCeSeries.ToDictionary(p => p.Time, p => p.Obv);
        var cdvPeByTime = context.CdvPeSeries.ToDictionary(p => p.Time, p => p.Obv);
        var obvCeByTime = context.ObvCeSeries.ToDictionary(p => p.Time, p => p.Obv);
        var obvPeByTime = context.ObvPeSeries.ToDictionary(p => p.Time, p => p.Obv);

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        string? streakDirection = null;
        var streakLength = 0;
        var firedForStreak = false;
        DateOnly? currentDay = null;

        foreach (var bar in context.SpotBars)
        {
            // Nothing carries overnight - a lead built up during one session says nothing about the
            // next day's opening order flow.
            var day = BacktestUtil.IstDate(bar.Time);
            if (currentDay != day)
            {
                currentDay = day;
                streakDirection = null;
                streakLength = 0;
                firedForStreak = false;
            }

            string? cdvBias = cdvCeByTime.TryGetValue(bar.Time, out var cdvCe) && cdvPeByTime.TryGetValue(bar.Time, out var cdvPe)
                ? ComputeBias(cdvCe, cdvPe, thresholdPercent)
                : null;
            string? obvBias = obvCeByTime.TryGetValue(bar.Time, out var obvCe) && obvPeByTime.TryGetValue(bar.Time, out var obvPe)
                ? ComputeBias(obvCe, obvPe, thresholdPercent)
                : null;

            var bias = confirmSource switch
            {
                ConfirmCdvOnly => cdvBias,
                ConfirmObvOnly => obvBias,
                _ => cdvBias is not null && cdvBias == obvBias ? cdvBias : null,
            };

            if (bias is not null && bias == streakDirection)
            {
                streakLength++;
            }
            else
            {
                streakDirection = bias;
                streakLength = bias is null ? 0 : 1;
                firedForStreak = false;
            }

            if (bias is null || streakLength < barsThreshold || firedForStreak) continue;

            // Only ONE signal per qualifying streak - right at the bar the threshold is first
            // reached, not on every later bar the lead keeps holding.
            firedForStreak = true;

            var summary = $"CE {(bias == "Bullish" ? "ahead of" : "behind")} PE on {metricLabel} for {streakLength} straight bar(s){thresholdSuffix}";
            var beforeSignalStart = signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes;

            if (beforeSignalStart)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bias, $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
            }
            else if (bias == "Bullish" && !takeLongs)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bias, $"{summary} - skipped, shorts only"));
            }
            else if (bias == "Bearish" && !takeShorts)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bias, $"{summary} - skipped, longs only"));
            }
            else
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", bias, summary));
                entries.Add((bar.Time, bias));
            }
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }

    /// <summary>"Bullish" if CE leads PE by at least <paramref name="thresholdPercent"/>, "Bearish"
    /// if PE leads CE the same way, null otherwise (including the both-zero case, where no lead is
    /// even meaningful). The lead is measured as (CE - PE) / (|CE| + |PE|) - bounded to [-100, 100]
    /// and well-defined regardless of sign, unlike a plain CE/PE ratio which breaks the moment
    /// either running total goes negative (which CDV/OBV both do routinely). thresholdPercent=0
    /// reduces to "whichever side is simply bigger", exactly the comparison this strategy used
    /// before this parameter existed.</summary>
    private static string? ComputeBias(decimal ce, decimal pe, decimal thresholdPercent)
    {
        var denominator = Math.Abs(ce) + Math.Abs(pe);
        if (denominator == 0) return null;

        var leadPercent = (ce - pe) / denominator * 100;
        if (leadPercent > 0 && leadPercent >= thresholdPercent) return "Bullish";
        if (leadPercent < 0 && -leadPercent >= thresholdPercent) return "Bearish";
        return null;
    }
}

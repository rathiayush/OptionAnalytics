using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// A pure order-flow strategy: no spot price action at all, just which side (CE or PE) the option
/// buyers are actually piling into, measured two different ways at once.
///
///   BULLISH: CDV(CE) is above CDV(PE) AND OBV(CE) is above OBV(PE), both holding for at least
///            BarsThreshold straight bars - call buying outpacing put buying, confirmed by both the
///            tick-rule delta-volume total and the by-bar-direction volume total agreeing, not just
///            one of them.
///   BEARISH: the mirror - CDV(PE) above CDV(CE) AND OBV(PE) above OBV(CE), for the same span.
///
/// Requiring BOTH series to agree (not just one) is deliberate: CDV and OBV are computed from the
/// same tick stream but weighted differently (CdvUnderlyingState's sigmoid-moneyness-delta weighting
/// vs OBV's plain by-bar-direction sum - see BacktestStrategyContext's own doc comment on both
/// series), so one crossing without the other is exactly the kind of single-metric noise a
/// confirmation-based entry exists to filter out, the same reasoning FiveEmaObvCrossoverStrategy
/// already applies to a spot breakout.
///
/// The bars-threshold requirement exists because a CE/PE lead can flip for one or two bars on
/// nothing more than a single large order before reverting - BarsThreshold is how many CONSECUTIVE
/// bars the same side has to stay ahead on both series before this counts as a real move rather
/// than a blip. Only one signal fires per qualifying streak (right at the bar the threshold is
/// first reached), not on every bar the lead continues to hold afterward. A streak resets - and
/// nothing carries overnight - the moment either series stops agreeing, the lead flips outright, or
/// the trading day changes.
/// </summary>
public sealed class CdvObvCrossoverStrategy : IBacktestStrategy
{
    public string Key => "cdv-obv-crossover";
    public string Name => "CDV + OBV CE/PE Crossover";
    public string Description => "Enters Bullish when CE leads PE on BOTH cumulative delta volume (CDV) and on-balance volume (OBV) for a run of consecutive bars (the bars threshold), or Bearish when PE leads CE on both for the same span. Requiring both series to agree filters out a lead that is only a one-metric blip.";

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
        new BacktestParameterSpec("barsThreshold", "CE/PE lead confirmed for (bars)", Default: 3, Min: 1, Max: 50, Step: 1),
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
        var direction = parameters["direction"];
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);

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

            string? bias = null;
            if (cdvCeByTime.TryGetValue(bar.Time, out var cdvCe) && cdvPeByTime.TryGetValue(bar.Time, out var cdvPe) &&
                obvCeByTime.TryGetValue(bar.Time, out var obvCe) && obvPeByTime.TryGetValue(bar.Time, out var obvPe))
            {
                if (cdvCe > cdvPe && obvCe > obvPe) bias = "Bullish";
                else if (cdvPe > cdvCe && obvPe > obvCe) bias = "Bearish";
            }

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

            var summary = $"CE {(bias == "Bullish" ? "ahead of" : "behind")} PE on both CDV and OBV for {streakLength} straight bar(s)";
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
}

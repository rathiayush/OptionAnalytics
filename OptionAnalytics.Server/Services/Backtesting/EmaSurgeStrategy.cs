using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// A confirmation-chain strategy: each step must confirm the one before it, in order, before an
/// entry is taken.
///
///   1. SPOT leads - its EMA9/21 must actually CROSS on this bar. Not "the bias is up", but the
///      crossing itself, which is the key difference from OtmConfluenceStrategy: that one fires
///      whenever the three biases happen to line up, which can be because a single leg flipped
///      while the others had been sitting that way for hours. Here the move has to be starting.
///   2. THE MATCHING LEG CONFIRMS - within ConfirmWithinBars of the spot cross, the leg on the
///      corresponding side must cross the same way: a spot cross UP wants the ATM CE to cross up,
///      a spot cross DOWN wants the ATM PE to cross up (the app's standing bullish/bearish
///      convention - CE leads a rally, PE leads a selloff). A spot cross with no leg confirming it
///      is dropped.
///   3. OBV / CDV CONFIRM - each optional, controlled by its own flag. When a flag is on, the
///      DIRECTION leg's series (the same CE/PE that confirmed in step 2) must show a surge: a %-change of at least LookbackPercent in
///      magnitude over the lookback windows (3, 5 and 7 bars). Magnitude, not direction - a
///      violent move either way counts, matching what the Pine indicator's own threshold check
///      does (it takes math.abs before comparing). LookbackMode decides how many windows have to
///      agree: ANY of them clearing the threshold is enough by default (a surge usually shows up
///      in one window before the others), or ALL of them can be required, which additionally
///      demands the move has held rather than being a single-bar spike.
///
/// Note on the CDV flag: CDV is day-scoped - it resets every trading day and only the current day's
/// series is ever in memory (see BacktestStrategyContext.CdvSeries). So turning CDV confirmation on
/// necessarily restricts this backtest to signals inside TODAY's session, however many days of spot
/// and OBV history the rest of the run has. OBV carries its full multi-day history and has no such
/// limit, which is why it is the one defaulted on.
///
/// Every step above is about the DIRECTION of the move, so the signals this produces are identical
/// whether the Position is Buy or Sell - only what gets traded off them differs (a bullish view is
/// a bought CE or a sold PE). That is deliberate: it is what makes "is this signal better bought or
/// sold?" an answerable question, since both sides are then measured on the same set of signals.
///
/// Everything after the entry decision is OptionTradeSimulator's, shared with the other strategies.
/// </summary>
public sealed class EmaSurgeStrategy : IBacktestStrategy
{
    public string Key => "ema-surge";
    public string Name => "EMA Crossover + Volume Surge";
    public string Description => "Spot EMA 9/21 must cross, the matching CE (up) or PE (down) leg must cross to confirm it, and - when their flags are on - the traded leg's OBV and/or CDV must have moved at least the threshold % across the 3/5/7-bar lookback windows (any one of them by default, or all three).";

    private static readonly int[] LookbackWindows = { 3, 5, 7 };

    private const decimal FlagOff = 0;
    private const decimal FlagOn = 1;

    private const decimal ModeAny = 0;
    private const decimal ModeAll = 1;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.StopLossParameter(),
        OptionTradeSimulator.TakeProfitParameter(),
        new BacktestParameterSpec("confirmWithinBars", "Leg must confirm within (bars)", Default: 3, Min: 0, Max: 20, Step: 1),
        new BacktestParameterSpec("lookbackPercent", "Lookback surge threshold (%)", Default: 75, Min: 0, Max: 1000, Step: 5),
        new BacktestParameterSpec("lookbackMode", "Lookback windows needed", Default: ModeAny, Min: ModeAny, Max: ModeAll, Step: 1, Options: new[]
        {
            new BacktestParameterOption(ModeAny, "Any of 3/5/7 bars"),
            new BacktestParameterOption(ModeAll, "All of 3/5/7 bars"),
        }),
        new BacktestParameterSpec("useObv", "Require OBV confirmation", Default: FlagOn, Min: FlagOff, Max: FlagOn, Step: 1, Options: new[]
        {
            new BacktestParameterOption(FlagOn, "Yes - OBV must confirm"),
            new BacktestParameterOption(FlagOff, "No - ignore OBV"),
        }),
        new BacktestParameterSpec("useCdv", "Require CDV confirmation", Default: FlagOff, Min: FlagOff, Max: FlagOn, Step: 1, Options: new[]
        {
            new BacktestParameterOption(FlagOff, "No - ignore CDV"),
            new BacktestParameterOption(FlagOn, "Yes - CDV must confirm (today only)"),
        }),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters);

    /// <summary>Every spot crossover this strategy looked at, newest first, each labelled with how
    /// far down the confirmation chain it got - so the signal table shows not just the entries but
    /// the near-misses and WHY they were rejected, which is what makes a threshold worth tuning.</summary>
    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var confirmWithinBars = (int)parameters["confirmWithinBars"];
        var lookbackPercent = parameters["lookbackPercent"];
        var requireAllWindows = parameters["lookbackMode"] >= (ModeAny + ModeAll) / 2;
        var windowsLabel = requireAllWindows ? "all of 3/5/7" : "any of 3/5/7";
        var useObv = parameters["useObv"] >= (FlagOff + FlagOn) / 2;
        var useCdv = parameters["useCdv"] >= (FlagOff + FlagOn) / 2;

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var spotCrossings = CrossoverEvents(context.SpotBars);
        if (spotCrossings.Count == 0) return (entries, signals);

        // The confirming leg is the ATM contract on the side the spot move points at, taken at the
        // ATM as it stands now - the same series the dashboard's ATM CE/PE charts plot.
        var atmStrike = CurrentAtmStrike(context);
        var ceCrossings = CrossoverEvents(context.GetOptionBars(atmStrike, true));
        var peCrossings = CrossoverEvents(context.GetOptionBars(atmStrike, false));

        foreach (var (time, direction) in spotCrossings)
        {
            var isBullish = direction == "Bullish";
            var legLabel = isBullish ? "ATM CE" : "ATM PE";

            // Step 2: the matching leg has to cross UP within the window - CE for a spot breakup,
            // PE for a spot breakdown.
            var legCrossings = isBullish ? ceCrossings : peCrossings;
            if (!ConfirmedWithin(legCrossings, time, confirmWithinBars, context.TimeframeMinutes))
            {
                signals.Add(new BacktestSignal(context.Underlying, time, "Rejected", direction,
                    $"Spot crossed {(isBullish ? "up" : "down")} but {legLabel} did not confirm within {confirmWithinBars} bar(s)"));
                continue;
            }

            // Step 3: the surge is measured on the same leg that confirmed the direction in step 2
            // - CE for a breakup, PE for a breakdown - NOT on whichever leg the trade happens to be
            // expressed in. The signal is a view on the market; Buy/Sell is only how that view gets
            // traded (a bullish view is a bought CE or a sold PE). Keying the confirmation off the
            // traded leg instead would make the two sides fire on different signals entirely and so
            // impossible to compare, which is the whole reason for having the toggle.
            var surgeLegIsCall = isBullish;
            var tradedLegLabel = surgeLegIsCall ? "CE" : "PE";

            if (useObv && !HasSurged(surgeLegIsCall ? context.ObvCeSeries : context.ObvPeSeries, time, lookbackPercent, requireAllWindows))
            {
                signals.Add(new BacktestSignal(context.Underlying, time, "Rejected", direction,
                    $"Spot + {legLabel} confirmed, but {tradedLegLabel} OBV did not move {lookbackPercent:0.#}% across {windowsLabel} bars"));
                continue;
            }

            if (useCdv && !HasSurged(surgeLegIsCall ? context.CdvCeSeries : context.CdvPeSeries, time, lookbackPercent, requireAllWindows))
            {
                signals.Add(new BacktestSignal(context.Underlying, time, "Rejected", direction,
                    $"Spot + {legLabel} confirmed, but {tradedLegLabel} CDV did not move {lookbackPercent:0.#}% across {windowsLabel} bars"));
                continue;
            }

            var confirmedBy = useObv && useCdv ? "OBV + CDV" : useObv ? "OBV" : useCdv ? "CDV" : "no volume filter";
            signals.Add(new BacktestSignal(context.Underlying, time, "Entry", direction,
                $"Spot crossed {(isBullish ? "up" : "down")} + {legLabel} confirmed + {confirmedBy}"));
            entries.Add((time, direction));
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }

    /// <summary>Every bar where EMA9 actually crossed EMA21, as opposed to every bar where it
    /// merely sits on one side of it - a direction change from the previous bar's direction.</summary>
    private static List<(DateTimeOffset Time, string Direction)> CrossoverEvents(IReadOnlyList<Candle> bars)
    {
        var events = new List<(DateTimeOffset, string)>();
        string? previous = null;

        foreach (var (time, direction) in EmaCrossoverDetector.DirectionSeries(bars))
        {
            if (direction is null) continue;
            if (previous is not null && direction != previous) events.Add((time, direction));
            previous = direction;
        }
        return events;
    }

    /// <summary>Did the confirming leg cross UP close enough after the spot cross to count as
    /// confirming it? "Bullish" on the leg means its own EMA9 crossed above EMA21 - which is what
    /// confirms both a CE leading a rally and a PE leading a selloff.</summary>
    private static bool ConfirmedWithin(
        List<(DateTimeOffset Time, string Direction)> legCrossings, DateTimeOffset spotTime, int withinBars, int timeframeMinutes)
    {
        var window = TimeSpan.FromMinutes((withinBars + 1) * timeframeMinutes);
        foreach (var (time, direction) in legCrossings)
        {
            if (direction != "Bullish") continue;
            if ((time - spotTime).Duration() <= window) return true;
        }
        return false;
    }

    /// <summary>True when the series' %-change into <paramref name="asOf"/> clears
    /// <paramref name="thresholdPercent"/> in magnitude - across EVERY lookback window when
    /// <paramref name="requireAllWindows"/>, or across any single one otherwise. The %-change is
    /// the same (current - previous) / |previous| * 100 the lookback tables report, so this asks
    /// exactly the question those tables answer.</summary>
    private static bool HasSurged(IReadOnlyList<ObvPoint> series, DateTimeOffset asOf, decimal thresholdPercent, bool requireAllWindows)
    {
        var index = LastIndexAtOrBefore(series, asOf);
        if (index < 0) return false;

        var anyCleared = false;

        foreach (var window in LookbackWindows)
        {
            var previousIndex = index - window;
            // A window reaching back before the series starts can't be judged: that is a failure
            // when every window has to clear, and simply not a qualifying window when any will do.
            if (previousIndex < 0)
            {
                if (requireAllWindows) return false;
                continue;
            }

            var previous = series[previousIndex].Obv;
            if (previous == 0)
            {
                if (requireAllWindows) return false;
                continue;
            }

            var changePercent = (series[index].Obv - previous) / Math.Abs(previous) * 100m;
            var cleared = Math.Abs(changePercent) >= thresholdPercent;

            if (requireAllWindows && !cleared) return false;
            anyCleared |= cleared;
        }

        return requireAllWindows || anyCleared;
    }

    private static int LastIndexAtOrBefore(IReadOnlyList<ObvPoint> series, DateTimeOffset time)
    {
        var found = -1;
        for (var i = 0; i < series.Count; i++)
        {
            if (series[i].Time > time) break;
            found = i;
        }
        return found;
    }

    /// <summary>The ATM strike as of the most recent spot bar - what the confirming CE/PE leg is
    /// read from, mirroring the dashboard's own "ATM CE/PE" charts.</summary>
    private static decimal CurrentAtmStrike(BacktestStrategyContext context)
    {
        if (context.SpotBars.Count == 0 || context.Step <= 0) return 0;
        var lastClose = context.SpotBars[^1].Close;
        return Math.Round(lastClose / context.Step) * context.Step;
    }
}

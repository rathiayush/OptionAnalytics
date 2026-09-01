using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// A confirmation-chain strategy: each step must confirm the one before it, in order, before an
/// entry is taken.
///
///   1. SPOT leads - its fast/slow EMA (9/21 by default, both tunable) must actually CROSS. Not "the
///      bias is up", but the crossing itself, which is the key difference from
///      OtmConfluenceStrategy: that one fires whenever the three biases happen to line up, which can
///      be because a single leg flipped while the others had been sitting that way for hours. Here
///      the move has to be starting.
///   2. THE MATCHING LEG CONFIRMS - within ConfirmWithinBars of the spot cross, the leg on the
///      corresponding side must cross the same way: a spot cross UP wants the ATM CE to cross up,
///      a spot cross DOWN wants the ATM PE to cross up (the app's standing bullish/bearish
///      convention - CE leads a rally, PE leads a selloff). A spot cross with no leg confirming it
///      is dropped.
///   3. THE VOLUME MUST BE IN LINE - the CE and PE curves have to agree with the direction. See
///      VolumeAlignment below for what "in line" means and why it replaced the old surge-only test.
///
/// Note on the CDV option: CDV is day-scoped - it resets every trading day and only the current
/// day's series is ever in memory (see BacktestStrategyContext.CdvSeries). Requiring CDV
/// (VolumeCdvOnly / VolumeBoth) therefore restricts this backtest to signals inside TODAY's session,
/// however many days of spot and OBV history the rest of the run has. The default
/// (VolumeEitherSource) is immune to that: CDV having no data that far back simply means OBV is the
/// one that answers, rather than the whole signal being dropped.
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
    public string Description => "Spot's fast/slow EMA (9/21 by default, both tunable) must cross, the matching CE (up) or PE (down) leg must cross to confirm it, and the volume must be in line with the move - by default either OBV or CDV showing the direction's leg on top of the other (bullish: the CE line above the PE line). Stricter settings can demand the two be split by sign, or fall back to the old surge test.";

    // How much of the volume picture has to agree. These are the sources; VolumeAlignment below is
    // the separate question of what "agree" means.
    private const decimal VolumeOff = 0;
    private const decimal VolumeEitherSource = 1;
    private const decimal VolumeObvOnly = 2;
    private const decimal VolumeCdvOnly = 3;
    private const decimal VolumeBoth = 4;

    // What counts as one source being "in line" with the direction:
    //   OnTop  - the direction's leg is simply on top: CE above PE for a breakup, PE above CE for a
    //            breakdown. This is the STATE of the Pine indicator's crossUp/crossDown rather than
    //            the crossing instant, which is the single biggest reason the old chain was so hard
    //            to satisfy: it demanded a fresh cross inside the confirmation window, so a move
    //            that had already been building for a few bars - the healthy case - was rejected for
    //            having crossed too early.
    //   Split  - the two are on opposite sides of zero the right way round: CE positive and PE
    //            negative for a breakup. Both series are day-baselined, so this reads as "since the
    //            open, calls have been bought and puts sold".
    //   Surge  - the old test: the direction leg's %-change over the lookback windows clears the
    //            threshold in magnitude. Kept, but no longer mandatory.
    //
    // Note there is deliberately no "on top OR split" mode, even though that is the natural way to
    // say it out loud: split IMPLIES on top (bullish split means CE > 0 > PE, hence CE > PE), so
    // such a mode could never differ from OnTop by a single signal. Split is therefore offered as
    // the STRICTER of the two, not as an alternative to it.
    private const decimal AlignOnTop = 0;
    private const decimal AlignSplit = 1;
    private const decimal AlignOnTopOrSurge = 2;
    private const decimal AlignSurgeOnly = 3;

    private const decimal ModeAny = 0;
    private const decimal ModeAll = 1;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.StopLossParameter(),
        OptionTradeSimulator.TakeProfitParameter(),
        new BacktestParameterSpec("emaFast", "Fast EMA (bars)", Default: 9, Min: 1, Max: 200, Step: 1),
        new BacktestParameterSpec("emaSlow", "Slow EMA (bars)", Default: 21, Min: 2, Max: 400, Step: 1),
        new BacktestParameterSpec("confirmWithinBars", "Leg must confirm within (bars)", Default: 3, Min: 0, Max: 20, Step: 1),
        new BacktestParameterSpec("volumeConfirm", "Volume must be in line", Default: VolumeEitherSource, Min: VolumeOff, Max: VolumeBoth, Step: 1, Options: new[]
        {
            new BacktestParameterOption(VolumeEitherSource, "OBV or CDV - either one"),
            new BacktestParameterOption(VolumeObvOnly, "OBV only"),
            new BacktestParameterOption(VolumeCdvOnly, "CDV only (today only)"),
            new BacktestParameterOption(VolumeBoth, "Both OBV and CDV (today only)"),
            new BacktestParameterOption(VolumeOff, "Off - ignore volume"),
        }),
        new BacktestParameterSpec("alignmentMode", "Counts as in line when", Default: AlignOnTop, Min: AlignOnTop, Max: AlignSurgeOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(AlignOnTop, "Direction's leg is on top"),
            new BacktestParameterOption(AlignSplit, "Split by sign (CE +ve / PE -ve) - stricter"),
            new BacktestParameterOption(AlignOnTopOrSurge, "On top, or a surge - loosest"),
            new BacktestParameterOption(AlignSurgeOnly, "A surge only (the old test)"),
        }),
        new BacktestParameterSpec("lookbackBars1", "Surge window 1 (bars)", Default: 3, Min: 1, Max: 500, Step: 1),
        new BacktestParameterSpec("lookbackBars2", "Surge window 2 (bars)", Default: 5, Min: 1, Max: 500, Step: 1),
        new BacktestParameterSpec("lookbackBars3", "Surge window 3 (bars)", Default: 7, Min: 1, Max: 500, Step: 1),
        new BacktestParameterSpec("lookbackPercent", "Surge threshold (%)", Default: 75, Min: 0, Max: 1000, Step: 5),
        new BacktestParameterSpec("lookbackMode", "Surge windows needed", Default: ModeAny, Min: ModeAny, Max: ModeAll, Step: 1, Options: new[]
        {
            new BacktestParameterOption(ModeAny, "Any one window"),
            new BacktestParameterOption(ModeAll, "Every window"),
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
        var emaFast = (int)parameters["emaFast"];
        var emaSlow = (int)parameters["emaSlow"];
        var confirmWithinBars = (int)parameters["confirmWithinBars"];
        var volumeConfirm = Nearest(parameters["volumeConfirm"], VolumeOff, VolumeEitherSource, VolumeObvOnly, VolumeCdvOnly, VolumeBoth);
        var alignmentMode = Nearest(parameters["alignmentMode"], AlignOnTop, AlignSplit, AlignOnTopOrSurge, AlignSurgeOnly);

        // The surge windows are only consulted by the two alignment modes that include a surge -
        // they are inert otherwise, which is the point of the refactor: the surge went from being
        // the whole test to being one of the ways a source can qualify.
        var surge = new SurgeSettings(
            Percent: parameters["lookbackPercent"],
            RequireAllWindows: parameters["lookbackMode"] >= (ModeAny + ModeAll) / 2,
            Windows: new[] { parameters["lookbackBars1"], parameters["lookbackBars2"], parameters["lookbackBars3"] }
                .Select(v => (int)v)
                .Where(v => v > 0)
                .Distinct()
                .OrderBy(v => v)
                .ToArray());

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var spotCrossings = CrossoverEvents(context.SpotBars, emaFast, emaSlow);
        if (spotCrossings.Count == 0) return (entries, signals);

        // The confirming leg is the ATM contract on the side the spot move points at, taken at the
        // ATM as it stands now - the same series the dashboard's ATM CE/PE charts plot.
        var atmStrike = CurrentAtmStrike(context);
        var ceCrossings = CrossoverEvents(context.GetOptionBars(atmStrike, true), emaFast, emaSlow);
        var peCrossings = CrossoverEvents(context.GetOptionBars(atmStrike, false), emaFast, emaSlow);

        foreach (var (time, direction) in spotCrossings)
        {
            var isBullish = direction == "Bullish";
            var legLabel = isBullish ? "ATM CE" : "ATM PE";

            // Where the CE/PE OBV lines stand at this signal - reported on every row below, so the
            // table shows the volume picture even for the ones that were rejected.
            var ceObv = LineStateAt(context.ObvCeSeries, context.ObvPeSeries, time);
            var peObv = ceObv is null ? null : ceObv == "Up" ? "Down" : "Up";
            BacktestSignal Signal(string kind, string summary) =>
                new(context.Underlying, time, kind, direction, summary) { CeObvCross = ceObv, PeObvCross = peObv };

            // Step 2: the matching leg has to cross UP within the window - CE for a spot breakup,
            // PE for a spot breakdown.
            var legCrossings = isBullish ? ceCrossings : peCrossings;
            if (!ConfirmedWithin(legCrossings, time, confirmWithinBars, context.TimeframeMinutes))
            {
                signals.Add(Signal("Rejected",
                    $"Spot crossed {(isBullish ? "up" : "down")} but {legLabel} did not confirm within {confirmWithinBars} bar(s)"));
                continue;
            }

            // Step 3: the volume has to be in line. Both sources are measured against the DIRECTION
            // of the move - CE for a breakup, PE for a breakdown - NOT against whichever leg the
            // trade happens to be expressed in. The signal is a view on the market; Buy/Sell is only
            // how that view gets traded (a bullish view is a bought CE or a sold PE). Keying this
            // off the traded leg instead would make the two sides fire on different signals entirely
            // and so impossible to compare, which is the whole reason for having the toggle.
            var obv = Align(context.ObvCeSeries, context.ObvPeSeries, time, isBullish, alignmentMode, surge);
            var cdv = Align(context.CdvCeSeries, context.CdvPeSeries, time, isBullish, alignmentMode, surge);

            if (!VolumeSatisfied(volumeConfirm, obv, cdv))
            {
                signals.Add(Signal("Rejected",
                    $"Spot + {legLabel} confirmed, but the volume was not in line - {Failure(volumeConfirm, obv, cdv)}"));
                continue;
            }

            signals.Add(Signal("Entry", $"Spot crossed {(isBullish ? "up" : "down")} + {legLabel} confirmed + {Confirmation(volumeConfirm, obv, cdv)}"));
            entries.Add((time, direction));
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }

    // ---- volume alignment -----------------------------------------------------------------------

    private sealed record SurgeSettings(decimal Percent, bool RequireAllWindows, IReadOnlyList<int> Windows);

    /// <summary>One source's verdict: whether it is in line with the direction, plus the short
    /// phrase that goes in the signal row so the table says WHAT was seen, not just pass/fail.</summary>
    private readonly record struct VolumeAlignment(bool InLine, string Detail)
    {
        public static VolumeAlignment NoData => new(false, "no data");
    }

    /// <summary>Is this CE/PE pair in line with the direction at <paramref name="asOf"/>? Both
    /// series are read at their last point at or before that time, so a source that doesn't reach
    /// back that far (CDV on any day but today) reports "no data" rather than a false verdict - and
    /// with the default OBV-or-CDV setting that costs nothing, since OBV answers instead.</summary>
    private static VolumeAlignment Align(
        IReadOnlyList<ObvPoint> ce, IReadOnlyList<ObvPoint> pe, DateTimeOffset asOf, bool isBullish,
        decimal alignmentMode, SurgeSettings surge)
    {
        var ceIndex = LastIndexAtOrBefore(ce, asOf);
        var peIndex = LastIndexAtOrBefore(pe, asOf);
        if (ceIndex < 0 || peIndex < 0) return VolumeAlignment.NoData;

        var ceValue = ce[ceIndex].Obv;
        var peValue = pe[peIndex].Obv;

        // The direction's leg simply being the higher of the two - the standing arrangement, not a
        // crossing that has to have just happened.
        var onTop = isBullish ? ceValue > peValue : peValue > ceValue;

        // Opposite sides of zero, the right way round. Strict on both, so the flat open (where the
        // day baseline puts everything at zero) is not read as agreement.
        var split = isBullish ? ceValue > 0 && peValue < 0 : peValue > 0 && ceValue < 0;

        var wantsSurge = alignmentMode == AlignOnTopOrSurge || alignmentMode == AlignSurgeOnly;
        var surged = wantsSurge && HasSurged(isBullish ? ce : pe, asOf, surge);

        var inLine = alignmentMode switch
        {
            AlignSplit => split,
            AlignSurgeOnly => surged,
            AlignOnTopOrSurge => onTop || surged,
            _ => onTop,
        };

        var reasons = new List<string>();
        if (onTop) reasons.Add(isBullish ? "CE on top" : "PE on top");
        if (split) reasons.Add("split by sign");
        if (surged) reasons.Add($"surged {surge.Percent:0.#}%");
        var detail = reasons.Count > 0 ? string.Join(" + ", reasons)
            : isBullish ? "CE not on top" : "PE not on top";

        return new VolumeAlignment(inLine, detail);
    }

    private static bool VolumeSatisfied(decimal volumeConfirm, VolumeAlignment obv, VolumeAlignment cdv) => volumeConfirm switch
    {
        VolumeOff => true,
        VolumeObvOnly => obv.InLine,
        VolumeCdvOnly => cdv.InLine,
        VolumeBoth => obv.InLine && cdv.InLine,
        _ => obv.InLine || cdv.InLine,
    };

    private static string Confirmation(decimal volumeConfirm, VolumeAlignment obv, VolumeAlignment cdv) => volumeConfirm switch
    {
        VolumeOff => "no volume filter",
        VolumeObvOnly => $"OBV in line ({obv.Detail})",
        VolumeCdvOnly => $"CDV in line ({cdv.Detail})",
        VolumeBoth => $"OBV ({obv.Detail}) and CDV ({cdv.Detail}) in line",
        // With either-source, name the one that actually carried it rather than implying both did.
        _ => obv.InLine && cdv.InLine ? $"OBV ({obv.Detail}) and CDV ({cdv.Detail}) in line"
            : obv.InLine ? $"OBV in line ({obv.Detail})"
            : $"CDV in line ({cdv.Detail})",
    };

    private static string Failure(decimal volumeConfirm, VolumeAlignment obv, VolumeAlignment cdv) => volumeConfirm switch
    {
        VolumeObvOnly => $"OBV {obv.Detail}",
        VolumeCdvOnly => $"CDV {cdv.Detail}",
        VolumeBoth => obv.InLine ? $"CDV {cdv.Detail}" : cdv.InLine ? $"OBV {obv.Detail}" : $"OBV {obv.Detail}, CDV {cdv.Detail}",
        _ => $"OBV {obv.Detail}, CDV {cdv.Detail}",
    };

    /// <summary>True when the series' %-change into <paramref name="asOf"/> clears the threshold in
    /// magnitude - across EVERY surge window when the settings say so, or across any single one
    /// otherwise. Magnitude, not direction: a violent move either way counts, matching what the Pine
    /// indicator's own threshold check does (it takes math.abs before comparing). The %-change is
    /// the same (current - previous) / |previous| * 100 the lookback tables report, so this asks
    /// exactly the question those tables answer.</summary>
    private static bool HasSurged(IReadOnlyList<ObvPoint> series, DateTimeOffset asOf, SurgeSettings surge)
    {
        var index = LastIndexAtOrBefore(series, asOf);
        if (index < 0 || surge.Windows.Count == 0) return false;

        var anyCleared = false;

        foreach (var window in surge.Windows)
        {
            var previousIndex = index - window;
            // A window reaching back before the series starts can't be judged: that is a failure
            // when every window has to clear, and simply not a qualifying window when any will do.
            if (previousIndex < 0)
            {
                if (surge.RequireAllWindows) return false;
                continue;
            }

            var previous = series[previousIndex].Obv;
            if (previous == 0)
            {
                if (surge.RequireAllWindows) return false;
                continue;
            }

            var changePercent = (series[index].Obv - previous) / Math.Abs(previous) * 100m;
            var cleared = Math.Abs(changePercent) >= surge.Percent;

            if (surge.RequireAllWindows && !cleared) return false;
            anyCleared |= cleared;
        }

        return surge.RequireAllWindows || anyCleared;
    }

    // ---- EMA crossings --------------------------------------------------------------------------

    /// <summary>Every bar where the fast EMA actually crossed the slow one, as opposed to every bar
    /// where it merely sits on one side of it - a direction change from the previous bar's
    /// direction.</summary>
    private static List<(DateTimeOffset Time, string Direction)> CrossoverEvents(IReadOnlyList<Candle> bars, int fastPeriod, int slowPeriod)
    {
        var events = new List<(DateTimeOffset, string)>();
        string? previous = null;

        foreach (var (time, direction) in EmaCrossoverDetector.DirectionSeries(bars, fastPeriod, slowPeriod))
        {
            if (direction is null) continue;
            if (previous is not null && direction != previous) events.Add((time, direction));
            previous = direction;
        }
        return events;
    }

    /// <summary>Was there a bullish crossing close enough to the spot cross to count as confirming
    /// it? Always bullish: a confirming leg crosses UP whether it is a CE leading a rally or a PE
    /// leading a selloff.</summary>
    private static bool ConfirmedWithin(
        List<(DateTimeOffset Time, string Direction)> crossings, DateTimeOffset spotTime, int withinBars, int timeframeMinutes)
    {
        var window = TimeSpan.FromMinutes((withinBars + 1) * timeframeMinutes);
        foreach (var (time, direction) in crossings)
        {
            if (direction != "Bullish") continue;
            if ((time - spotTime).Duration() <= window) return true;
        }
        return false;
    }

    // ---- helpers --------------------------------------------------------------------------------

    /// <summary>Which side of the PE line the CE line is on at <paramref name="asOf"/> - "Up" when
    /// CE is above (the bullish arrangement), "Down" when below, null when neither series reaches
    /// back that far. Reported on every signal row so the table shows the volume picture even for
    /// the rejected ones.</summary>
    private static string? LineStateAt(IReadOnlyList<ObvPoint> ce, IReadOnlyList<ObvPoint> pe, DateTimeOffset asOf)
    {
        var ceIndex = LastIndexAtOrBefore(ce, asOf);
        var peIndex = LastIndexAtOrBefore(pe, asOf);
        if (ceIndex < 0 || peIndex < 0) return null;

        return ce[ceIndex].Obv >= pe[peIndex].Obv ? "Up" : "Down";
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

    /// <summary>Snaps a choice parameter to the nearest declared constant. Choice parameters arrive
    /// as plain decimals (the parameter model is numeric throughout, so the UI can generate itself
    /// from the same metadata), and a stored trigger written before an option was added can carry a
    /// value that no longer lands exactly on one - snapping keeps that on a defined branch rather
    /// than silently falling through to the default arm of a switch.</summary>
    private static decimal Nearest(decimal value, params decimal[] choices) =>
        choices.OrderBy(c => Math.Abs(c - value)).First();

    /// <summary>The ATM strike as of the most recent spot bar - what the confirming CE/PE leg is
    /// read from, mirroring the dashboard's own "ATM CE/PE" charts.</summary>
    private static decimal CurrentAtmStrike(BacktestStrategyContext context)
    {
        if (context.SpotBars.Count == 0 || context.Step <= 0) return 0;
        var lastClose = context.SpotBars[^1].Close;
        return Math.Round(lastClose / context.Step) * context.Step;
    }
}

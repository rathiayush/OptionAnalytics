using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// A classic fast/slow EMA crossover (9/21 by default, both tunable), applied to the underlying's
/// spot bars - distinct from FiveEmaStrategy, which trades a single EMA's alert-candle exhaustion
/// pattern rather than two EMAs crossing.
///
/// Signal: the instant the fast EMA crosses the slow EMA (EmaCrossoverDetector.DirectionSeries,
/// the same fast-vs-slow relationship EmaCrossoverAlertService/ConfluenceAlertService use for their
/// own live alerts, just with tunable periods here instead of the fixed 9/21 those use) - fast
/// above slow is Bullish, fast below slow is Bearish, and a signal fires only the instant that
/// relationship actually CHANGES from the previous bar, not on every bar it continues to hold.
///
/// The slope (trend angle) filter: a bare crossover fires just as readily in a flat, choppy market
/// as a genuine trend - the two EMAs drifting across each other with barely any separation is a
/// classic whipsaw setup. minSlopePercent requires the FAST EMA to actually be moving at the
/// crossover: its percentage change over slopeLookbackBars bars must be at least minSlopePercent in
/// the signal's own direction (rising for a Bullish cross, falling for a Bearish one). Percentage,
/// not raw points or a geometric angle, because a fixed points threshold means something completely
/// different on NIFTY (~24,000) than BANKNIFTY (~52,000), and a true geometric angle needs an
/// arbitrary chart aspect ratio to mean anything at all - percentage slope is the one measure that
/// is directly comparable across instruments and price levels. 0 (the default) disables the filter
/// entirely, taking every crossover regardless of slope.
///
/// Reuses OptionTradeSimulator.Run unchanged (points-based stop-loss/take-profit, one position at a
/// time, EOD exit) - unlike TwoCandleBreakoutStrategy, this strategy's risk is genuinely fixed
/// option-premium points, so it needs no special-cased execution loop and no
/// ILiveOrderPricingStrategy implementation; the existing live-order pipeline already prices it
/// correctly exactly like FiveEmaStrategy.
///
/// RequireAtmConfirmation (off by default) is a second, optional filter alongside the slope one, with
/// two mutually exclusive confirmation sources to pick from:
///
/// - AtmEmaCrossover: the SAME fast/slow EMA crossover, computed the SAME way, must ALSO be
///   confirmed on the ATM CE/PE legs at that instant - CE crossing up AND PE crossing down for a
///   Bullish spot signal, the mirror for Bearish. This is exactly ConfluenceAlertService's own
///   three-leg alignment (spot direction, ATM CE up, ATM PE down, or the bearish mirror), just
///   applied at whatever fastPeriod/slowPeriod this strategy is configured with rather than the
///   fixed 9/21 Confluence always uses - one shared pair of periods governing all three legs, so
///   tuning the crossover speed for spot automatically retunes the option-side confirmation the
///   same way instead of the two silently drifting apart.
/// - CePePremiumCrossover: a simpler, EMA-free check - whichever of the ATM CE/PE premiums is
///   currently the higher one, raw Close vs Close, must agree with the spot direction (CE above PE
///   confirms Bullish, PE above CE confirms Bearish). No periods of its own, so it reacts the
///   instant the premiums themselves cross rather than waiting for their own EMAs to catch up.
///
/// BacktestStrategyContext.AtmCeBars/AtmPeBars are the same aggregated ATM series BacktestService's
/// own Confluence replay uses, so "ATM CE" and "ATM PE" here mean the exact same contracts as
/// everywhere else in this app - reused directly rather than re-deriving ATM tracking.
///
/// AtmShift moves either confirmation off the exact ATM strike to one strike ITM (-1) or OTM (+1) -
/// the SAME strike for both CE and PE (e.g. ATM+1*Step's own CE and PE, not a call and a put at two
/// different strikes), via GetOptionBars(AtmStrike + shift*Step, isCall) rather than
/// AtmCeBars/AtmPeBars, since those two only ever cover the exact ATM strike. 0 (the default) keeps
/// using AtmCeBars/AtmPeBars directly - no behavior change from before this parameter existed.
/// </summary>
public sealed class EmaCrossoverStrategy : IBacktestStrategy
{
    public string Key => "ema-9-21-crossover";
    public string Name => "9/21 EMA Crossover";
    public string Description => "Enters the instant the fast EMA crosses the slow EMA (9/21 by default, both tunable) - fast above slow is Bullish, fast below slow is Bearish. An optional slope filter requires the fast EMA to actually be trending at the crossover. A second optional filter requires the same crossover to also be confirmed on the option side - either the ATM CE/PE legs' own EMA crossover (CE up + PE down for Bullish, or the bearish mirror), or simply whichever of ATM CE/PE premium is currently higher - optionally shifted one strike ITM or OTM instead of the exact ATM.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    private const decimal ConfirmOff = 0;
    private const decimal ConfirmAtmEmaCrossover = 1;
    private const decimal ConfirmCePePremiumCrossover = 2;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.StopLossParameter(),
        OptionTradeSimulator.TakeProfitParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        OptionTradeSimulator.SignalStartTimeParameter(),
        new BacktestParameterSpec("fastPeriod", "Fast EMA (bars)", Default: EmaCrossoverDetector.FastPeriod, Min: 1, Max: 100, Step: 1),
        new BacktestParameterSpec("slowPeriod", "Slow EMA (bars)", Default: EmaCrossoverDetector.SlowPeriod, Min: 2, Max: 200, Step: 1),
        new BacktestParameterSpec("minSlopePercent", "Min fast-EMA slope at crossover, % (0 = off)", Default: 0, Min: 0, Max: 10, Step: 0.05m),
        new BacktestParameterSpec("slopeLookbackBars", "Slope measured over (bars)", Default: 3, Min: 1, Max: 50, Step: 1),
        new BacktestParameterSpec("requireAtmConfirmation", "Also require the option side to confirm", Default: ConfirmOff, Min: ConfirmOff, Max: ConfirmCePePremiumCrossover, Step: 1, Options: new[]
        {
            new BacktestParameterOption(ConfirmOff, "No - spot crossover alone"),
            new BacktestParameterOption(ConfirmAtmEmaCrossover, "Yes - ATM CE/PE EMA crossover must confirm too"),
            new BacktestParameterOption(ConfirmCePePremiumCrossover, "Yes - ATM CE vs PE premium crossover must confirm too"),
        }),
        new BacktestParameterSpec("atmShift", "ATM confirmation strike (only used when the above is Yes)", Default: 0, Min: -1, Max: 1, Step: 1, Options: new[]
        {
            new BacktestParameterOption(-1, "1 ITM"),
            new BacktestParameterOption(0, "Exactly ATM"),
            new BacktestParameterOption(1, "1 OTM"),
        }),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Bullish crossovers only (buy CE)"),
            new BacktestParameterOption(DirectionShortOnly, "Bearish crossovers only (buy PE)"),
        }),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters);

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var fastPeriod = (int)parameters["fastPeriod"];
        var slowPeriod = (int)parameters["slowPeriod"];
        var minSlopePercent = parameters["minSlopePercent"];
        var slopeLookback = Math.Max(1, (int)parameters["slopeLookbackBars"]);
        var confirmationMode = parameters.GetValueOrDefault("requireAtmConfirmation", ConfirmOff);
        var atmShift = (int)parameters.GetValueOrDefault("atmShift", 0);
        var direction = parameters["direction"];
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);

        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var bars = context.SpotBars;
        if (fastPeriod < 1 || slowPeriod < 1 || fastPeriod >= slowPeriod)
            return (entries, signals); // same guard EmaCrossoverDetector itself applies - nothing to detect

        var directionSeries = EmaCrossoverDetector.DirectionSeries(bars, fastPeriod, slowPeriod);
        var fastEma = EmaCrossoverDetector.EmaSeries(bars, fastPeriod);

        // atmShift 0 keeps using AtmCeBars/AtmPeBars directly (the exact ATM strike, already
        // resolved once by BacktestService's own replay); a nonzero shift instead asks
        // GetOptionBars for the ONE strike ATM+shift*Step steps away - the same strike for both CE
        // and PE (an ITM/OTM level, not a call and a put diverging to two different strikes) -
        // since AtmCeBars/AtmPeBars only ever cover the exact ATM contract. context.AtmStrike is
        // null until CDV has resolved an ATM at least once, in which case a shifted lookup has
        // nothing to ask for and behaves the same as "no ATM history yet" below.
        var atmStrike = context.AtmStrike;
        var atmCeBars = atmShift == 0 || atmStrike is null ? context.AtmCeBars : context.GetOptionBars(atmStrike.Value + atmShift * context.Step, true);
        var atmPeBars = atmShift == 0 || atmStrike is null ? context.AtmPeBars : context.GetOptionBars(atmStrike.Value + atmShift * context.Step, false);
        var atmStrikeLabel = atmShift == 0 || atmStrike is null ? "ATM" : atmShift < 0 ? $"ATM{atmShift * context.Step} ({-atmShift} ITM)" : $"ATM+{atmShift * context.Step} ({atmShift} OTM)";

        // Same fast/slow relationship, same periods, just computed off the ATM CE/PE legs instead
        // of spot - built once here (not per-bar) and looked up by time, same "keyed by bucket-start
        // Time" alignment every other strategy's cross-series lookup already relies on.
        var ceDirectionByTime = confirmationMode == ConfirmAtmEmaCrossover
            ? EmaCrossoverDetector.DirectionSeries(atmCeBars, fastPeriod, slowPeriod).ToDictionary(d => d.Time, d => d.Direction)
            : null;
        var peDirectionByTime = confirmationMode == ConfirmAtmEmaCrossover
            ? EmaCrossoverDetector.DirectionSeries(atmPeBars, fastPeriod, slowPeriod).ToDictionary(d => d.Time, d => d.Direction)
            : null;

        // No EMA of its own - just whichever of CE/PE premium is currently the higher one, by raw
        // Close vs Close, keyed by the same bucket-start Time alignment as everything else here.
        var cePeDirectionByTime = confirmationMode == ConfirmCePePremiumCrossover
            ? BuildCePeDirectionByTime(atmCeBars, atmPeBars)
            : null;

        string? previousDirection = null;

        for (var i = 0; i < bars.Count; i++)
        {
            var current = directionSeries[i].Direction;
            // A null here means "not enough bars yet" or "an exact tie" - not a real direction, so
            // it neither counts as a crossover nor overwrites what the last real direction was,
            // same tolerance BacktestService.TryUpdateLeg gives its own leg-tracking.
            if (current is null) continue;
            if (current == previousDirection) continue; // holding, not crossing

            var bar = bars[i];
            var isBullish = current == "Bullish";
            var crossLabel = isBullish ? $"fast EMA({fastPeriod}) crossed above slow EMA({slowPeriod})" : $"fast EMA({fastPeriod}) crossed below slow EMA({slowPeriod})";

            var passesSlope = true;
            decimal? slopePercent = null;
            if (minSlopePercent > 0)
            {
                var lookbackIndex = i - slopeLookback;
                if (lookbackIndex < 0 || fastEma[i] is not { } emaNow || fastEma[lookbackIndex] is not { } emaThen || emaThen == 0)
                {
                    passesSlope = false; // not enough history to measure a slope yet - treat as filtered out, never as an unconditional pass
                }
                else
                {
                    slopePercent = (emaNow - emaThen) / Math.Abs(emaThen) * 100;
                    passesSlope = isBullish ? slopePercent >= minSlopePercent : slopePercent <= -minSlopePercent;
                }
            }

            var passesAtm = true;
            string? atmRejectReason = null;
            if (confirmationMode == ConfirmAtmEmaCrossover)
            {
                var hasCe = ceDirectionByTime!.TryGetValue(bar.Time, out var ceDirection);
                var hasPe = peDirectionByTime!.TryGetValue(bar.Time, out var peDirection);
                if (!hasCe || !hasPe || ceDirection is null || peDirection is null)
                {
                    passesAtm = false;
                    atmRejectReason = $"not enough {atmStrikeLabel} CE/PE history yet";
                }
                else if (isBullish ? !(ceDirection == "Bullish" && peDirection == "Bearish") : !(peDirection == "Bullish" && ceDirection == "Bearish"))
                {
                    passesAtm = false;
                    atmRejectReason = isBullish
                        ? $"{atmStrikeLabel} CE/PE did not confirm (CE {ceDirection}, PE {peDirection}) - needed CE up + PE down"
                        : $"{atmStrikeLabel} CE/PE did not confirm (CE {ceDirection}, PE {peDirection}) - needed PE up + CE down";
                }
            }
            else if (confirmationMode == ConfirmCePePremiumCrossover)
            {
                var hasCePe = cePeDirectionByTime!.TryGetValue(bar.Time, out var cePeDirection);
                if (!hasCePe || cePeDirection is null)
                {
                    passesAtm = false;
                    atmRejectReason = $"not enough {atmStrikeLabel} CE/PE premium history yet";
                }
                else if (isBullish ? cePeDirection != "Bullish" : cePeDirection != "Bearish")
                {
                    passesAtm = false;
                    atmRejectReason = isBullish
                        ? $"{atmStrikeLabel} CE/PE premium did not confirm (PE above CE) - needed CE above PE"
                        : $"{atmStrikeLabel} CE/PE premium did not confirm (CE above PE) - needed PE above CE";
                }
            }

            // Before slope/direction filters: a bar timestamped inside the pre-open call auction
            // can never be a real signal, whatever it prints - see SignalStartTimeParameter's own
            // doc comment.
            if (signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current,
                    $"{crossLabel} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
            }
            else if (!passesSlope)
            {
                var slopeText = slopePercent is { } sp ? $"{sp:0.###}%" : "not enough history yet";
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current,
                    $"{crossLabel}, but fast-EMA slope ({slopeText}) is under the {minSlopePercent:0.###}% minimum - skipped"));
            }
            else if (!passesAtm)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{crossLabel}, but {atmRejectReason} - skipped"));
            }
            else if (isBullish && !takeLongs)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{crossLabel} - skipped, bearish only"));
            }
            else if (!isBullish && !takeShorts)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{crossLabel} - skipped, bullish only"));
            }
            else
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", current, crossLabel));
                entries.Add((bar.Time, current));
            }

            previousDirection = current;
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }

    /// <summary>Raw Close-vs-Close comparison between the CE and PE series, keyed by bucket-start
    /// Time - "Bullish" means CE currently trades above PE, "Bearish" means PE above CE, null means
    /// an exact tie (same tolerance EmaCrossoverDetector.DirectionSeries gives its own ties). No EMA
    /// smoothing of its own, unlike ceDirectionByTime/peDirectionByTime above - this is a same-instant
    /// premium comparison, not a crossover-detection series.</summary>
    private static Dictionary<DateTimeOffset, string?> BuildCePeDirectionByTime(IReadOnlyList<Candle> ceBars, IReadOnlyList<Candle> peBars)
    {
        var peCloseByTime = peBars.ToDictionary(b => b.Time, b => b.Close);
        var result = new Dictionary<DateTimeOffset, string?>();
        foreach (var ce in ceBars)
        {
            if (!peCloseByTime.TryGetValue(ce.Time, out var peClose)) continue;
            result[ce.Time] = ce.Close == peClose ? null : ce.Close > peClose ? "Bullish" : "Bearish";
        }
        return result;
    }
}

using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// Three things having to agree before a trade is taken:
///
///   1. SPOT's fast EMA crosses its slow EMA - the direction call.
///   2. The ATM option being BOUGHT makes the same fast/slow EMA cross on its OWN premium - the CE
///      for a bullish signal, the PE for a bearish one. Spot turning is a view; the contract you
///      would actually buy turning is the same view priced.
///   3. Order flow is RISING over the last N bars on that same leg - OBV, CDV, either, or both,
///      whichever this trigger is configured to demand.
///
/// Why the option leg is checked separately rather than assumed from spot: an index EMA cross says
/// nothing about what the option chain did with it. Premium is moved by implied volatility and time
/// decay as much as by direction, so a spot cross into a collapsing IV can leave the very contract
/// the signal implies buying flat or falling. Requiring the leg's own cross is what makes this a
/// confirmation rather than a restatement.
///
/// ALIGNMENT, and why it is a window rather than "the same bar". Spot and an option contract close
/// their bars on the same clock but do not cross on the same bar - the option's EMAs sit on a series
/// with its own noise, and a cross that "confirms" a spot signal routinely lands a bar or two either
/// side of it. Demanding the identical bar would reject almost every real setup, so the option's
/// cross only has to have happened within AtmConfirmWithinBars of the spot cross (0 for the strict
/// same-bar reading). The window looks BACKWARD only: a confirmation that has not happened yet at
/// the moment of entry is not available to trade on, and counting it would be look-ahead.
/// </summary>
public sealed class EmaCrossAtmFlowStrategy : IBacktestStrategy
{
    public string Key => "ema-cross-atm-flow";
    public string Name => "EMA Crossover + ATM Cross + Rising Flow";
    public string Description => "Enters when THREE things agree: spot's fast EMA crosses its slow EMA, the ATM option being bought makes the same fast/slow cross on its own premium (CE for bullish, PE for bearish) within a short window, and order flow on that leg is rising over the last N bars (OBV, CDV, either, or both - configurable). The option leg is checked separately because premium moves with implied volatility and decay as well as direction, so a spot cross alone says nothing about what the contract you would actually buy did.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    /// <summary>Which flow measure has to be rising. OBV and CDV answer different questions - OBV is
    /// a running signed-volume total across the session, CDV a delta-weighted one that restarts each
    /// day (see BacktestStrategyContext) - so "either" is a genuinely looser filter than either alone
    /// and "both" a genuinely stricter one, rather than two spellings of the same test.</summary>
    private const decimal FlowObvOnly = 0;
    private const decimal FlowCdvOnly = 1;
    private const decimal FlowEither = 2;
    private const decimal FlowBoth = 3;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.StopLossParameter(),
        OptionTradeSimulator.TakeProfitParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        OptionTradeSimulator.SignalStartTimeParameter(),
        new BacktestParameterSpec("fastEmaPeriod", "Fast EMA (bars)", Default: 9, Min: 1, Max: 200, Step: 1),
        new BacktestParameterSpec("slowEmaPeriod", "Slow EMA (bars)", Default: 21, Min: 2, Max: 400, Step: 1),
        new BacktestParameterSpec("atmConfirmWithinBars", "ATM cross must land within (bars, 0 = same bar)", Default: 3, Min: 0, Max: 50, Step: 1),
        new BacktestParameterSpec("flowLookbackBars", "Flow rising over (bars)", Default: 5, Min: 1, Max: 200, Step: 1),
        new BacktestParameterSpec("flowMode", "Flow must be rising on", Default: FlowEither, Min: FlowObvOnly, Max: FlowBoth, Step: 1, Options: new[]
        {
            new BacktestParameterOption(FlowObvOnly, "OBV only"),
            new BacktestParameterOption(FlowCdvOnly, "CDV only"),
            new BacktestParameterOption(FlowEither, "Either OBV or CDV"),
            new BacktestParameterOption(FlowBoth, "Both OBV and CDV"),
        }),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Longs only"),
            new BacktestParameterOption(DirectionShortOnly, "Shorts only"),
        }),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters, null);

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var fastPeriod = (int)parameters["fastEmaPeriod"];
        var slowPeriod = (int)parameters["slowEmaPeriod"];
        var confirmWithin = (int)parameters["atmConfirmWithinBars"];
        var flowLookback = (int)parameters["flowLookbackBars"];
        var flowMode = parameters["flowMode"];
        var direction = parameters["direction"];
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        // A fast EMA that is not actually faster makes every "cross" meaningless - the two lines
        // would be the same series, or inverted. Rejected outright rather than silently producing
        // nonsense trades.
        if (fastPeriod >= slowPeriod) return (entries, signals);

        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        var bars = context.SpotBars;
        var spotFast = EmaCrossoverDetector.EmaSeries(bars, fastPeriod);
        var spotSlow = EmaCrossoverDetector.EmaSeries(bars, slowPeriod);

        // The option legs' own cross times, computed once per side rather than per signal.
        var ceCrossUps = CrossUpTimes(context.AtmCeBars, fastPeriod, slowPeriod);
        var peCrossUps = CrossUpTimes(context.AtmPeBars, fastPeriod, slowPeriod);

        // A bar-count window is converted to a time window because the option leg's series is
        // indexed separately from spot's - only timestamps line the two up.
        var window = TimeSpan.FromMinutes((double)Math.Max(0, confirmWithin) * Math.Max(1, context.TimeframeMinutes));
        var flowWindow = TimeSpan.FromMinutes((double)Math.Max(1, flowLookback) * Math.Max(1, context.TimeframeMinutes));

        DateOnly? currentDay = null;

        for (var i = 1; i < bars.Count; i++)
        {
            var bar = bars[i];

            // Nothing carries overnight: an opening gap can flip the EMA relationship between the
            // last bar of one session and the first of the next without any trade taking place, so
            // the first bar of a day never counts as a cross.
            var day = BacktestUtil.IstDate(bar.Time);
            var isFirstBarOfDay = currentDay != day;
            currentDay = day;
            if (isFirstBarOfDay) continue;

            if (!CrossedUp(spotFast, spotSlow, i, out var bullish)) continue;
            if (bullish ? !takeLongs : !takeShorts)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bullish ? "Bullish" : "Bearish",
                    $"Spot {fastPeriod}/{slowPeriod} EMA crossed {(bullish ? "up" : "down")} - skipped, {(bullish ? "shorts" : "longs")} only"));
                continue;
            }

            var legName = bullish ? "CE" : "PE";
            var summary = $"Spot {fastPeriod}/{slowPeriod} EMA crossed {(bullish ? "up" : "down")}";

            if (signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bullish ? "Bullish" : "Bearish",
                    $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
                continue;
            }

            // Confirmation 2: the leg being bought made the same cross, recently enough to count.
            var legCrossUps = bullish ? ceCrossUps : peCrossUps;
            if (!CrossedWithin(legCrossUps, bar.Time, window))
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bullish ? "Bullish" : "Bearish",
                    $"{summary} - but the ATM {legName} made no {fastPeriod}/{slowPeriod} cross of its own within {confirmWithin} bar(s)"));
                continue;
            }

            // Confirmation 3: flow rising on that leg over the lookback.
            var obv = bullish ? context.ObvCeSeries : context.ObvPeSeries;
            var cdv = bullish ? context.CdvCeSeries : context.CdvPeSeries;
            var obvRising = IsRising(obv, bar.Time, flowWindow);
            var cdvRising = IsRising(cdv, bar.Time, flowWindow);

            if (!FlowConfirms(flowMode, obvRising, cdvRising))
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bullish ? "Bullish" : "Bearish",
                    $"{summary}, ATM {legName} confirmed - but flow is not rising as required ({FlowModeLabel(flowMode)}; OBV {(obvRising ? "rising" : "flat/falling")}, CDV {(cdvRising ? "rising" : "flat/falling")}) over the last {flowLookback} bar(s)"));
                continue;
            }

            var full = $"{summary}, ATM {legName} crossed with it, and flow is rising ({FlowModeLabel(flowMode)}) over the last {flowLookback} bar(s)";
            signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", bullish ? "Bullish" : "Bearish", full));
            entries.Add((bar.Time, bullish ? "Bullish" : "Bearish"));
        }

        return (entries, signals);
    }

    /// <summary>Whether bar <paramref name="i"/> is the bar the fast line crossed the slow one on,
    /// and which way. A cross needs BOTH bars readable - a null either side is "no opinion yet",
    /// never a cross.</summary>
    internal static bool CrossedUp(IReadOnlyList<decimal?> fast, IReadOnlyList<decimal?> slow, int i, out bool bullish)
    {
        bullish = false;
        if (i <= 0 || i >= fast.Count || i >= slow.Count) return false;
        if (fast[i] is not { } f || slow[i] is not { } s) return false;
        if (fast[i - 1] is not { } pf || slow[i - 1] is not { } ps) return false;

        if (pf <= ps && f > s) { bullish = true; return true; }
        if (pf >= ps && f < s) { bullish = false; return true; }
        return false;
    }

    /// <summary>Every time the fast EMA of <paramref name="bars"/> crossed ABOVE its slow EMA -
    /// which on an option premium means that contract getting bid up, whichever side it is. A PE
    /// rising is the bearish confirmation precisely because it is the PE that gets bought when spot
    /// falls, so both sides look for the same upward cross on their own leg.</summary>
    internal static List<DateTimeOffset> CrossUpTimes(IReadOnlyList<Candle> bars, int fastPeriod, int slowPeriod)
    {
        var times = new List<DateTimeOffset>();
        if (bars.Count == 0) return times;

        var fast = EmaCrossoverDetector.EmaSeries(bars, fastPeriod);
        var slow = EmaCrossoverDetector.EmaSeries(bars, slowPeriod);

        DateOnly? currentDay = null;
        for (var i = 1; i < bars.Count; i++)
        {
            var day = BacktestUtil.IstDate(bars[i].Time);
            var isFirstBarOfDay = currentDay != day;
            currentDay = day;
            if (isFirstBarOfDay) continue; // same overnight-gap rule spot uses

            if (CrossedUp(fast, slow, i, out var bullish) && bullish) times.Add(bars[i].Time);
        }

        return times;
    }

    /// <summary>Whether any of <paramref name="crossTimes"/> lands in the window ENDING at
    /// <paramref name="at"/>. Backward-looking only: a confirmation that has not happened yet at the
    /// moment of entry could not have been acted on, and counting it would be look-ahead.</summary>
    internal static bool CrossedWithin(IReadOnlyList<DateTimeOffset> crossTimes, DateTimeOffset at, TimeSpan window)
    {
        var from = at - window;
        foreach (var time in crossTimes)
            if (time >= from && time <= at) return true;
        return false;
    }

    /// <summary>Whether a flow series is HIGHER at <paramref name="at"/> than it was one
    /// <paramref name="window"/> earlier. Both ends are read as "the last point at or before this
    /// time" so the comparison works on a series whose bars do not line up exactly with spot's -
    /// and false when either end has no reading at all, since "no data" is not "rising".</summary>
    internal static bool IsRising(IReadOnlyList<ObvPoint> series, DateTimeOffset at, TimeSpan window)
    {
        var now = LastAtOrBefore(series, at);
        var then = LastAtOrBefore(series, at - window);
        if (now is not { } current || then is not { } earlier) return false;
        return current > earlier;
    }

    private static decimal? LastAtOrBefore(IReadOnlyList<ObvPoint> series, DateTimeOffset at)
    {
        decimal? value = null;
        foreach (var point in series)
        {
            if (point.Time > at) break; // series is time-ascending
            value = point.Obv;
        }
        return value;
    }

    internal static bool FlowConfirms(decimal flowMode, bool obvRising, bool cdvRising) => flowMode switch
    {
        FlowObvOnly => obvRising,
        FlowCdvOnly => cdvRising,
        FlowBoth => obvRising && cdvRising,
        _ => obvRising || cdvRising,
    };

    private static string FlowModeLabel(decimal flowMode) => flowMode switch
    {
        FlowObvOnly => "OBV",
        FlowCdvOnly => "CDV",
        FlowBoth => "OBV and CDV",
        _ => "OBV or CDV",
    };
}

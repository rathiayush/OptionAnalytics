using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// A trend-continuation "structure" setup (source: a "20 & 50 EMA" reel the user asked to have
/// added verbatim, adapted from a spot-Gold trade recommendation to this app's own index-option
/// trading), in four steps:
///
///   1. Price closes clear above (bullish) or below (bearish) BOTH EMAs - the trend bias.
///   2. The fast/slow EMA relationship confirms that same bias on that same bar - the crossover.
///      Steps 1 and 2 are one combined event: EmaCrossoverDetector.DirectionSeries already
///      requires exactly this (a confirmed bias needs the close beyond both lines, not just the
///      EMAs swapping order - see its own doc comment for why that distinction matters), so a
///      transition into "Bullish"/"Bearish" on this series IS "wait for price above both AND wait
///      for the crossover" in one step, not two separately-tracked conditions.
///   3. RequiredRetests pullbacks to the FAST EMA that each bounce (a bar whose Low/High touches
///      or crosses it but whose Close ends back on the trend side) - the same wick-and-hold
///      pattern SrFlowSellStrategy calls a "rejection", just against a moving average instead of a
///      fixed level. The pending setup is abandoned (no entry) if price closes through the SLOW
///      EMA - against the bias - before completing all of them; a fresh crossover always restarts
///      the count at zero.
///   4. Entry fires on the bar the LAST required retest itself confirms ("enter on
///      confirmation") - not a bar after it.
///
/// UNLIKE SrFlowSellStrategy, this is a plain trend-following continuation (buy the direction, not
/// sell against it) - "side" is left at OptionTradeSimulator's own Buy default, still overridable.
///
/// EXITS: the taught rule ("SL: below 50 EMA", "TP: break of 50 EMA") is a level and a RULE, not
/// two premium numbers - and, per OptionTradeSimulator's own doc comment (see FiveEmaStrategy for
/// the precedent), a SPOT-point distance does not convert to a premium-point one at a fixed rate
/// (that ratio is the option's delta, which moves), so this app's usual points-based SL/TP stands
/// in for "below the 50 EMA" instead of trying to price that distance directly. "TP: break of 50
/// EMA" DOES translate directly, though - it is a condition, not a distance - via ExitOnEmaBreak
/// (on by default, "the taught target"): once a position is open, it also exits the moment spot
/// CLOSES back through the 50 EMA against the direction traded, computed once per trade (see
/// BuildEmaBreakExits) via OptionTradeSimulator's own signalExits mechanism - the correct one here
/// rather than forcedExitTimes, since a break is DIRECTIONAL (a bullish trade exits on a break
/// DOWN, a bearish one on a break UP - a single shared list of either direction would not
/// distinguish them the way FiveEmaStrategy's own symmetric "touch" exit safely can).
///
/// OPTIONAL flow confirmation (RequireFlowConfirmation, off by default): the same OBV/CDV series
/// SrFlowSellStrategy already reads (context.ObvCeSeries/CdvCeSeries etc. - summed across the
/// whole live-tracked ATM+-16 strike chain on Backtrack, or Expired Backtest's own wider
/// reconstruction when this parameter is on - see ExpiredOptionBacktestService's own
/// needsFlowChain), checked once, at the entry bar itself: the traded leg's OBV/CDV (CE for a
/// bullish entry, PE for a bearish one) has to be both ABOVE the other leg and RISING over
/// FlowLookbackBars bars - the same ordering-and-rising definition EmaCrossAtmFlowStrategy's own
/// (since-removed) FlowConfirmation class used, reimplemented here directly rather than resurrecting
/// a shared class for what only this one strategy currently needs beyond SrFlowSellStrategy's own
/// (differently-shaped, acceleration-based) check.
/// </summary>
public sealed class EmaCrossoverRetestStrategy : IBacktestStrategy
{
    public string Key => "ema-crossover-retest";
    public string Name => "EMA Crossover + 2 Retests (structure)";
    public string Description => "Price confirms above (or below) both a fast and slow EMA together with the EMA crossover itself, then waits for the fast EMA to be retested and hold a configured number of times before entering on the last one's own confirmation. Trades WITH the trend (buy by default). Optionally exits when spot closes back through the slow EMA against the trade, on by default.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    private const decimal FlagOff = 0;
    private const decimal FlagOn = 1;

    private const decimal ModeObvOnly = 0;
    private const decimal ModeCdvOnly = 1;
    private const decimal ModeEither = 2;
    private const decimal ModeBoth = 3;

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
        new BacktestParameterSpec("fastEmaPeriod", "Fast EMA (bars)", Default: 20, Min: 1, Max: 200, Step: 1),
        new BacktestParameterSpec("slowEmaPeriod", "Slow EMA (bars)", Default: 50, Min: 2, Max: 400, Step: 1),
        new BacktestParameterSpec("requiredRetests", "Retests of the fast EMA required before entry", Default: 2, Min: 1, Max: 10, Step: 1),
        new BacktestParameterSpec("exitOnEmaBreak", "Exit when spot closes back through the slow EMA", Default: FlagOn, Min: FlagOff, Max: FlagOn, Step: 1, Options: new[]
        {
            new BacktestParameterOption(FlagOn, "Yes - the taught target"),
            new BacktestParameterOption(FlagOff, "No - stop/target only"),
        }),
        // Optional and off by default, so the setup as described is unaffected unless deliberately
        // turned on - see this class's own doc comment for exactly what it checks.
        new BacktestParameterSpec("requireFlowConfirmation", "Also require order flow (OBV/CDV) to confirm", Default: FlagOff, Min: FlagOff, Max: FlagOn, Step: 1, Options: new[]
        {
            new BacktestParameterOption(FlagOff, "No - structure only"),
            new BacktestParameterOption(FlagOn, "Yes - flow must favor + rise toward the entry"),
        }),
        new BacktestParameterSpec("flowLookbackBars", "Flow must be rising over (bars)", Default: 5, Min: 1, Max: 200, Step: 1),
        new BacktestParameterSpec("flowMode", "Flow must favor + rise toward the entry on", Default: ModeEither, Min: ModeObvOnly, Max: ModeBoth, Step: 1, Options: new[]
        {
            new BacktestParameterOption(ModeObvOnly, "OBV only"),
            new BacktestParameterOption(ModeCdvOnly, "CDV only"),
            new BacktestParameterOption(ModeEither, "Either OBV or CDV"),
            new BacktestParameterOption(ModeBoth, "Both OBV and CDV"),
        }),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var evaluation = Evaluate(context, parameters);
        var exitOnBreak = parameters.GetValueOrDefault("exitOnEmaBreak", FlagOn) >= (FlagOff + FlagOn) / 2;
        return OptionTradeSimulator.Run(context, evaluation.Entries, parameters, signalExits: exitOnBreak ? evaluation.EmaBreakExits : null);
    }

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private sealed record PendingSetup(bool Bullish, DateTimeOffset CrossoverTime, int RetestsSeen);

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals, Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)> EmaBreakExits) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var direction = parameters["direction"];
        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);
        var fastPeriod = Math.Max(1, (int)parameters["fastEmaPeriod"]);
        var slowPeriod = Math.Max(fastPeriod + 1, (int)parameters["slowEmaPeriod"]);
        var requiredRetests = Math.Max(1, (int)parameters["requiredRetests"]);
        var requireFlowConfirmation = parameters.GetValueOrDefault("requireFlowConfirmation", FlagOff) >= (FlagOff + FlagOn) / 2;
        var flowLookbackBars = Math.Max(1, (int)parameters.GetValueOrDefault("flowLookbackBars", 5));
        var flowMode = parameters.GetValueOrDefault("flowMode", ModeEither);

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();
        var entryIndexes = new List<(int Index, DateTimeOffset Time, bool Bullish)>();

        var bars = context.SpotBars;
        var emaBreakExits = new Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)>();
        if (bars.Count == 0) return (entries, signals, emaBreakExits);

        var confirmedDirection = EmaCrossoverDetector.DirectionSeries(bars, fastPeriod, slowPeriod);
        var emaFast = EmaCrossoverDetector.EmaSeries(bars, fastPeriod);
        var emaSlow = EmaCrossoverDetector.EmaSeries(bars, slowPeriod);

        PendingSetup? pending = null;
        string? prevDirection = null;

        for (var i = 0; i < bars.Count; i++)
        {
            var bar = bars[i];
            var curDirection = confirmedDirection[i].Direction;
            var beforeSignalStart = signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes;

            // Step 3's own abandonment rule: a close through the slow EMA against the pending
            // setup's own bias means the structure that justified waiting for retests is gone.
            if (pending is { } inv && emaSlow[i] is { } slowInv)
            {
                var broken = inv.Bullish ? bar.Close < slowInv : bar.Close > slowInv;
                if (broken) pending = null;
            }

            // Step 3/4: a retest of the fast EMA that holds - counts toward, and on the LAST one,
            // fires entry ("enter on confirmation").
            if (pending is { } p && emaFast[i] is { } fastVal)
            {
                var retested = p.Bullish ? bar.Low <= fastVal && bar.Close > fastVal : bar.High >= fastVal && bar.Close < fastVal;
                if (retested)
                {
                    var seen = p.RetestsSeen + 1;
                    if (seen >= requiredRetests)
                    {
                        var dir = p.Bullish ? "Bullish" : "Bearish";
                        var summary = $"Crossover confirmed at {p.CrossoverTime:HH:mm} ({fastPeriod}/{slowPeriod} EMA) - retest {seen}/{requiredRetests} of the {fastPeriod} EMA just held";
                        if (beforeSignalStart)
                        {
                            signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
                        }
                        else if (p.Bullish && !takeLongs)
                        {
                            signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{summary} - skipped, bearish only"));
                        }
                        else if (!p.Bullish && !takeShorts)
                        {
                            signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{summary} - skipped, bullish only"));
                        }
                        else
                        {
                            var (flowOk, flowReason) = FlowCheck(context, bar.Time, p.Bullish, requireFlowConfirmation, flowLookbackBars, flowMode);
                            if (!flowOk)
                            {
                                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{summary} - but {flowReason}"));
                            }
                            else
                            {
                                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", dir, requireFlowConfirmation ? $"{summary}, and {flowReason}" : summary));
                                entries.Add((bar.Time, dir));
                                entryIndexes.Add((i, bar.Time, p.Bullish));
                            }
                        }
                        pending = null;
                    }
                    else
                    {
                        pending = p with { RetestsSeen = seen };
                    }
                }
            }

            // Step 1+2: a fresh confirmed-direction transition always restarts the count, even one
            // that immediately replaces a setup still waiting on retests - a brand new crossover is
            // a brand new structure to judge on its own.
            if (curDirection == "Bullish" && prevDirection != "Bullish") pending = new PendingSetup(true, bar.Time, 0);
            else if (curDirection == "Bearish" && prevDirection != "Bearish") pending = new PendingSetup(false, bar.Time, 0);

            prevDirection = curDirection;
        }

        // ExitOnEmaBreak's own per-trade exit time - walked forward from each entry independently
        // (see this class's own doc comment for why signalExits, not forcedExitTimes, is the
        // correct mechanism for a DIRECTIONAL break condition).
        foreach (var (entryIndex, entryTime, bullish) in entryIndexes)
        {
            for (var j = entryIndex + 1; j < bars.Count; j++)
            {
                if (emaSlow[j] is not { } slowVal) continue;
                var broke = bullish ? bars[j].Close < slowVal : bars[j].Close > slowVal;
                if (broke)
                {
                    emaBreakExits[entryTime] = (bars[j].Time, $"Break of the {slowPeriod} EMA");
                    break;
                }
            }
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList(), emaBreakExits);
    }

    /// <summary>Optional (see requireFlowConfirmation's own doc comment) - CE for a Bullish entry,
    /// PE for a Bearish one, the same leg OptionTradeSimulator's own default Buy side would
    /// actually buy for that direction. True (no reason given) when the filter is off. "Favors"
    /// means both ordering (the traded leg above the other, right now) AND rising (that leg higher
    /// now than one flowLookbackBars-bar window earlier) - the same combination this app settled on
    /// for EmaCrossAtmFlowStrategy's own (since-removed) flow gate.</summary>
    private static (bool Ok, string Reason) FlowCheck(
        BacktestStrategyContext context, DateTimeOffset at, bool bullish, bool requireFlowConfirmation, int lookbackBars, decimal flowMode)
    {
        if (!requireFlowConfirmation) return (true, "");

        var window = TimeSpan.FromMinutes(Math.Max(1, context.TimeframeMinutes) * lookbackBars);

        bool? Favors(IReadOnlyList<ObvPoint> ceSeries, IReadOnlyList<ObvPoint> peSeries)
        {
            if (BacktestUtil.LastValueAtOrBefore(ceSeries, at) is not { } ceNow || BacktestUtil.LastValueAtOrBefore(peSeries, at) is not { } peNow)
                return null;
            var onRightSide = bullish ? ceNow > peNow : peNow > ceNow;
            if (!onRightSide) return false;
            var winningSeries = bullish ? ceSeries : peSeries;
            var winningNow = bullish ? ceNow : peNow;
            if (BacktestUtil.LastValueAtOrBefore(winningSeries, at - window) is not { } winningEarlier) return null;
            return winningNow > winningEarlier;
        }

        var obv = Favors(context.ObvCeSeries, context.ObvPeSeries);
        var cdv = Favors(context.CdvCeSeries, context.CdvPeSeries);
        var confirmed = flowMode switch
        {
            ModeObvOnly => obv ?? false,
            ModeCdvOnly => cdv ?? false,
            ModeBoth => (obv ?? false) && (cdv ?? false),
            _ => (obv ?? false) || (cdv ?? false),
        };

        var leg = bullish ? "CE over PE" : "PE over CE";
        var modeLabel = flowMode switch { ModeObvOnly => "OBV", ModeCdvOnly => "CDV", ModeBoth => "OBV and CDV", _ => "OBV or CDV" };
        var reason = confirmed
            ? $"flow favors {leg} and has risen over the last {lookbackBars} bar(s) ({modeLabel})"
            : $"flow does not favor {leg} and rising over the last {lookbackBars} bar(s) as required ({modeLabel}; OBV {(obv is true ? "confirms it" : "does not")}, CDV {(cdv is true ? "confirms it" : "does not")})";
        return (confirmed, reason);
    }
}

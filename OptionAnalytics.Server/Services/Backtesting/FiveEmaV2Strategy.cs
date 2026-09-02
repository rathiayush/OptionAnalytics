using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// The Subhasish Pani 5 EMA setup with the TAUGHT exits. Entry is the same idea as FiveEmaStrategy
/// (v1); what differs is where the trade gets out:
///
///   v1: stop and target are absolute points on the OPTION PREMIUM (slPoints/tpPoints).
///   v2: stop is the ALERT CANDLE's own high (short) or low (long), and the target is a
///       risk-multiple of that distance - the taught minimum 1:3 - both measured on SPOT.
///
/// This class is DELIBERATELY SELF-CONTAINED: the alert-candle scan below is v2's own copy, not
/// shared with v1. v1 is armed and trading live, and the two must be free to evolve separately
/// without a change to one ever being able to alter the other. The duplication is the point, not an
/// oversight - do not "tidy" it into a shared helper.
///
/// Measuring on spot is what makes the taught rule expressible at all. The stop "high of the alert
/// candle" is a level on the underlying; it has no fixed premium equivalent, because the rate at
/// which a premium moves per spot point is the option's delta, and delta moves. So v2 does not try
/// to convert: it watches SPOT for the stop and target, and exits the option at whatever it is
/// worth at that moment. That is also what a trader following the setup literally does - the
/// decision is taken off the chart of the underlying, and the option is simply what gets closed.
///
/// The trade-off, stated plainly: the risk:reward is 1:3 IN SPOT POINTS, not in premium. The option
/// leg's actual P&amp;L ratio will differ from 1:3 - by delta over the move, by theta over the
/// holding time, and by any change in IV. A 1:3 spot move is the taught SIGNAL to exit; it is not a
/// promise about the premium. slPoints/tpPoints remain available as an OPTIONAL premium safety net
/// (0 = off, the default) for the gap risk a spot-level stop cannot see.
///
/// Timeframe is the page's, as in v1: taught as 5-minute for the short side and 15-minute for the
/// long side, which is what the Take parameter is for - run it twice, once per timeframe.
/// </summary>
public sealed class FiveEmaV2Strategy : IBacktestStrategy
{
    public string Key => "five-ema-v2";
    public string Name => "5 EMA v2 - taught SL/target (Subhasish Pani)";
    public string Description => "The 5 EMA alert-candle entry, with the setup's own exits: stop at the alert candle's high (short) or low (long), and a target at the taught risk-multiple of that distance - both measured on spot, since neither converts to a fixed number of premium points. Premium stop/target stay available as optional safety nets rather than the mechanism. EMA period is configurable.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    /// <summary>One alert candle that was actually broken - the moment the setup fires. AlertCandle
    /// is the exhaustion bar itself (not the bar that broke it), which is what the taught stop is
    /// placed against: its High for a short, its Low for a long.</summary>
    private sealed record Break(DateTimeOffset Time, string Direction, Candle AlertCandle);

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),

        new BacktestParameterSpec("rewardMultiple", "Target (x risk, taught minimum 3)", Default: 3, Min: 0.5m, Max: 20, Step: 0.5m),

        // Present and fully usable, but 0-by-default and 0-allowed, unlike v1's shared specs: here
        // the real stop is the alert candle, and these exist to cap a premium gap the spot level
        // cannot see. Set them to a non-zero value to run both stops at once - whichever hits first
        // closes the trade.
        new BacktestParameterSpec("slPoints", "Premium safety stop (points, 0 = off)", Default: 0, Min: 0, Max: 1000, Step: 0.5m),
        new BacktestParameterSpec("tpPoints", "Premium safety target (points, 0 = off)", Default: 0, Min: 0, Max: 2000, Step: 0.5m),

        new BacktestParameterSpec("emaPeriod", "EMA (bars)", Default: 5, Min: 1, Max: 200, Step: 1),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Longs only (taught on 15 min)"),
            new BacktestParameterOption(DirectionShortOnly, "Shorts only (taught on 5 min)"),
        }),
        new BacktestParameterSpec("alertMaxAgeBars", "Alert candle expires after (bars, 0 = never)", Default: 0, Min: 0, Max: 200, Step: 1),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var evaluation = Evaluate(context, parameters);
        return OptionTradeSimulator.Run(context, evaluation.Entries, parameters, forcedExitTimes: null, signalExits: evaluation.Exits);
    }

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private (List<(DateTimeOffset Time, string Direction)> Entries,
             List<BacktestSignal> Signals,
             Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)> Exits) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var emaPeriod = (int)parameters["emaPeriod"];
        var direction = parameters["direction"];
        var maxAgeBars = (int)parameters["alertMaxAgeBars"];
        var rewardMultiple = parameters["rewardMultiple"];

        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();
        var exits = new Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)>();

        var bars = context.SpotBars;
        var breaks = ScanForBreaks(bars, emaPeriod, maxAgeBars);

        // Index by time so each break can walk forward from its own bar without rescanning.
        var indexByTime = new Dictionary<DateTimeOffset, int>(bars.Count);
        for (var i = 0; i < bars.Count; i++) indexByTime[bars[i].Time] = i;

        foreach (var fired in breaks)
        {
            var isShort = fired.Direction == "Bearish";
            if (!(isShort ? takeShorts : takeLongs))
            {
                signals.Add(new BacktestSignal(context.Underlying, fired.Time, "Rejected", fired.Direction,
                    $"{DescribeAlert(fired, emaPeriod, isShort)} - skipped, {(isShort ? "longs" : "shorts")} only"));
                continue;
            }

            if (!indexByTime.TryGetValue(fired.Time, out var breakIndex)) continue;

            // Risk is measured from where the trade is actually taken - the breaking bar's close,
            // the same price the simulator records as the trade's SpotPrice - to the alert candle's
            // own high (short) or low (long).
            var entrySpot = bars[breakIndex].Close;
            var stopLevel = isShort ? fired.AlertCandle.High : fired.AlertCandle.Low;
            var risk = isShort ? stopLevel - entrySpot : entrySpot - stopLevel;

            if (risk <= 0)
            {
                // The breaking bar already closed at or beyond where the stop would sit, so the
                // trade would be stopped out on entry - there is no 1:3 to aim for. Reported rather
                // than dropped, so the row explains itself instead of just going missing.
                signals.Add(new BacktestSignal(context.Underlying, fired.Time, "Rejected", fired.Direction,
                    $"{DescribeAlert(fired, emaPeriod, isShort)} - skipped, spot already closed past the stop at {stopLevel:0.##}"));
                continue;
            }

            var targetLevel = isShort ? entrySpot - rewardMultiple * risk : entrySpot + rewardMultiple * risk;

            signals.Add(new BacktestSignal(context.Underlying, fired.Time, "Entry", fired.Direction,
                $"{DescribeAlert(fired, emaPeriod, isShort)}. Stop {stopLevel:0.##} (risk {risk:0.##}), target {targetLevel:0.##} at 1:{rewardMultiple:0.##}"));
            entries.Add((fired.Time, fired.Direction));

            // No exit found means neither level was reached before the day ended - the simulator's
            // own end-of-day close then handles it, which is the right answer rather than inventing
            // one here.
            if (FindSpotExit(bars, breakIndex, isShort, stopLevel, targetLevel) is { } found)
                exits[fired.Time] = found;
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList(), exits);
    }

    /// <summary>v2's OWN alert-candle scan - see this class's doc comment for why it is not shared
    /// with v1. The rules, all on the underlying's own bars:
    ///   - A candle entirely ABOVE the EMA (its LOW does not touch the line) is a SHORT alert
    ///     candle; entirely BELOW (its HIGH does not touch) is a LONG one.
    ///   - It fires when a later candle breaks that candle's low (short) or high (long).
    ///   - It ROLLS FORWARD: while unbroken, any newer candle itself entirely clear of the EMA on
    ///     the same side replaces it, so the reference is always the most recent exhaustion bar.
    ///   - Any candle that TOUCHES the EMA cancels both sides - price is back at the average.
    ///   - Nothing carries across a trading day.</summary>
    private static List<Break> ScanForBreaks(IReadOnlyList<Candle> bars, int emaPeriod, int maxAgeBars)
    {
        var breaks = new List<Break>();
        var ema = EmaCrossoverDetector.EmaSeries(bars, emaPeriod);

        // Only one side can ever be pending: a candle entirely above the EMA is a short alert AND
        // proof that any long alert (which needed price below the EMA) is dead.
        (Candle Bar, int Index)? shortAlert = null;
        (Candle Bar, int Index)? longAlert = null;
        DateOnly? currentDay = null;

        for (var i = 0; i < bars.Count; i++)
        {
            var bar = bars[i];

            var day = BacktestUtil.IstDate(bar.Time);
            if (currentDay != day)
            {
                currentDay = day;
                shortAlert = null;
                longAlert = null;
            }

            if (ema[i] is not { } emaValue) continue;

            if (maxAgeBars > 0)
            {
                if (shortAlert is { } s && i - s.Index > maxAgeBars) shortAlert = null;
                if (longAlert is { } l && i - l.Index > maxAgeBars) longAlert = null;
            }

            // Step 1: does THIS bar break a PREVIOUS bar's alert candle? Checked before the alert
            // candle is updated below, so a candle can never trigger against itself.
            if (shortAlert is { } shortCandle && bar.Low < shortCandle.Bar.Low)
            {
                breaks.Add(new Break(bar.Time, "Bearish", shortCandle.Bar));
                shortAlert = null;
            }
            else if (longAlert is { } longCandle && bar.High > longCandle.Bar.High)
            {
                breaks.Add(new Break(bar.Time, "Bullish", longCandle.Bar));
                longAlert = null;
            }

            // Step 2: this bar becomes the new alert candle if it is itself entirely clear of the
            // EMA - strictly, so a bar merely grazing the line does not qualify. A bar that does
            // touch cancels both sides: price is back at the average.
            if (bar.Low > emaValue)
            {
                shortAlert = (bar, i);
                longAlert = null;
            }
            else if (bar.High < emaValue)
            {
                longAlert = (bar, i);
                shortAlert = null;
            }
            else
            {
                shortAlert = null;
                longAlert = null;
            }
        }

        return breaks;
    }

    /// <summary>Walks spot forward from the bar AFTER the break (entry is the next bar, so the
    /// breaking bar's own range cannot close the trade) to whichever of stop/target spot reaches
    /// first, within that same trading day. The stop is checked first when a single bar's range
    /// spans both - the same conservative convention OptionTradeSimulator uses for its own premium
    /// levels, so the worse outcome wins rather than guessing the intra-bar order.</summary>
    private static (DateTimeOffset Time, string Reason)? FindSpotExit(
        IReadOnlyList<Candle> bars, int breakIndex, bool isShort, decimal stopLevel, decimal targetLevel)
    {
        var day = BacktestUtil.IstDate(bars[breakIndex].Time);

        for (var i = breakIndex + 1; i < bars.Count && BacktestUtil.IstDate(bars[i].Time) == day; i++)
        {
            var bar = bars[i];

            var stopHit = isShort ? bar.High >= stopLevel : bar.Low <= stopLevel;
            if (stopHit) return (bar.Time, "SignalStop");

            var targetHit = isShort ? bar.Low <= targetLevel : bar.High >= targetLevel;
            if (targetHit) return (bar.Time, "SignalTarget");
        }

        return null;
    }

    private static string DescribeAlert(Break fired, int emaPeriod, bool isShort) => isShort
        ? $"Alert candle at {BacktestUtil.IstDate(fired.AlertCandle.Time):dd MMM} low {fired.AlertCandle.Low:0.##} formed clear above the {emaPeriod} EMA and broke down"
        : $"Alert candle at {BacktestUtil.IstDate(fired.AlertCandle.Time):dd MMM} high {fired.AlertCandle.High:0.##} formed clear below the {emaPeriod} EMA and broke up";
}

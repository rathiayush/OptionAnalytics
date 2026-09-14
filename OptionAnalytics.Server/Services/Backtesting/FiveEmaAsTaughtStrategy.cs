using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// FiveEmaStrategy's own setup and entry rule, unchanged - see that class's own doc comment for the
/// alert-candle logic itself. What differs here is the stop and target: FiveEmaStrategy deliberately
/// replaced the taught spot-based stop/target with a shared premium-points one (see its own doc
/// comment for why - spot points do not convert to premium points at a fixed rate). This strategy
/// is the literal version instead, at the user's own explicit request to "do what he actually
/// suggested":
///
///   STOP is the triggering alert candle's own HIGH (short) or LOW (long) - in SPOT terms, exactly
///   as taught, not a premium-points level.
///   TARGET is riskReward times that same candle's own range (High-Low) beyond the LEVEL that was
///   broken to enter - so a long triggered on a break above the alert candle's high risks the
///   candle's own range (entry level down to the stop) and targets riskReward times that same
///   distance further up; a short mirrors it downward. riskReward defaults to 3, the taught 1:3.
///
/// Both levels are computed ONCE, from the alert candle itself, at the moment it triggers - not
/// from the actual fill price (which can differ slightly from the candle's own level on a fast
/// break) - so the stop/target stay exactly what the candle taught them to be regardless of
/// execution slippage.
///
/// This app still only ever trades and prices the OPTION, never the underlying itself, so a
/// SPOT-level stop/target still has to become a REAL exit price on the option's own premium: the
/// exit is priced at the option's own bar close at the exact spot bar where the level was crossed -
/// the walk finds WHEN spot crossed the level, then hands that time to OptionTradeSimulator via
/// signalExits (its own per-trade exit-level mechanism, added for exactly this shape of strategy -
/// see its own doc comment), which prices the exit off the option series as usual.
///
/// Because the stop/target are spot levels rather than premium points, this strategy does not
/// declare slPoints/tpPoints at all - there is no premium safety net here, only the taught
/// mechanism (plus the taught EMA-touch exit, unchanged from FiveEmaStrategy, still on by default).
/// A trade that never reaches either spot level before the day ends simply rides to the day's own
/// close, exactly like every other strategy in this app.
/// </summary>
public sealed class FiveEmaAsTaughtStrategy : IBacktestStrategy
{
    public string Key => "five-ema-taught";
    public string Name => "5 EMA (Subhasish Pani) - as taught (spot stop/target)";
    public string Description => "The same alert-candle setup as the other 5 EMA strategies, but with the stop and target exactly as taught: stop at the triggering alert candle's own high (short) or low (long), target a configurable multiple of that candle's own range beyond the level broken to enter - both measured on the underlying's spot, not the option's premium. The option itself is still what is bought/sold; its own price at the moment spot crosses a level is what the trade is priced at.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    private const decimal FlagOff = 0;
    private const decimal FlagOn = 1;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        OptionTradeSimulator.SignalStartTimeParameter(),
        OptionTradeSimulator.ExcludeLastDaysParameter(),
        new BacktestParameterSpec("emaPeriod", "EMA (bars)", Default: 5, Min: 1, Max: 200, Step: 1),
        new BacktestParameterSpec("riskReward", "Target = risk x this (taught 1:3)", Default: 3, Min: 0.1m, Max: 10, Step: 0.1m),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Longs only (taught on 15 min)"),
            new BacktestParameterOption(DirectionShortOnly, "Shorts only (taught on 5 min)"),
        }),
        new BacktestParameterSpec("alertMaxAgeBars", "Alert candle expires after (bars, 0 = never)", Default: 0, Min: 0, Max: 200, Step: 1),
        new BacktestParameterSpec("exitOnEmaTouch", "Exit when spot touches the EMA", Default: FlagOn, Min: FlagOff, Max: FlagOn, Step: 1, Options: new[]
        {
            new BacktestParameterOption(FlagOn, "Yes - the taught target"),
            new BacktestParameterOption(FlagOff, "No - spot stop/target only"),
        }),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var evaluation = Evaluate(context, parameters);
        var exitOnTouch = parameters["exitOnEmaTouch"] >= (FlagOff + FlagOn) / 2;
        return OptionTradeSimulator.Run(context, evaluation.Entries, parameters, exitOnTouch ? evaluation.EmaTouchTimes : null, evaluation.SignalExits);
    }

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private (
        List<(DateTimeOffset Time, string Direction)> Entries,
        List<BacktestSignal> Signals,
        List<DateTimeOffset> EmaTouchTimes,
        Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)> SignalExits) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var emaPeriod = (int)parameters["emaPeriod"];
        var riskReward = parameters["riskReward"];
        var direction = parameters["direction"];
        var maxAgeBars = (int)parameters["alertMaxAgeBars"];
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);

        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();
        var touchTimes = new List<DateTimeOffset>();
        var signalExits = new Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)>();

        var bars = context.SpotBars;
        var ema = EmaCrossoverDetector.EmaSeries(bars, emaPeriod);

        // The pending alert candle on each side, with the bar index it formed at so its age can be
        // checked - identical to FiveEmaStrategy's own state machine (see its own doc comment).
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

            if (bar.Low <= emaValue && bar.High >= emaValue) touchTimes.Add(bar.Time);

            if (maxAgeBars > 0)
            {
                if (shortAlert is { } s && i - s.Index > maxAgeBars) shortAlert = null;
                if (longAlert is { } l && i - l.Index > maxAgeBars) longAlert = null;
            }

            var beforeSignalStart = signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes;

            if (shortAlert is { } shortCandle && bar.Low < shortCandle.Bar.Low)
            {
                var summary = $"Alert candle at {BacktestUtil.IstDate(shortCandle.Bar.Time):dd MMM} low {shortCandle.Bar.Low:0.##} formed clear above the {emaPeriod} EMA and broke down";
                if (beforeSignalStart)
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bearish", $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
                }
                else if (takeShorts)
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", "Bearish", summary));
                    entries.Add((bar.Time, "Bearish"));
                    RecordSpotLevelExit(bars, i, day, isBullish: false, shortCandle.Bar, riskReward, bar.Time, signalExits);
                }
                else
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bearish", $"{summary} - skipped, longs only"));
                }
                shortAlert = null;
            }
            else if (longAlert is { } longCandle && bar.High > longCandle.Bar.High)
            {
                var summary = $"Alert candle at {BacktestUtil.IstDate(longCandle.Bar.Time):dd MMM} high {longCandle.Bar.High:0.##} formed clear below the {emaPeriod} EMA and broke up";
                if (beforeSignalStart)
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bullish", $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
                }
                else if (takeLongs)
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", "Bullish", summary));
                    entries.Add((bar.Time, "Bullish"));
                    RecordSpotLevelExit(bars, i, day, isBullish: true, longCandle.Bar, riskReward, bar.Time, signalExits);
                }
                else
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bullish", $"{summary} - skipped, shorts only"));
                }
                longAlert = null;
            }

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

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList(), touchTimes, signalExits);
    }

    /// <summary>Walks spot forward from the bar AFTER the triggering one (never the trigger bar's
    /// own High/Low - that range happened before the position existed, same rule
    /// OptionTradeSimulator's own premium walk already follows), same trading day only, looking for
    /// the first bar whose High/Low crosses the stop or target level computed from the alert
    /// candle itself:
    ///
    ///   LONG:  stop = alertCandle.Low, target = alertCandle.High + riskReward * (alertCandle.High -
    ///          alertCandle.Low) - the level broken to enter (High) plus riskReward times the
    ///          candle's own range.
    ///   SHORT: stop = alertCandle.High, target = alertCandle.Low - riskReward * (alertCandle.High -
    ///          alertCandle.Low), mirrored downward.
    ///
    /// Conservative on a bar whose range spans both (same tiebreak OptionTradeSimulator's own
    /// premium stop/target already uses): the stop wins. Records nothing when neither level is
    /// crossed before the day ends - the trade simply rides to the day's own close, same as any
    /// other strategy here with no exit found.</summary>
    internal static void RecordSpotLevelExit(
        IReadOnlyList<Candle> bars, int triggerIndex, DateOnly day, bool isBullish, Candle alertCandle, decimal riskReward,
        DateTimeOffset signalTime, Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)> signalExits)
    {
        var range = alertCandle.High - alertCandle.Low;
        var stopLevel = isBullish ? alertCandle.Low : alertCandle.High;
        var targetLevel = isBullish ? alertCandle.High + riskReward * range : alertCandle.Low - riskReward * range;

        for (var j = triggerIndex + 1; j < bars.Count && BacktestUtil.IstDate(bars[j].Time) == day; j++)
        {
            var bar = bars[j];
            var stopHit = isBullish ? bar.Low <= stopLevel : bar.High >= stopLevel;
            if (stopHit) { signalExits[signalTime] = (bar.Time, "SpotStopLoss"); return; }

            var targetHit = isBullish ? bar.High >= targetLevel : bar.Low <= targetLevel;
            if (targetHit) { signalExits[signalTime] = (bar.Time, "SpotTakeProfit"); return; }
        }
    }
}

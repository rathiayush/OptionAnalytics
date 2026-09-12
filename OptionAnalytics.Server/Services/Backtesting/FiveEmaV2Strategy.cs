using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// FiveEmaStrategy's setup, entered a minute at a time instead of a candle at a time.
///
/// The setup is identical and deliberately so: an alert candle that forms entirely clear of the EMA
/// on the CHOSEN timeframe (5-minute for shorts, 15 for longs, as taught), rolling forward to any
/// newer qualifying candle and cancelled outright by any candle touching the EMA. Read
/// FiveEmaStrategy for that rule; nothing about it changes here.
///
/// What changes is WHEN the break counts and what it is priced at.
///
/// v1 detects the break from the timeframe bar's own High/Low, so it is correct about WHETHER the
/// level broke but not about WHEN inside those five or fifteen minutes - and it prices the fill at
/// that bar's CLOSE. A level that broke at 10:01:05 on a 5-minute chart is therefore filled at the
/// 10:05 close, minutes and often a lot of points from where a real stop order would have gone. The
/// setup is the same; the fill is not the one you would have got.
///
/// v2 walks the native 1-MINUTE series instead and takes the first minute that breaks the level,
/// pricing the option on its own bar for that same minute. The alert candle is still only known
/// once its timeframe bar has CLOSED - a candle cannot be judged "entirely clear of the EMA" while
/// it is still forming - so a break is only ever looked for in the minutes AFTER that close, which
/// is also what stops a candle triggering against itself.
///
/// This is NOT tick accuracy and should not be read as it. Dhan serves no finer than 1-minute, so a
/// fill inside the minute is still unmodelled, and the entry is the minute's close rather than the
/// level itself. It narrows the gap between backtest and live from a whole timeframe bar to one
/// minute; it does not close it.
/// </summary>
public sealed class FiveEmaV2Strategy : IBacktestStrategy
{
    public string Key => "five-ema-v2";
    public string Name => "5 EMA (Subhasish Pani) v2 - 1-minute entry";
    public string Description => "The same 5 EMA setup as v1 - an alert candle formed entirely clear of the EMA on the chosen timeframe, cancelled by any candle touching the EMA - but the break is detected on the native 1-MINUTE series and priced on the option's own bar for that minute, instead of being detected on the timeframe bar and priced at its close. On a 5-minute chart that moves the fill from 'the close of the candle the break happened in' to 'the close of the minute it happened in'. Not tick-accurate: Dhan serves no finer than 1-minute, so this narrows the gap to live rather than closing it.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    private const decimal FlagOff = 0;
    private const decimal FlagOn = 1;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.StopLossParameter(),
        OptionTradeSimulator.TakeProfitParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        OptionTradeSimulator.SignalStartTimeParameter(),
        new BacktestParameterSpec("emaPeriod", "EMA (bars)", Default: 5, Min: 1, Max: 200, Step: 1),
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
            new BacktestParameterOption(FlagOff, "No - stop/target only"),
        }),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var evaluation = Evaluate(context, parameters);
        var exitOnTouch = parameters["exitOnEmaTouch"] >= (FlagOff + FlagOn) / 2;
        // oneMinuteFills: the entries below are stamped at 1-minute bar times, so the simulator has
        // to resolve spot and option prices on the un-aggregated series or nothing lines up.
        return OptionTradeSimulator.Run(context, evaluation.Entries, parameters, exitOnTouch ? evaluation.EmaTouchTimes : null, oneMinuteFills: true);
    }

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    /// <summary>The alert state a timeframe bar leaves behind once it has CLOSED: at most one side
    /// armed, with the level a later minute has to break. Both null means the bar touched the EMA
    /// and cancelled everything.</summary>
    private readonly record struct AlertState(DateTimeOffset ActiveFrom, decimal? ShortBreakBelow, decimal? LongBreakAbove, DateOnly Day);

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals, List<DateTimeOffset> EmaTouchTimes) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var emaPeriod = (int)parameters["emaPeriod"];
        var direction = parameters["direction"];
        var maxAgeBars = (int)parameters["alertMaxAgeBars"];
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);

        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();
        var touchTimes = new List<DateTimeOffset>();

        var timeframeBars = context.SpotBars;
        var minuteBars = context.SpotBarsOneMinute;
        if (timeframeBars.Count == 0 || minuteBars.Count == 0) return (entries, signals, touchTimes);

        var states = BuildAlertStates(timeframeBars, emaPeriod, maxAgeBars, context.TimeframeMinutes, touchTimes);
        if (states.Count == 0) return (entries, signals, touchTimes);

        // Walk minutes and timeframe-bar closes together, both time-ascending, so each minute is
        // judged against the most recent alert state that had actually closed by then - never a
        // later one, which would be look-ahead.
        var stateIndex = -1;
        AlertState? active = null;

        foreach (var minute in minuteBars)
        {
            while (stateIndex + 1 < states.Count && states[stateIndex + 1].ActiveFrom <= minute.Time)
            {
                stateIndex++;
                active = states[stateIndex];
            }

            if (active is not { } alert) continue;
            // Nothing carries overnight - an alert from yesterday's close must not arm today's open.
            if (alert.Day != BacktestUtil.IstDate(minute.Time)) continue;

            var brokeShort = alert.ShortBreakBelow is { } shortLevel && minute.Low < shortLevel;
            var brokeLong = alert.LongBreakAbove is { } longLevel && minute.High > longLevel;
            if (!brokeShort && !brokeLong) continue;

            var bullish = brokeLong;
            var level = bullish ? alert.LongBreakAbove!.Value : alert.ShortBreakBelow!.Value;
            var summary = $"Alert candle {(bullish ? "high" : "low")} {level:0.##} formed clear {(bullish ? "below" : "above")} the {emaPeriod} EMA and broke {(bullish ? "up" : "down")} at {IstClock.FormatMinutesOfDay(IstClock.MinutesOfDay(minute.Time))} IST";

            // Consumed either way - a level breaks once. Whether the break is taken or rejected, the
            // alert is spent, exactly as v1 clears it on trigger.
            active = alert with { ShortBreakBelow = null, LongBreakAbove = null };
            states[stateIndex] = active.Value;

            if (signalStartMinutes > 0 && IstClock.MinutesOfDay(minute.Time) < signalStartMinutes)
            {
                signals.Add(new BacktestSignal(context.Underlying, minute.Time, "Rejected", bullish ? "Bullish" : "Bearish",
                    $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
                continue;
            }

            if (bullish ? !takeLongs : !takeShorts)
            {
                signals.Add(new BacktestSignal(context.Underlying, minute.Time, "Rejected", bullish ? "Bullish" : "Bearish",
                    $"{summary} - skipped, {(bullish ? "shorts" : "longs")} only"));
                continue;
            }

            signals.Add(new BacktestSignal(context.Underlying, minute.Time, "Entry", bullish ? "Bullish" : "Bearish", summary));
            entries.Add((minute.Time, bullish ? "Bullish" : "Bearish"));
        }

        return (entries, signals, touchTimes);
    }

    /// <summary>v1's alert-candle rule, run over the timeframe bars, recorded as "what is armed from
    /// the moment this bar closes". ActiveFrom is the bar's END (its start plus the timeframe)
    /// because that is when the candle is finished and can first be judged clear of the EMA -
    /// arming it any earlier would let a still-forming candle trigger against itself.</summary>
    internal static List<AlertStateSnapshot> BuildAlertStatesForTest(IReadOnlyList<Candle> bars, int emaPeriod, int maxAgeBars, int timeframeMinutes) =>
        BuildAlertStates(bars, emaPeriod, maxAgeBars, timeframeMinutes, new List<DateTimeOffset>())
            .Select(s => new AlertStateSnapshot(s.ActiveFrom, s.ShortBreakBelow, s.LongBreakAbove))
            .ToList();

    /// <summary>Test-visible projection of AlertState - the private record struct cannot be named
    /// from a test assembly's own signatures.</summary>
    public readonly record struct AlertStateSnapshot(DateTimeOffset ActiveFrom, decimal? ShortBreakBelow, decimal? LongBreakAbove);

    private static List<AlertState> BuildAlertStates(
        IReadOnlyList<Candle> bars, int emaPeriod, int maxAgeBars, int timeframeMinutes, List<DateTimeOffset> touchTimes)
    {
        var states = new List<AlertState>(bars.Count);
        var ema = EmaCrossoverDetector.EmaSeries(bars, emaPeriod);

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

            if (ema[i] is { } emaValue)
            {
                if (bar.Low <= emaValue && bar.High >= emaValue) touchTimes.Add(bar.Time);

                if (maxAgeBars > 0)
                {
                    if (shortAlert is { } s && i - s.Index > maxAgeBars) shortAlert = null;
                    if (longAlert is { } l && i - l.Index > maxAgeBars) longAlert = null;
                }

                // A bar entirely clear of the EMA becomes the new alert on its side and kills the
                // other; one that touches the line cancels both - price is back at the average.
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

            states.Add(new AlertState(
                bar.Time + TimeSpan.FromMinutes(Math.Max(1, timeframeMinutes)),
                shortAlert?.Bar.Low,
                longAlert?.Bar.High,
                day));
        }

        return states;
    }
}

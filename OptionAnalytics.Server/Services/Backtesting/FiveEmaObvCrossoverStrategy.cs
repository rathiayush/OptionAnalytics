using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// FiveEmaStrategy's alert-candle/breakout setup, with one extra confirmation required at the
/// moment of entry: the CE and PE OBV lines have to agree with the direction of the breakout.
///
///   BULLISH (long) entries additionally require OBV(CE) currently ABOVE OBV(PE) - call buying
///   outpacing put buying, confirming the up-move.
///   BEARISH (short) entries additionally require OBV(PE) currently ABOVE OBV(CE) - put buying
///   outpacing call buying, confirming the down-move.
///
/// This is a separate strategy rather than a flag on FiveEmaStrategy because it is a genuinely
/// different signal (fewer, more selective entries) that deserves its own place in the Backtrack
/// dropdown and its own Key so a saved/shared backtest keeps meaning what it meant. Everything
/// about the alert-candle detection itself - rolling forward, cancelling on an EMA touch, nothing
/// carrying overnight, next-bar-open entries with a points-based stop/target on the option
/// premium - is identical to FiveEmaStrategy; see that class's own doc comment for the full
/// rationale. A breakout that fires but fails the OBV check is reported as a Rejected signal
/// (with the OBV values that failed it), not silently dropped, matching every other filter this
/// app's strategies apply.
/// </summary>
public sealed class FiveEmaObvCrossoverStrategy : IBacktestStrategy
{
    public string Key => "five-ema-obv";
    public string Name => "5 EMA + OBV CE/PE Crossover (Subhasish Pani)";
    public string Description => "The 5 EMA alert-candle/breakout setup, confirmed by CE/PE OBV: a bullish breakout only enters when OBV(CE) is above OBV(PE), a bearish breakout only when OBV(PE) is above OBV(CE). A breakout that fails the OBV check is reported as Rejected rather than taken.";

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
        return OptionTradeSimulator.Run(context, evaluation.Entries, parameters, exitOnTouch ? evaluation.EmaTouchTimes : null);
    }

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals, List<DateTimeOffset> EmaTouchTimes) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var emaPeriod = (int)parameters["emaPeriod"];
        var direction = parameters["direction"];
        var maxAgeBars = (int)parameters["alertMaxAgeBars"];
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);

        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        // Keyed by the same bucket-start Time as SpotBars - ObvCeSeries/ObvPeSeries are aggregated
        // to the same TimeframeMinutes off the same bucketing rule (BacktestUtil.AggregateLine), so
        // a bar's OBV values live under its own bar.Time exactly like OptionTradeSimulator already
        // looks up SpotBars by signal time.
        var obvCeByTime = context.ObvCeSeries.ToDictionary(p => p.Time, p => p.Obv);
        var obvPeByTime = context.ObvPeSeries.ToDictionary(p => p.Time, p => p.Obv);

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();
        var touchTimes = new List<DateTimeOffset>();

        var bars = context.SpotBars;
        var ema = EmaCrossoverDetector.EmaSeries(bars, emaPeriod);

        // The pending alert candle on each side, with the bar index it formed at so its age can be
        // checked. Only one of the two can ever be set: a candle entirely above the EMA is a short
        // alert AND proof that any long alert (which needed price below the EMA) is dead.
        (Candle Bar, int Index)? shortAlert = null;
        (Candle Bar, int Index)? longAlert = null;
        DateOnly? currentDay = null;

        for (var i = 0; i < bars.Count; i++)
        {
            var bar = bars[i];

            // Nothing carries overnight - the first bars of a session gap away from the previous
            // close often enough that yesterday's alert candle is meaningless against today's price.
            var day = BacktestUtil.IstDate(bar.Time);
            if (currentDay != day)
            {
                currentDay = day;
                shortAlert = null;
                longAlert = null;
            }

            if (ema[i] is not { } emaValue) continue;

            if (bar.Low <= emaValue && bar.High >= emaValue) touchTimes.Add(bar.Time);

            // An alert candle that has sat unbroken for too long is stale - opt-in, since the setup
            // as taught puts no limit on it.
            if (maxAgeBars > 0)
            {
                if (shortAlert is { } s && i - s.Index > maxAgeBars) shortAlert = null;
                if (longAlert is { } l && i - l.Index > maxAgeBars) longAlert = null;
            }

            // Step 1: does THIS bar break a PREVIOUS bar's alert candle? Checked before the alert
            // candle is updated below, so a candle can never trigger against itself.
            // Before anything else: a bar timestamped inside the pre-open call auction can never
            // produce a real signal, regardless of direction/OBV filters or alert-candle state - see
            // SignalStartTimeParameter's own doc comment.
            var beforeSignalStart = signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes;

            var hasObvCe = obvCeByTime.TryGetValue(bar.Time, out var obvCe);
            var hasObvPe = obvPeByTime.TryGetValue(bar.Time, out var obvPe);
            var hasObv = hasObvCe && hasObvPe;

            if (shortAlert is { } shortCandle && bar.Low < shortCandle.Bar.Low)
            {
                var summary = $"Alert candle at {BacktestUtil.IstDate(shortCandle.Bar.Time):dd MMM} low {shortCandle.Bar.Low:0.##} formed clear above the {emaPeriod} EMA and broke down";
                if (beforeSignalStart)
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bearish", $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
                }
                else if (!takeShorts)
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bearish", $"{summary} - skipped, longs only"));
                }
                else if (!hasObv)
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bearish", $"{summary} - skipped, no OBV data at breakout"));
                }
                else if (obvPe <= obvCe)
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bearish", $"{summary} - skipped, OBV(PE) {obvPe:0.##} is not above OBV(CE) {obvCe:0.##} at breakout"));
                }
                else
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", "Bearish", $"{summary} - confirmed by OBV(PE) {obvPe:0.##} above OBV(CE) {obvCe:0.##}"));
                    entries.Add((bar.Time, "Bearish"));
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
                else if (!takeLongs)
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bullish", $"{summary} - skipped, shorts only"));
                }
                else if (!hasObv)
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bullish", $"{summary} - skipped, no OBV data at breakout"));
                }
                else if (obvCe <= obvPe)
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bullish", $"{summary} - skipped, OBV(CE) {obvCe:0.##} is not above OBV(PE) {obvPe:0.##} at breakout"));
                }
                else
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", "Bullish", $"{summary} - confirmed by OBV(CE) {obvCe:0.##} above OBV(PE) {obvPe:0.##}"));
                    entries.Add((bar.Time, "Bullish"));
                }
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

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList(), touchTimes);
    }
}

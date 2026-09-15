using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// The Subhasish Pani ("Power of Stocks") 5 EMA setup, applied to the underlying's spot bars.
///
/// The whole idea is a candle that has run so far from the 5 EMA that it is not even touching it -
/// an exhaustion bar - followed by price failing to continue:
///
///   SHORT: an ALERT CANDLE forms entirely ABOVE the 5 EMA (its LOW does not touch the line). Enter
///          short when a later candle breaks BELOW that candle's low.
///   LONG:  an ALERT CANDLE forms entirely BELOW the 5 EMA (its HIGH does not touch the line). Enter
///          long when a later candle breaks ABOVE that candle's high.
///
/// The alert candle ROLLS FORWARD: while it hasn't been broken, any newer candle that is itself
/// entirely clear of the EMA on the same side replaces it, so the reference is always the most
/// recent exhaustion bar rather than a stale one ("if the price moves higher without breaking the
/// low and forms a new valid candle not touching the EMA, shift your alert candle to the new one").
/// A candle that TOUCHES the EMA cancels the pending alert candle outright on both sides - price
/// has come back to the average, so the stretched-away condition the setup is built on is gone.
/// Nothing is carried across a trading day, either.
///
/// Two deliberate deviations from the setup as taught, both because this app trades OPTIONS off a
/// spot signal rather than trading the underlying itself:
///
///   - THE STOP AND TARGET ARE ON THE OPTION'S PREMIUM, not on spot. The taught rule puts the stop
///     at the alert candle's high (short) or low (long) and targets 1:3 against it - both distances
///     in SPOT points, which do not convert to premium points at a fixed rate (that ratio is the
///     option's delta, and it moves). So the shared points-based stop/target every other strategy in
///     this app uses stays in force here, and the alert candle's own high/low is not used as a stop.
///   - ENTRY IS THE BREAKING BAR'S OWN CLOSE, not a resting order at the alert candle's low/high.
///     This is OptionTradeSimulator's standing no-look-ahead rule: the breaking bar's own prices
///     are only known once it has closed, and that close is a real, already-traded print at the
///     exact instant the break confirmed - not a further bar's open, which would just be the same
///     instant measured one bar late for no benefit (see OptionTradeSimulator's own doc comment). In
///     a fast move that is still a worse fill than the taught entry (a resting order at the level
///     itself).
///
/// The taught EXIT of "get out when price comes back and touches the 5 EMA" DOES translate, since it
/// is a condition on spot rather than a price level on the option, and it is on by default - see
/// OptionTradeSimulator's forcedExitTimes.
///
/// Timeframe is the page's, not the strategy's: Pani teaches 5-minute for the short side and
/// 15-minute for the long side, which is why Direction exists - run it twice, once per timeframe,
/// rather than trying to express two timeframes in one backtest.
///
/// OPTIONAL flow confirmation (at the user's own explicit request): RequireFlowConfirmation, off by
/// default so the setup as taught is unaffected unless deliberately turned on. When on, a break that
/// would otherwise enter also has to clear FlowConfirmation.Favors on the entered direction's own leg
/// (CE for a Bullish/long entry, PE for a Bearish/short one) - the same "CE above PE and rising, PE
/// above CE and rising, optionally by at least a given %" gate EmaCrossAtmFlowStrategy already
/// requires unconditionally. Here it is purely an extra filter a user can choose to add on top of the
/// taught price-action rule, not a replacement for it.
/// </summary>
public sealed class FiveEmaStrategy : IBacktestStrategy
{
    public string Key => "five-ema";
    public string Name => "5 EMA (Subhasish Pani) v1 - candle close";
    public string Description => "An alert candle that forms entirely clear of the 5 EMA - low above it for a short, high below it for a long - and entry when a later candle breaks that candle's low (short) or high (long). The alert candle rolls forward to any newer qualifying candle and is cancelled outright by any candle that touches the EMA. Taught as 5-minute for shorts and 15-minute for longs. Optionally also requires order flow (OBV/CDV) to favor and be rising toward the entered direction, off by default.";

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
        OptionTradeSimulator.ExcludeLastDaysParameter(),
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
        // Optional flow confirmation - off by default, so the setup as taught is unaffected unless
        // deliberately turned on. See this class's own doc comment for exactly what it checks.
        new BacktestParameterSpec("requireFlowConfirmation", "Also require order flow (OBV/CDV) to confirm", Default: FlagOff, Min: FlagOff, Max: FlagOn, Step: 1, Options: new[]
        {
            new BacktestParameterOption(FlagOff, "No - price action only (as taught)"),
            new BacktestParameterOption(FlagOn, "Yes - flow must also favor + rise toward the entry"),
        }),
        FlowConfirmation.LookbackParameter(),
        FlowConfirmation.MinRisePercentParameter(),
        FlowConfirmation.ModeParameter(),
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
        var requireFlowConfirmation = parameters.GetValueOrDefault("requireFlowConfirmation", FlagOff) >= (FlagOff + FlagOn) / 2;
        var flowLookback = (int)parameters.GetValueOrDefault("flowLookbackBars", 5);
        var minFlowRisePercent = parameters.GetValueOrDefault("minFlowRisePercent", 0m);
        var flowMode = parameters.GetValueOrDefault("flowMode", FlowConfirmation.ModeEither);

        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();
        var touchTimes = new List<DateTimeOffset>();

        var bars = context.SpotBars;
        var ema = EmaCrossoverDetector.EmaSeries(bars, emaPeriod);
        var flowWindow = TimeSpan.FromMinutes((double)Math.Max(1, flowLookback) * Math.Max(1, context.TimeframeMinutes));

        // Optional (see requireFlowConfirmation's own doc comment) - CE for a Bullish/long entry, PE
        // for a Bearish/short one, the same leg OptionTradeSimulator would actually buy for that
        // direction. True (no reason given) when the filter is off, so the two entry branches below
        // never need their own "is this even enabled" check.
        (bool Ok, string Reason) FlowCheck(bool bullish, DateTimeOffset at)
        {
            if (!requireFlowConfirmation) return (true, "");
            var obvFavors = FlowConfirmation.Favors(context.ObvCeSeries, context.ObvPeSeries, at, bullish, flowWindow, minFlowRisePercent);
            var cdvFavors = FlowConfirmation.Favors(context.CdvCeSeries, context.CdvPeSeries, at, bullish, flowWindow, minFlowRisePercent);
            var confirmed = FlowConfirmation.Confirms(flowMode, obvFavors, cdvFavors);
            var riseRequirement = minFlowRisePercent > 0 ? $"risen at least {minFlowRisePercent:0.##}%" : "risen at all";
            var reason = confirmed
                ? $"flow favors {(bullish ? "CE over PE" : "PE over CE")} and has {riseRequirement} over the last {flowLookback} bar(s) ({FlowConfirmation.ModeLabel(flowMode)})"
                : $"flow does not favor {(bullish ? "CE over PE" : "PE over CE")} and {riseRequirement} over the last {flowLookback} bar(s) as required ({FlowConfirmation.ModeLabel(flowMode)}; OBV {(obvFavors ? "confirms it" : "does not")}, CDV {(cdvFavors ? "confirms it" : "does not")})";
            return (confirmed, reason);
        }

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
            // produce a real signal, regardless of direction filters or alert-candle state - see
            // SignalStartTimeParameter's own doc comment.
            var beforeSignalStart = signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes;

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
                else
                {
                    var (flowOk, flowReason) = FlowCheck(bullish: false, bar.Time);
                    if (!flowOk)
                    {
                        signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bearish", $"{summary} - but {flowReason}"));
                    }
                    else
                    {
                        signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", "Bearish", requireFlowConfirmation ? $"{summary}, and {flowReason}" : summary));
                        entries.Add((bar.Time, "Bearish"));
                    }
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
                else
                {
                    var (flowOk, flowReason) = FlowCheck(bullish: true, bar.Time);
                    if (!flowOk)
                    {
                        signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bullish", $"{summary} - but {flowReason}"));
                    }
                    else
                    {
                        signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", "Bullish", requireFlowConfirmation ? $"{summary}, and {flowReason}" : summary));
                        entries.Add((bar.Time, "Bullish"));
                    }
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

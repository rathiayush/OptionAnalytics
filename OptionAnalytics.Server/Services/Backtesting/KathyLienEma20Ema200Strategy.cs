using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// The "Kathy Lien" 20 EMA / 200 EMA pullback setup (the user's own detailed spec, given verbatim,
/// supersedes an earlier plainer cut of this same idea that mistakenly used a 200 SMA - Lien's own
/// setup is EMA/EMA), in four steps:
///
///   1. TREND (200 EMA = the "institutional baseline"): Bullish needs BOTH price closing above the
///      200 EMA AND the 20 EMA itself sitting above the 200 EMA; Bearish is the mirror (both below).
///      Anything else (price and the 20 EMA disagreeing, or straddling the 200 EMA) is no trend at
///      all - this alone keeps the setup out of the flat/choppy 200-EMA market the spec explicitly
///      warns off, without a separate slope/ADX filter.
///   2. PULLBACK + REJECTION CANDLE: while a trend holds, a bar whose Low/High actually touches the
///      20 EMA, whose own close ends back on the trend side of it, AND whose own candle colour
///      matches the trend (a green candle for a bullish rejection, red for bearish) becomes the
///      pending "rejection candle" - the closest a non-look-ahead, no-pattern-library engine can get
///      to "a Hammer/Bullish Engulfing (or Shooting Star/Bearish Engulfing) forms at the 20 EMA"
///      without actually classifying candlestick shapes. It ROLLS FORWARD to any newer bar that
///      itself qualifies while still pending (the same "shift your alert to the newest one" rule
///      FiveEmaStrategy's own alert candle uses), and is cancelled outright the moment the trend
///      itself breaks (price closes back through the 200 EMA against it) before a break confirms.
///   3. CONFIRMATION/ENTRY: fires the moment a LATER bar's own High breaks the rejection candle's High
///      (Bullish) or Low breaks its Low (Bearish) - "jab agli candle us rejection candle ke high ko
///      tode, tab Buy entry lein", mirrored for Sell. Entry is that breaking bar's own close, this
///      app's standing no-look-ahead rule (see FiveEmaStrategy's own doc comment for why a further
///      bar's open buys nothing).
///
/// STOP/TARGET: the spec's own primary rule is a SPOT-level one (stop just under/over the recent
/// swing low/high, target the previous swing high/low) - but, per this app's standing rule (see
/// FiveEmaStrategy's own doc comment), a spot-point distance does not convert to an option-premium
/// one at a fixed rate, so a swing-level stop cannot be priced directly here. The spec itself offers
/// the fallback this app already standardizes on: "you can also just keep at least a 1:2 risk:reward"
/// - so this strategy uses exactly that, via the same shared points-based stop/target every other
/// strategy here uses (OptionTradeSimulator.StopLossParameter/TakeProfitParameter, defaulting to
/// 10/20 points - already 1:2, and independently tunable).
///
/// Deliberately no separate candlestick-pattern-name classifier and no true swing-pivot stop -
/// keeping this plain, in the same spirit as every other strategy's own "too many confusing
/// parameters" course-correction.
/// </summary>
public sealed class KathyLienEma20Ema200Strategy : IBacktestStrategy
{
    public string Key => "kathy-lien-ema20-ema200-pullback";
    public string Name => "Kathy Lien 20/200 EMA Pullback";
    public string Description => "Trend is price and the 20 EMA both sitting on the same side of the 200 EMA. Waits for a pullback candle that touches the 20 EMA, closes back on the trend side, and matches the trend's own colour (a stand-in for a Hammer/Engulfing rejection), then enters when a later bar breaks that candle's high (Bullish) or low (Bearish). 1:2 stop/target by default.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.StopLossParameter(),
        OptionTradeSimulator.TakeProfitParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        OptionTradeSimulator.SignalStartTimeParameter(),
        OptionTradeSimulator.ExcludeLastDaysParameter(),
        OptionTradeSimulator.MaxHoldingTimeParameter(),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Bullish only"),
            new BacktestParameterOption(DirectionShortOnly, "Bearish only"),
        }),
        new BacktestParameterSpec("fastEmaPeriod", "Fast EMA (bars)", Default: 20, Min: 1, Max: 200, Step: 1),
        new BacktestParameterSpec("slowEmaPeriod", "Slow EMA (bars)", Default: 200, Min: 2, Max: 400, Step: 1),
        new BacktestParameterSpec("alertMaxAgeBars", "Rejection candle expires after (bars, 0 = never)", Default: 0, Min: 0, Max: 200, Step: 1),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters);

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private sealed record PendingAlert(Candle Bar, int Index, bool Bullish);

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var direction = parameters["direction"];
        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);
        var fastPeriod = Math.Max(1, (int)parameters["fastEmaPeriod"]);
        var slowPeriod = Math.Max(fastPeriod + 1, (int)parameters["slowEmaPeriod"]);
        var maxAgeBars = (int)parameters.GetValueOrDefault("alertMaxAgeBars", 0);

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var bars = context.SpotBars;
        if (bars.Count == 0) return (entries, signals);

        var fastEma = EmaCrossoverDetector.EmaSeries(bars, fastPeriod);
        var slowEma = EmaCrossoverDetector.EmaSeries(bars, slowPeriod);

        PendingAlert? pending = null;

        for (var i = 0; i < bars.Count; i++)
        {
            if (fastEma[i] is not { } fastVal || slowEma[i] is not { } slowVal) continue;

            var bar = bars[i];
            var trend = bar.Close > slowVal && fastVal > slowVal ? "Bullish"
                : bar.Close < slowVal && fastVal < slowVal ? "Bearish"
                : null;

            // The trend that justified waiting for a break is gone - abandon the pending candle
            // rather than let a stale setup fire once price has already reversed through the 200 EMA.
            if (pending is { } inv && trend is not null && trend != (inv.Bullish ? "Bullish" : "Bearish"))
                pending = null;

            // A pending alert candle that has sat unbroken for too long is stale - opt-in, since the
            // spec itself puts no limit on how long a rejection can wait for its break.
            if (maxAgeBars > 0 && pending is { } p && i - p.Index > maxAgeBars)
                pending = null;

            var beforeSignalStart = signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes;

            // Step 3: does THIS bar break a PREVIOUS bar's rejection candle? Checked before this same
            // bar is considered as a fresh rejection candle below, so a candle can never trigger
            // against itself.
            if (pending is { } alert)
            {
                var broke = alert.Bullish ? bar.High > alert.Bar.High : bar.Low < alert.Bar.Low;
                if (broke)
                {
                    var dir = alert.Bullish ? "Bullish" : "Bearish";
                    var summary = $"Rejection candle at {BacktestUtil.IstDate(alert.Bar.Time):dd MMM} {(alert.Bullish ? "high" : "low")} {(alert.Bullish ? alert.Bar.High : alert.Bar.Low):0.##} (pullback to the {fastPeriod} EMA, trend: {fastPeriod}/{slowPeriod} EMA {(alert.Bullish ? "bullish" : "bearish")}) just broke";
                    if (beforeSignalStart)
                    {
                        signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
                    }
                    else if (alert.Bullish && !takeLongs)
                    {
                        signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{summary} - skipped, bearish only"));
                    }
                    else if (!alert.Bullish && !takeShorts)
                    {
                        signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{summary} - skipped, bullish only"));
                    }
                    else
                    {
                        signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", dir, summary));
                        entries.Add((bar.Time, dir));
                    }
                    pending = null;
                }
            }

            // Step 2: does THIS bar itself qualify as a fresh rejection candle, rolling any still-
            // pending one of the SAME direction forward to it? A qualifying candle of the OTHER
            // direction cannot coexist (the trend check above already guarantees only one direction
            // is live at a time), so no separate exclusivity check is needed here.
            if (trend is not null)
            {
                var touched = bar.Low <= fastVal && bar.High >= fastVal;
                if (trend == "Bullish" && touched && bar.Close > bar.Open && bar.Close > fastVal)
                    pending = new PendingAlert(bar, i, true);
                else if (trend == "Bearish" && touched && bar.Close < bar.Open && bar.Close < fastVal)
                    pending = new PendingAlert(bar, i, false);
            }
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }
}

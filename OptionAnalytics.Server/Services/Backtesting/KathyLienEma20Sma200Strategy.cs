using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// The "Kathy Lien" 20 EMA / 200 SMA pullback setup, applied to the underlying's spot bars:
///
///   1. TREND FILTER: the 20 EMA sitting above the 200 SMA means an uptrend (only Bullish entries
///      allowed); the 20 EMA sitting below the 200 SMA means a downtrend (only Bearish entries
///      allowed). Ties (an exact crossover bar) allow neither side that bar.
///   2. PULLBACK: wait for a bar whose High/Low actually touches the 20 EMA (Low &lt;= ema &lt;= High) -
///      price has retraced back to the average instead of running away from it.
///   3. ENTRY: on that same touching bar, take the entry in whichever side the bar's own CLOSE ends
///      up on relative to the 20 EMA (close above -> Bullish, close below -> Bearish) - but ONLY when
///      that close side agrees with step 1's trend. A touch that closes back in the trend's own
///      direction is the "pullback held and continued" entry this setup is built on; a touch that
///      closes through the average against the trend is a failed bounce, not a signal, so it is
///      rejected rather than treated as some other kind of trade.
///
/// Entry is that bar's own close (this app's standing no-look-ahead rule - see FiveEmaStrategy's own
/// doc comment for why a further bar's open is not used instead), and the target follows the taught
/// 1:2 risk:reward via the same shared points-based stop/target every other strategy here uses
/// (OptionTradeSimulator.StopLossParameter/TakeProfitParameter, defaulting to 10/20 points - already a
/// 1:2 ratio, and independently tunable if a run wants a different one).
///
/// Deliberately kept plain - no flow/technical-indicator add-ons - per explicit instruction that this
/// app's strategies were accumulating too many confusing optional parameters (see
/// AdaptiveOptionSellingV2Strategy's own doc comment for the same call).
/// </summary>
public sealed class KathyLienEma20Sma200Strategy : IBacktestStrategy
{
    public string Key => "kathy-lien-ema20-sma200-pullback";
    public string Name => "Kathy Lien 20 EMA / 200 SMA Pullback";
    public string Description => "Trend is the 20 EMA vs 200 SMA crossover (EMA above SMA = uptrend, only longs; below = downtrend, only shorts). Waits for a pullback bar that touches the 20 EMA and enters in whichever direction that bar closed, as long as it agrees with the trend. 1:2 stop/target by default.";

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
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Bullish only"),
            new BacktestParameterOption(DirectionShortOnly, "Bearish only"),
        }),
        new BacktestParameterSpec("fastEmaPeriod", "Fast EMA (bars)", Default: 20, Min: 1, Max: 200, Step: 1),
        new BacktestParameterSpec("slowSmaPeriod", "Slow SMA (bars)", Default: 200, Min: 2, Max: 400, Step: 1),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters);

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var direction = parameters["direction"];
        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);
        var fastPeriod = Math.Max(1, (int)parameters["fastEmaPeriod"]);
        var slowPeriod = Math.Max(fastPeriod + 1, (int)parameters["slowSmaPeriod"]);

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var bars = context.SpotBars;
        if (bars.Count == 0) return (entries, signals);

        var ema = EmaCrossoverDetector.EmaSeries(bars, fastPeriod);
        var sma = EmaCrossoverDetector.SmaSeries(bars, slowPeriod);

        for (var i = 0; i < bars.Count; i++)
        {
            if (ema[i] is not { } emaVal || sma[i] is not { } smaVal || emaVal == smaVal) continue;

            var bar = bars[i];
            var touched = bar.Low <= emaVal && bar.High >= emaVal;
            if (!touched) continue;

            var trend = emaVal > smaVal ? "Bullish" : "Bearish";
            var closeSide = bar.Close > emaVal ? "Bullish" : bar.Close < emaVal ? "Bearish" : null;
            if (closeSide != trend) continue; // touched but either closed dead-on the EMA or bounced the wrong way - not a continuation

            var beforeSignalStart = signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes;
            var summary = $"Price pulled back and touched the {fastPeriod} EMA (trend: {fastPeriod} EMA {(trend == "Bullish" ? "above" : "below")} the {slowPeriod} SMA) and closed back {(trend == "Bullish" ? "above" : "below")} it";

            if (beforeSignalStart)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", trend, $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
            }
            else if (trend == "Bullish" && !takeLongs)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", trend, $"{summary} - skipped, bearish only"));
            }
            else if (trend == "Bearish" && !takeShorts)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", trend, $"{summary} - skipped, bullish only"));
            }
            else
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", trend, summary));
                entries.Add((bar.Time, trend));
            }
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }
}

using OptionAnalytics.Server.Models;
using Skender.Stock.Indicators;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// Supertrend - an ATR-based trend-flip line (Olivier Seban), one of the single most widely used
/// intraday trend-following indicators in Indian retail trading specifically (this app's own home
/// turf), for exactly the reason this app is adding it: it is built to give a small, well-defined
/// risk (the line itself sits close to price, tightening as ATR contracts) while staying in a trend
/// for as long as it runs.
///
/// The line flips sides at each trend change - Skender's GetSuperTrend reports whichever side is
/// currently active as LowerBand (support, uptrend) or UpperBand (resistance, downtrend), the two
/// mutually exclusive at every bar. Bullish is the flip to LowerBand active, Bearish the flip to
/// UpperBand active - firing only the instant that flip happens, not on every bar the same side
/// continues to hold.
///
/// Small default stop-loss + wide default take-profit (SmallStopLossParameter/
/// LongRangeTakeProfitParameter), same reasoning as this app's other trend-following strategies:
/// most flips are noise in a choppy market and should be cut loose quickly, while a genuine trend
/// day is bounded by the session's own EOD exit rather than a target set too close to let it pay
/// off.
/// </summary>
public sealed class SuperTrendStrategy : IBacktestStrategy
{
    public string Key => "supertrend";
    public string Name => "Supertrend";
    public string Description => "The ATR-based Supertrend line (10-bar ATR, 3x multiplier by default) flips between acting as support and resistance as the trend changes - enters the instant it flips. Small stop-loss, wide take-profit by default - cut a false flip loose quickly, give a real trend room to run.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.SmallStopLossParameter(),
        OptionTradeSimulator.LongRangeTakeProfitParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        OptionTradeSimulator.SignalStartTimeParameter(),
        new BacktestParameterSpec("atrPeriod", "ATR (bars)", Default: 10, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("multiplier", "ATR multiplier", Default: 3, Min: 0.5m, Max: 10, Step: 0.1m),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Flips to uptrend only (buy CE)"),
            new BacktestParameterOption(DirectionShortOnly, "Flips to downtrend only (buy PE)"),
        }),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters);

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var atrPeriod = (int)parameters["atrPeriod"];
        var multiplier = (double)parameters["multiplier"];
        var direction = parameters["direction"];
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);

        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var bars = context.SpotBars;
        if (atrPeriod < 1 || bars.Count == 0) return (entries, signals);

        var quotes = bars.Select(c => new Quote
        {
            Date = c.Time.UtcDateTime,
            Open = c.Open,
            High = c.High,
            Low = c.Low,
            Close = c.Close,
            Volume = 0,
        }).ToList();

        var superTrend = quotes.GetSuperTrend(atrPeriod, multiplier).ToList();

        string? previousDirection = null;

        for (var i = 0; i < bars.Count; i++)
        {
            // LowerBand active means the line is currently acting as support below price (uptrend);
            // UpperBand active means resistance above price (downtrend) - the two are mutually
            // exclusive at every bar this indicator has a value for.
            var current = superTrend[i].LowerBand is not null ? "Bullish" : superTrend[i].UpperBand is not null ? "Bearish" : null;
            if (current is null) continue;
            if (current == previousDirection) { previousDirection = current; continue; } // holding, not flipping

            var bar = bars[i];
            var isBullish = current == "Bullish";
            var lineValue = superTrend[i].SuperTrend ?? 0;
            var summary = isBullish
                ? $"Supertrend flipped to support at {lineValue:0.##} - close ({bar.Close:0.##}) now above it"
                : $"Supertrend flipped to resistance at {lineValue:0.##} - close ({bar.Close:0.##}) now below it";

            if (signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current,
                    $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
            }
            else if (isBullish && !takeLongs)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{summary} - skipped, downtrend flips only"));
            }
            else if (!isBullish && !takeShorts)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{summary} - skipped, uptrend flips only"));
            }
            else
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", current, summary));
                entries.Add((bar.Time, current));
            }

            previousDirection = current;
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }
}

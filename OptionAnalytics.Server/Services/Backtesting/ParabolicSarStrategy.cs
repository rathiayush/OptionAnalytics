using OptionAnalytics.Server.Models;
using Skender.Stock.Indicators;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// J. Welles Wilder's Parabolic SAR (Stop And Reverse) - one of the most famous trend-following
/// systems ever published (Wilder's own 1978 "New Concepts in Technical Trading Systems", the same
/// book RSI and ADX/DMI come from), designed from the ground up to be exactly what this app's other
/// trend-following strategies approximate with a fixed stop: a price level that starts close to
/// entry (a small, well-defined risk) and accelerates toward price as the trend extends, always
/// sitting on the side the trend "cannot" cross without the trend itself being over.
///
/// Skender's GetParabolicSar reports IsReversal on the exact bar the dot flips sides - the SAR value
/// crossing from one side of price to the other - which is this strategy's entry: IsReversal AND
/// Sar below Close is Bullish (the dot just flipped to acting as a rising floor), IsReversal AND Sar
/// above Close is Bearish.
///
/// Small default stop-loss + wide default take-profit (SmallStopLossParameter/
/// LongRangeTakeProfitParameter): Wilder's own SAR already trails as a trend runs, which this app's
/// fixed-points execution engine cannot replicate directly, so a small fixed stop plus a wide fixed
/// target approximates the same "cut a false reversal quickly, let a real one run" intent without
/// needing a trailing-stop mechanism of its own.
/// </summary>
public sealed class ParabolicSarStrategy : IBacktestStrategy
{
    public string Key => "parabolic-sar";
    public string Name => "Parabolic SAR (Wilder)";
    public string Description => "J. Welles Wilder's Parabolic SAR: enters the instant the SAR dot flips sides - a flip below price is Bullish, above is Bearish. Small stop-loss, wide take-profit by default - cut a false reversal loose quickly, give a real trend room to run.";

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
        new BacktestParameterSpec("accelerationStep", "Acceleration step", Default: 0.02m, Min: 0.001m, Max: 0.5m, Step: 0.001m),
        new BacktestParameterSpec("maxAcceleration", "Max acceleration factor", Default: 0.2m, Min: 0.01m, Max: 1, Step: 0.01m),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Bullish flips only (buy CE)"),
            new BacktestParameterOption(DirectionShortOnly, "Bearish flips only (buy PE)"),
        }),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters);

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var accelerationStep = (double)parameters["accelerationStep"];
        var maxAcceleration = (double)parameters["maxAcceleration"];
        var direction = parameters["direction"];
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);

        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var bars = context.SpotBars;
        if (bars.Count == 0 || accelerationStep <= 0 || maxAcceleration <= 0) return (entries, signals);

        var quotes = bars.Select(c => new Quote
        {
            Date = c.Time.UtcDateTime,
            Open = c.Open,
            High = c.High,
            Low = c.Low,
            Close = c.Close,
            Volume = 0,
        }).ToList();

        var sar = quotes.GetParabolicSar(accelerationStep, maxAcceleration).ToList();

        for (var i = 0; i < bars.Count; i++)
        {
            if (sar[i].IsReversal is not true || sar[i].Sar is not { } sarValue) continue;

            var bar = bars[i];
            var isBullish = (decimal)sarValue < bar.Close;
            var current = isBullish ? "Bullish" : "Bearish";
            var summary = isBullish
                ? $"Parabolic SAR flipped below price ({sarValue:0.##} vs close {bar.Close:0.##})"
                : $"Parabolic SAR flipped above price ({sarValue:0.##} vs close {bar.Close:0.##})";

            if (signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current,
                    $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
            }
            else if (isBullish && !takeLongs)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{summary} - skipped, bearish flips only"));
            }
            else if (!isBullish && !takeShorts)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{summary} - skipped, bullish flips only"));
            }
            else
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", current, summary));
                entries.Add((bar.Time, current));
            }
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }
}

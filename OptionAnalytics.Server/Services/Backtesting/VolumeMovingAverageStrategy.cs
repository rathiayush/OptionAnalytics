using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// VMA - a Volume Moving Average crossover: a plain rolling average of each side's own RAW per-bar
/// traded volume (ATM CE vs ATM PE), read the same way CdvObvCrossoverStrategy reads CDV/OBV:
/// whichever side's average volume is currently higher is where the money is flowing, and a
/// crossover between the two lines is the signal. Genuinely different from that existing strategy
/// though, not a restatement of it - CDV/OBV are both signed, cumulative, delta-weighted series
/// (was this volume a buy or a sell, weighted by moneyness, added up over the whole session); a
/// volume moving average is unsigned, un-weighted, and RESETS every period (no memory of anything
/// before the last N bars) - it answers "which side is trading more right now", not "which side has
/// accumulated more net buying pressure today".
///
/// Uses BacktestStrategyContext.AtmCeVolumeBars/AtmPeVolumeBars specifically (added for this
/// strategy) rather than SpotBars - the underlying index itself carries no volume in this app at
/// all (an index is a calculated number, not a traded security), so "volume" here can only ever mean
/// the ATM option contracts' own traded volume, same as every other volume-based measure
/// (ObvCeSeries/ObvPeSeries, CdvCeSeries/CdvPeSeries) in this app already does.
///
/// Signal: the moving average of CE's own volume crosses the moving average of PE's own volume -
/// CE above PE is Bullish (call-side volume currently leads), PE above CE is Bearish - firing only
/// on the cross, not every bar the same side continues to lead. An optional thresholdPercent (the
/// same normalized (ce-pe)/(ce+pe)*100 lead CdvObvCrossoverStrategy's own threshold uses, so it
/// means the same thing here) requires the lead to be more than a hair's width before it counts.
/// </summary>
public sealed class VolumeMovingAverageStrategy : IBacktestStrategy
{
    public string Key => "vma-volume-moving-average";
    public string Name => "VMA - Volume Moving Average (CE vs PE)";
    public string Description => "A rolling average of each side's own ATM traded volume (CE vs PE, 5 bars by default) - enters the instant one side's average volume crosses above the other's, reading the crossover as where trading interest currently leans. An optional minimum lead filters out a razor-thin cross.";

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
        new BacktestParameterSpec("volumePeriod", "Volume moving average (bars)", Default: 5, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("thresholdPercent", "Minimum lead, % of combined volume (0 = off)", Default: 0, Min: 0, Max: 100, Step: 0.5m),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "CE volume leads only (buy CE)"),
            new BacktestParameterOption(DirectionShortOnly, "PE volume leads only (buy PE)"),
        }),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters);

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var volumePeriod = (int)parameters["volumePeriod"];
        var thresholdPercent = parameters.GetValueOrDefault("thresholdPercent", 0);
        var direction = parameters["direction"];
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);

        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var bars = context.SpotBars;
        if (volumePeriod < 1 || bars.Count == 0) return (entries, signals);

        var ceMaByTime = VolumeMovingAverageByTime(context.AtmCeVolumeBars, volumePeriod);
        var peMaByTime = VolumeMovingAverageByTime(context.AtmPeVolumeBars, volumePeriod);

        string? previousDirection = null;

        for (var i = 0; i < bars.Count; i++)
        {
            var bar = bars[i];
            if (!ceMaByTime.TryGetValue(bar.Time, out var ceMa) || !peMaByTime.TryGetValue(bar.Time, out var peMa)) continue;

            var current = ceMa > peMa ? "Bullish" : ceMa < peMa ? "Bearish" : null;
            if (current is null) continue;
            if (current == previousDirection) { previousDirection = current; continue; } // holding, not crossing

            var isBullish = current == "Bullish";
            var combined = ceMa + peMa;
            var leadPercent = combined > 0 ? Math.Abs(ceMa - peMa) / combined * 100 : 0;
            var crossLabel = isBullish
                ? $"ATM CE volume MA ({ceMa:0.##}) crossed above PE's ({peMa:0.##})"
                : $"ATM PE volume MA ({peMa:0.##}) crossed above CE's ({ceMa:0.##})";

            var passesThreshold = thresholdPercent <= 0 || leadPercent >= thresholdPercent;

            if (signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current,
                    $"{crossLabel} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
            }
            else if (!passesThreshold)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current,
                    $"{crossLabel}, but the lead ({leadPercent:0.##}%) is under the {thresholdPercent:0.##}% minimum - skipped"));
            }
            else if (isBullish && !takeLongs)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{crossLabel} - skipped, PE volume leads only"));
            }
            else if (!isBullish && !takeShorts)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", current, $"{crossLabel} - skipped, CE volume leads only"));
            }
            else
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", current, crossLabel));
                entries.Add((bar.Time, current));
            }

            previousDirection = current;
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }

    /// <summary>A plain, unsigned rolling average of Volume over the last <paramref name="period"/>
    /// bars, keyed by each bucket's own Time - unlike CDV/OBV this has no running memory at all: it
    /// only ever reflects the most recent window, exactly what "which side is trading more RIGHT
    /// NOW" needs.</summary>
    private static Dictionary<DateTimeOffset, decimal> VolumeMovingAverageByTime(IReadOnlyList<CandleWithVolume> bars, int period)
    {
        var result = new Dictionary<DateTimeOffset, decimal>();
        var window = new Queue<long>();
        long sum = 0;

        foreach (var bar in bars)
        {
            window.Enqueue(bar.Volume);
            sum += bar.Volume;
            if (window.Count > period) sum -= window.Dequeue();
            if (window.Count == period) result[bar.Time] = (decimal)sum / period;
        }

        return result;
    }
}

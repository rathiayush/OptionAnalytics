using OptionAnalytics.Server.Models;
using Skender.Stock.Indicators;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// A direct port of LuxAlgo's "Support and Resistance Levels with Breaks" (CC BY-NC-SA 4.0) as a
/// SEPARATE strategy, deliberately alongside (not replacing) SrFlowSellStrategy's own rolling-
/// channel S/R - the user's own explicit choice, since this is a genuinely different definition of
/// "the level" and changing SrFlowSellStrategy's would have silently changed every signal it has
/// ever produced.
///
/// THE LEVELS: swing-high/low PIVOTS (Pine's pivothigh/pivotlow(leftBars, rightBars) - a bar is a
/// pivot only once <paramref name="rightBars"/> bars have formed after it, the same confirmation lag
/// the source indicator has), held constant (Pine's fixnan) until the next pivot appears - one
/// resistance line, one support line, via Skender.Stock.Indicators' GetPivots (leftSpan/rightSpan),
/// same "use the library, don't hand-roll it" reasoning as TechnicalIndicators.
///
/// ENTRY mirrors the source indicator's own two alertcondition()s exactly (not its four separate
/// plotshape "clean break" vs "wick" labels, which are a cosmetic distinction the alerts themselves
/// don't make):
///   Bearish: close crosses UNDER the support line.
///   Bullish: close crosses OVER the resistance line.
///
/// OPTIONAL volume confirmation (off by default - see RequireVolumeConfirmationParameter's own doc
/// comment for why): the source's own volume oscillator, 100*(EMA5(volume)-EMA10(volume))/EMA10(volume)
/// must clear VolumeThreshold (20, the source's own default).
///
/// EXIT/stop/target: the source is a pure marker/alert indicator with no taught trade management, so
/// this uses the app's standard option-premium stop/target parameters, same as every other strategy.
/// </summary>
public sealed class LuxAlgoSrBreakStrategy : IBacktestStrategy
{
    public string Key => "luxalgo-sr-break";
    public string Name => "S/R Pivot Break (LuxAlgo)";
    public string Description => "Support/resistance from confirmed swing-high/low pivots (LuxAlgo's public-domain indicator), held constant until the next pivot appears. Entry when close crosses under support (Bearish) or over resistance (Bullish). Optionally also requires a volume-oscillator confirmation, off by default since index spot volume is not always available.";

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
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Bullish only"),
            new BacktestParameterOption(DirectionShortOnly, "Bearish only"),
        }),
        new BacktestParameterSpec("leftBars", "Pivot left bars", Default: 15, Min: 2, Max: 100, Step: 1),
        new BacktestParameterSpec("rightBars", "Pivot right bars (confirmation lag)", Default: 15, Min: 2, Max: 100, Step: 1),
        // Off by default: real index spot volume only exists via Dhan's own January 2026 rollout
        // (see BacktestStrategyContext.SpotVolumeBarsOneMinute's own doc comment) - defaulting this
        // ON would silently produce zero entries for any account/window that plan doesn't cover,
        // which reads as "the strategy is broken" rather than "a filter with no data to check."
        new BacktestParameterSpec("requireVolumeConfirmation", "Also require the volume oscillator to confirm", Default: FlagOff, Min: FlagOff, Max: FlagOn, Step: 1, Options: new[]
        {
            new BacktestParameterOption(FlagOff, "No - price action only (as alerted)"),
            new BacktestParameterOption(FlagOn, "Yes - needs real spot volume data"),
        }),
        new BacktestParameterSpec("volumeShortEma", "Volume oscillator fast EMA (bars)", Default: 5, Min: 1, Max: 100, Step: 1),
        new BacktestParameterSpec("volumeLongEma", "Volume oscillator slow EMA (bars)", Default: 10, Min: 2, Max: 200, Step: 1),
        new BacktestParameterSpec("volumeThreshold", "Volume oscillator must exceed", Default: 20, Min: 0, Max: 200, Step: 1),
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
        var leftBars = Math.Max(2, (int)parameters["leftBars"]);
        var rightBars = Math.Max(2, (int)parameters["rightBars"]);
        var requireVolume = parameters.GetValueOrDefault("requireVolumeConfirmation", FlagOff) >= (FlagOff + FlagOn) / 2;
        var volumeThreshold = parameters.GetValueOrDefault("volumeThreshold", 20m);

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var bars = context.SpotBars;
        if (bars.Count < 2) return (entries, signals);

        var (resistance, support) = PivotLines(bars, leftBars, rightBars);
        var oscillator = requireVolume
            ? VolumeOscillator(context.SpotVolumeBarsOneMinute, context.TimeframeMinutes, bars, (int)parameters.GetValueOrDefault("volumeShortEma", 5), (int)parameters.GetValueOrDefault("volumeLongEma", 10))
            : null;

        for (var i = 1; i < bars.Count; i++)
        {
            var bar = bars[i];
            var prevBar = bars[i - 1];
            var beforeSignalStart = signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes;

            bool VolumeOk(out string reason)
            {
                if (!requireVolume) { reason = ""; return true; }
                var osc = oscillator is { Count: > 0 } && i < oscillator.Count ? oscillator[i] : null;
                if (osc is not { } value)
                {
                    reason = "volume oscillator not ready yet";
                    return false;
                }
                var ok = value > volumeThreshold;
                reason = ok ? $"volume oscillator {value:0.#} clears {volumeThreshold:0.#}" : $"volume oscillator {value:0.#} does not clear {volumeThreshold:0.#}";
                return ok;
            }

            // Bearish: close crosses UNDER support (Pine's crossunder(close, lowUsePivot)).
            if (support[i] is { } sup && support[i - 1] is { } prevSup && prevBar.Close >= prevSup && bar.Close < sup)
            {
                var summary = $"Close crossed under support {sup:0.##} (pivot, {leftBars}/{rightBars} bars)";
                if (beforeSignalStart)
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bearish", $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
                else if (!takeShorts)
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bearish", $"{summary} - skipped, longs only"));
                else if (!VolumeOk(out var reason))
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bearish", $"{summary} - but {reason}"));
                else
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", "Bearish", requireVolume ? $"{summary}, and {VolumeReason(oscillator, i, volumeThreshold)}" : summary));
                    entries.Add((bar.Time, "Bearish"));
                }
            }
            // Bullish: close crosses OVER resistance (Pine's crossover(close, highUsePivot)).
            else if (resistance[i] is { } res && resistance[i - 1] is { } prevRes && prevBar.Close <= prevRes && bar.Close > res)
            {
                var summary = $"Close crossed over resistance {res:0.##} (pivot, {leftBars}/{rightBars} bars)";
                if (beforeSignalStart)
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bullish", $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
                else if (!takeLongs)
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bullish", $"{summary} - skipped, shorts only"));
                else if (!VolumeOk(out var reason))
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bullish", $"{summary} - but {reason}"));
                else
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", "Bullish", requireVolume ? $"{summary}, and {VolumeReason(oscillator, i, volumeThreshold)}" : summary));
                    entries.Add((bar.Time, "Bullish"));
                }
            }
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }

    private static string VolumeReason(IReadOnlyList<decimal?>? oscillator, int index, decimal threshold)
    {
        var value = oscillator is { Count: > 0 } && index < oscillator.Count ? oscillator[index] : null;
        return value is { } v ? $"volume oscillator {v:0.#} clears {threshold:0.#}" : "";
    }

    /// <summary>Resistance/support as of every bar, carried forward from the most recent CONFIRMED
    /// pivot - Pine's fixnan(pivothigh(leftBars, rightBars)[1]) equivalent. Skender's GetPivots
    /// reports HighPoint/LowPoint AT THE ORIGINAL SWING BAR's own index, not at the bar where it
    /// actually becomes knowable (rightBars later) - using it at that index directly would be a
    /// look-ahead bug, so this shifts each detected point forward by rightBars bars before holding
    /// it flat, the same confirmation lag the source Pine indicator has.</summary>
    private static (IReadOnlyList<decimal?> Resistance, IReadOnlyList<decimal?> Support) PivotLines(IReadOnlyList<Candle> bars, int leftBars, int rightBars)
    {
        var quotes = bars.Select(c => new Quote { Date = c.Time.UtcDateTime, Open = c.Open, High = c.High, Low = c.Low, Close = c.Close, Volume = 0 }).ToList();
        var results = quotes.GetPivots(leftBars, rightBars).ToList();

        var highEvents = new Dictionary<int, decimal>();
        var lowEvents = new Dictionary<int, decimal>();
        for (var i = 0; i < results.Count; i++)
        {
            var confirmIndex = Math.Min(bars.Count - 1, i + rightBars);
            if (results[i].HighPoint is { } hp) highEvents[confirmIndex] = (decimal)hp;
            if (results[i].LowPoint is { } lp) lowEvents[confirmIndex] = (decimal)lp;
        }

        var resistance = new decimal?[bars.Count];
        var support = new decimal?[bars.Count];
        decimal? runningHigh = null, runningLow = null;
        for (var i = 0; i < bars.Count; i++)
        {
            if (highEvents.TryGetValue(i, out var h)) runningHigh = h;
            if (lowEvents.TryGetValue(i, out var l)) runningLow = l;
            resistance[i] = runningHigh;
            support[i] = runningLow;
        }

        return (resistance, support);
    }

    /// <summary>100*(EMA(volumeShortEma)-EMA(volumeLongEma))/EMA(volumeLongEma) of volume, aggregated
    /// to <paramref name="timeframeMinutes"/> and aligned to <paramref name="priceBars"/> by time -
    /// the two series come from the same underlying tick stream at the same aggregation, so they line
    /// up bar-for-bar; a bar with no matching volume bar (a gap) reads as null, same as "not ready
    /// yet" for any other indicator here. EMA is computed by handing the volume series through
    /// EmaCrossoverDetector.EmaSeries as a flat OHLC candle - the same trick CdvUnderlyingState.
    /// SmoothEma uses to reuse a Close-based EMA for a plain running-total series.</summary>
    private static List<decimal?> VolumeOscillator(IReadOnlyList<CandleWithVolume> volumeBarsOneMinute, int timeframeMinutes, IReadOnlyList<Candle> priceBars, int shortPeriod, int longPeriod)
    {
        var aggregated = BacktestUtil.AggregateCandlesWithVolume(volumeBarsOneMinute, Math.Max(1, timeframeMinutes));
        var volumeByTime = aggregated.ToDictionary(b => b.Time, b => (decimal)b.Volume);

        var volumeCandles = priceBars.Select(b => volumeByTime.TryGetValue(b.Time, out var vol) ? new Candle(b.Time, vol, vol, vol, vol) : new Candle(b.Time, 0, 0, 0, 0)).ToList();
        var shortEma = EmaCrossoverDetector.EmaSeries(volumeCandles, Math.Max(1, shortPeriod));
        var longEma = EmaCrossoverDetector.EmaSeries(volumeCandles, Math.Max(2, longPeriod));

        return priceBars.Select((_, i) =>
        {
            if (shortEma[i] is not { } s || longEma[i] is not { } l || l == 0) return (decimal?)null;
            return 100m * (s - l) / l;
        }).ToList();
    }
}

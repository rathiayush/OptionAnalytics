using OptionAnalytics.Server.Models;
using Skender.Stock.Indicators;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// Generic technical-indicator confirmation, the same "optional opt-in filter" shape
/// FlowConfirmation already gives OBV/CDV - RSI, ADX(+DMI), MACD and SuperTrend, each independently
/// toggleable with its own period/threshold parameters and a sensible bull/bear default, so any
/// strategy can hook in exactly the ones it wants (FiveEmaStrategy is the first). All four are
/// computed once per full bar series via Skender.Stock.Indicators (the same library
/// EmaCrossoverDetector.EmaSeries already uses), never hand-rolled - ADX/SuperTrend in particular
/// have enough easy-to-get-subtly-wrong bookkeeping (Wilder smoothing, band-flip carry-forward) that
/// a second, in-house implementation would be exactly the kind of drift this app's own strategies
/// try hard to avoid elsewhere (see ExpiredOptionDataPrefetchHostedService's own doc comment on the
/// same principle).
///
/// A bar with no reading yet (the indicator's own warm-up period hasn't filled) confirms NEITHER
/// direction - "no data" is not evidence for a trade, the same stance FlowConfirmation.Favors takes.
/// </summary>
public static class TechnicalIndicators
{
    private const decimal FlagOff = 0;
    private const decimal FlagOn = 1;

    private static List<Quote> ToQuotes(IReadOnlyList<Candle> bars) => bars.Select(c => new Quote
    {
        Date = c.Time.UtcDateTime,
        Open = c.Open,
        High = c.High,
        Low = c.Low,
        Close = c.Close,
        Volume = 0,
    }).ToList();

    // ---- RSI: bullish above BullThreshold, bearish below BearThreshold, neither in between (a
    // "no strong momentum either way" zone, not itself confirming a trade). Defaults (60/40) are a
    // momentum-CONFIRMATION reading, deliberately not the classic 70/30 overbought/oversold pair -
    // 70/30 flags a REVERSAL setup, the opposite of what a strategy wanting RSI to agree with an
    // already-decided direction needs. ----

    public static BacktestParameterSpec RequireRsiParameter() =>
        new("requireRsiConfirmation", "Also require RSI to confirm", Default: FlagOff, Min: FlagOff, Max: FlagOn, Step: 1, Options: new[]
        {
            new BacktestParameterOption(FlagOff, "No"),
            new BacktestParameterOption(FlagOn, "Yes"),
        });

    public static BacktestParameterSpec RsiPeriodParameter() => new("rsiPeriod", "RSI (bars)", Default: 14, Min: 2, Max: 100, Step: 1);
    public static BacktestParameterSpec RsiBullThresholdParameter() => new("rsiBullThreshold", "RSI bullish above", Default: 60, Min: 50, Max: 90, Step: 1);
    public static BacktestParameterSpec RsiBearThresholdParameter() => new("rsiBearThreshold", "RSI bearish below", Default: 40, Min: 10, Max: 50, Step: 1);

    public static IReadOnlyList<bool?> RsiBullish(IReadOnlyList<Candle> bars, int period, decimal bullThreshold, decimal bearThreshold)
    {
        var results = ToQuotes(bars).GetRsi(Math.Max(2, period)).ToList();
        return results.Select(r => r.Rsi is not { } v ? (bool?)null : (decimal)v >= bullThreshold ? true : (decimal)v <= bearThreshold ? false : (bool?)null).ToList();
    }

    // ---- ADX + DMI: direction comes from +DI vs -DI (which side of the move is winning), ADX
    // itself only gates STRENGTH (25 is the standard "this is a real trend, not chop" threshold) -
    // below it, neither direction is confirmed regardless of which DI leads, since a weak/ranging
    // market's DI crossovers are noise. ----

    public static BacktestParameterSpec RequireAdxParameter() =>
        new("requireAdxConfirmation", "Also require ADX/DMI to confirm", Default: FlagOff, Min: FlagOff, Max: FlagOn, Step: 1, Options: new[]
        {
            new BacktestParameterOption(FlagOff, "No"),
            new BacktestParameterOption(FlagOn, "Yes"),
        });

    public static BacktestParameterSpec AdxPeriodParameter() => new("adxPeriod", "ADX (bars)", Default: 14, Min: 2, Max: 100, Step: 1);
    public static BacktestParameterSpec AdxMinStrengthParameter() => new("adxMinStrength", "ADX must be at least (trend strength)", Default: 25, Min: 0, Max: 60, Step: 1);

    public static IReadOnlyList<bool?> AdxBullish(IReadOnlyList<Candle> bars, int period, decimal minStrength)
    {
        var results = ToQuotes(bars).GetAdx(Math.Max(2, period)).ToList();
        return results.Select(r =>
        {
            if (r.Adx is not { } adxRaw || r.Pdi is not { } pdi || r.Mdi is not { } mdi) return (bool?)null;
            var adx = (decimal)adxRaw;
            if (adx < minStrength) return null; // trending too weakly to trust either DI's lead
            if (pdi > mdi) return true;
            if (mdi > pdi) return false;
            return (bool?)null; // exactly equal - no lead either way
        }).ToList();
    }

    // ---- MACD: bullish when the MACD line sits above its own signal line, bearish when below -
    // the standard crossover reading, not the histogram's sign (same information, but the line-vs-
    // signal comparison is the conventional "which side is this on right now" check). ----

    public static BacktestParameterSpec RequireMacdParameter() =>
        new("requireMacdConfirmation", "Also require MACD to confirm", Default: FlagOff, Min: FlagOff, Max: FlagOn, Step: 1, Options: new[]
        {
            new BacktestParameterOption(FlagOff, "No"),
            new BacktestParameterOption(FlagOn, "Yes"),
        });

    public static BacktestParameterSpec MacdFastPeriodParameter() => new("macdFastPeriod", "MACD fast EMA (bars)", Default: 12, Min: 2, Max: 100, Step: 1);
    public static BacktestParameterSpec MacdSlowPeriodParameter() => new("macdSlowPeriod", "MACD slow EMA (bars)", Default: 26, Min: 3, Max: 200, Step: 1);
    public static BacktestParameterSpec MacdSignalPeriodParameter() => new("macdSignalPeriod", "MACD signal EMA (bars)", Default: 9, Min: 1, Max: 100, Step: 1);

    public static IReadOnlyList<bool?> MacdBullish(IReadOnlyList<Candle> bars, int fastPeriod, int slowPeriod, int signalPeriod)
    {
        var results = ToQuotes(bars).GetMacd(Math.Max(2, fastPeriod), Math.Max(fastPeriod + 1, slowPeriod), Math.Max(1, signalPeriod)).ToList();
        return results.Select(r => r.Macd is not { } macd || r.Signal is not { } signal ? (bool?)null : macd > signal ? true : macd < signal ? false : (bool?)null).ToList();
    }

    // ---- SuperTrend: bullish while price sits above the SuperTrend line (the line tracks the
    // LOWER band), bearish while below it (line tracks the UPPER band) - the line itself flips side
    // the moment price crosses it, which is what "SuperTrend direction" conventionally means. ----

    public static BacktestParameterSpec RequireSuperTrendParameter() =>
        new("requireSuperTrendConfirmation", "Also require SuperTrend to confirm", Default: FlagOff, Min: FlagOff, Max: FlagOn, Step: 1, Options: new[]
        {
            new BacktestParameterOption(FlagOff, "No"),
            new BacktestParameterOption(FlagOn, "Yes"),
        });

    public static BacktestParameterSpec SuperTrendPeriodParameter() => new("superTrendPeriod", "SuperTrend ATR (bars)", Default: 10, Min: 2, Max: 100, Step: 1);
    public static BacktestParameterSpec SuperTrendMultiplierParameter() => new("superTrendMultiplier", "SuperTrend multiplier", Default: 3, Min: 1, Max: 10, Step: 0.5m);

    public static IReadOnlyList<bool?> SuperTrendBullish(IReadOnlyList<Candle> bars, int period, decimal multiplier)
    {
        var results = ToQuotes(bars).GetSuperTrend(Math.Max(2, period), (double)multiplier).ToList();
        return results.Select((r, i) => r.SuperTrend is not { } st ? (bool?)null : bars[i].Close > st).ToList();
    }

    /// <summary>All four indicators together: only the ones whose own Require*Parameter is ON are
    /// consulted, and EVERY one of those enabled has to agree with <paramref name="bullish"/> at bar
    /// <paramref name="index"/> for this to confirm - adding a filter only ever narrows what passes,
    /// same as ANDing another condition onto an existing rule. True (no reason given) when nothing
    /// is enabled, so a strategy's own default (nobody has opted in) is a total no-op exactly like
    /// FlowConfirmation's own off-by-default filter.</summary>
    public static (bool Ok, string Reason) Confirm(
        IReadOnlyList<Candle> bars, int index, bool bullish, IReadOnlyDictionary<string, decimal> parameters,
        IReadOnlyList<bool?>? rsi, IReadOnlyList<bool?>? adx, IReadOnlyList<bool?>? macd, IReadOnlyList<bool?>? superTrend)
    {
        var failures = new List<string>();
        var confirmations = new List<string>();

        void Check(string flagKey, string label, IReadOnlyList<bool?>? series)
        {
            if (parameters.GetValueOrDefault(flagKey, FlagOff) < (FlagOff + FlagOn) / 2) return;
            var reading = series is { Count: > 0 } && index < series.Count ? series[index] : null;
            if (reading == bullish) confirmations.Add(label);
            else failures.Add(reading is null ? $"{label} not ready yet" : $"{label} does not confirm");
        }

        Check("requireRsiConfirmation", "RSI", rsi);
        Check("requireAdxConfirmation", "ADX/DMI", adx);
        Check("requireMacdConfirmation", "MACD", macd);
        Check("requireSuperTrendConfirmation", "SuperTrend", superTrend);

        if (failures.Count > 0) return (false, string.Join(", ", failures));
        return (true, confirmations.Count > 0 ? string.Join(" and ", confirmations) + " confirm" : "");
    }
}

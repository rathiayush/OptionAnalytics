using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Runs a registered IBacktestStrategy against an EXPIRED contract, given an actual calendar expiry
/// date - the thing BacktestService itself cannot do, since it only ever reads whatever spot/ATM
/// candle history SpotFeedHostedService/CdvHostedService currently hold LIVE in memory (a rolling
/// window of recent trading days, nothing that has already expired).
///
/// Two data sources feed one BacktestStrategyContext:
///   - SPOT bars come from Dhan's ordinary /charts/intraday endpoint (DhanHistoricalDataService) -
///     real OHLC, the same source the live app already trusts for spot. Deliberately NOT sourced
///     from the rolling-option endpoint's own "spot" field: that field is a single scalar per bar
///     (no separate spot-open/high/low), so building a synthetic candle from it (Open=High=Low=
///     Close) would silently corrupt any breakout/EMA-touch logic that reads a bar's High/Low - the
///     exact thing FiveEmaStrategy's alert-candle rule depends on. If /charts/intraday doesn't
///     reach back far enough for the requested date range, this fails loudly (see RunAsync) rather
///     than falling back to that degraded shape.
///   - The OPTION premium comes from Dhan's rolling-option endpoint (DhanRollingOptionDataService) -
///     the only way to reach an expired contract's own price history at all.
///
/// Only strategies whose ENTIRE signal and pricing logic reads spot bars plus ONE CE/PE strike
/// relative to ATM are supported (see SupportedStrategyKeys) - EmaCrossAtmFlowStrategy needs OBV/
/// CDV computed across the WHOLE surrounding strike chain (see BacktestStrategyContext.
/// ObvCeSeries/CdvCeSeries), which would need ~17 separate rolling-option calls per side per run;
/// unsupported here rather than built on synthetic/empty flow series that would silently never
/// confirm a trade.
///
/// GetOptionBars/GetOptionBarsOneMinute below ignore the actual "strike" value a strategy passes
/// in and always return the one relative-strike series this run fetched - which is correct, not an
/// approximation: OptionTradeSimulator computes that argument as "ATM at the signal's own time +-
/// otmSteps", and the rolling-option endpoint was asked for exactly that same relative position
/// ("ATM+otmSteps" for the call leg, "ATM-otmSteps" for the put leg), re-resolved by Dhan itself as
/// spot moves through the window. Different runs use different otmSteps, so a new run always
/// re-fetches rather than serving stale strikes from a previous one.
/// </summary>
public sealed class ExpiredOptionBacktestService
{
    private static readonly HashSet<string> SupportedStrategyKeys = new() { "five-ema", "five-ema-v2" };

    /// <summary>Underlyings this feature supports at all - Dhan's rolling-option docs only ever show
    /// "NSE_FNO" as the exchange segment, never a BSE one, so SENSEX is left out rather than
    /// guessed at.</summary>
    private static readonly Dictionary<string, int> StrikeStepByUnderlying = new(StringComparer.OrdinalIgnoreCase)
    {
        ["NIFTY"] = 50,
        ["BANKNIFTY"] = 100,
    };

    private readonly DhanSpotInstrumentMaster _instrumentMaster;
    private readonly DhanHistoricalDataService _historicalData;
    private readonly DhanRollingOptionDataService _rollingOption;
    private readonly IReadOnlyDictionary<string, IBacktestStrategy> _strategies;

    public ExpiredOptionBacktestService(
        DhanSpotInstrumentMaster instrumentMaster,
        DhanHistoricalDataService historicalData,
        DhanRollingOptionDataService rollingOption,
        IEnumerable<IBacktestStrategy> strategies)
    {
        _instrumentMaster = instrumentMaster;
        _historicalData = historicalData;
        _rollingOption = rollingOption;
        _strategies = strategies.Where(s => SupportedStrategyKeys.Contains(s.Key)).ToDictionary(s => s.Key);
    }

    /// <summary>Metadata for just the strategies this page can actually run - see
    /// SupportedStrategyKeys. Same BacktestStrategyInfo shape BacktestService.GetStrategies uses, so
    /// the frontend's existing generic parameter-rendering code works unchanged here.</summary>
    public IReadOnlyList<BacktestStrategyInfo> GetStrategies() =>
        _strategies.Values.Select(s => new BacktestStrategyInfo(s.Key, s.Name, s.Description, s.Parameters)).OrderBy(s => s.Name).ToList();

    public async Task<ExpiredBacktestResult> RunAsync(
        string underlying, string expiryFlag, DateOnly expiryDate, int lookbackDays, string strategyKey,
        int timeframeMinutes, int expiryCodeAdjust, IReadOnlyDictionary<string, decimal> parameters,
        CancellationToken cancellationToken)
    {
        if (!StrikeStepByUnderlying.TryGetValue(underlying, out var step))
            return ExpiredBacktestResult.Failed($"'{underlying}' is not supported - only NIFTY and BANKNIFTY (Dhan's rolling-option API only documents NSE_FNO index options).");

        if (!_strategies.TryGetValue(strategyKey, out var strategy))
            return ExpiredBacktestResult.Failed(
                $"'{strategyKey}' cannot run against expired-option history - it needs order-flow (OBV/CDV) across the whole surrounding strike chain, which Dhan's rolling-option endpoint does not provide (a single relative strike per call only). Supported here: {string.Join(", ", SupportedStrategyKeys)}.");

        // A no-op once SpotFeedHostedService's own startup resolve has already loaded the shared
        // instance (see EnsureLoadedAsync's freshness check) - only actually downloads/parses
        // anything on a cold request that beat that background resolve to it.
        await _instrumentMaster.EnsureLoadedAsync(cancellationToken);

        var instrument = _instrumentMaster.FindSpot(underlying);
        if (instrument is null)
            return ExpiredBacktestResult.Failed($"Could not resolve {underlying}'s Dhan security id yet - the scrip master may still be loading. Try again shortly.");

        var toDay = expiryDate;
        var fromDay = expiryDate.AddDays(-Math.Max(1, lookbackDays));

        var spotBars1m = await _historicalData.GetIntradayCandlesAsync(instrument.SecurityId, instrument.DhanSegment, fromDay, toDay, 1, cancellationToken);
        if (spotBars1m.Count == 0)
            return ExpiredBacktestResult.Failed($"No spot history for {underlying} between {fromDay:dd MMM yyyy} and {toDay:dd MMM yyyy} - Dhan's intraday history may not reach back that far for a window this old.");

        // Every parameter the strategy declares but the caller omitted falls back to its own
        // default - same rule BacktestService.Prepare uses, so a strategy implementation can always
        // assume the dictionary handed to Simulate/EntrySignals is complete.
        var mergedParameters = strategy.Parameters.ToDictionary(p => p.Key, p => parameters.TryGetValue(p.Key, out var v) ? v : p.Default);
        var otmSteps = (int)mergedParameters.GetValueOrDefault("otmSteps", 0);

        var ceStrike = StrikeToken(otmSteps);
        var peStrike = StrikeToken(-otmSteps);
        var expiryCode = Math.Clamp(ComputeExpiryCode(expiryFlag, fromDay, toDay) + expiryCodeAdjust, 0, 10);

        var ceTask = _rollingOption.GetRollingOptionCandlesAsync(instrument.SecurityId, expiryFlag, expiryCode, ceStrike, "CALL", fromDay, toDay, 1, cancellationToken);
        var peTask = _rollingOption.GetRollingOptionCandlesAsync(instrument.SecurityId, expiryFlag, expiryCode, peStrike, "PUT", fromDay, toDay, 1, cancellationToken);
        await Task.WhenAll(ceTask, peTask);
        var (ceBars1m, ceError) = ceTask.Result;
        var (peBars1m, peError) = peTask.Result;

        var timeframe = Math.Max(1, timeframeMinutes);
        var ceCandles1m = ceBars1m.Select(c => c.ToCandle()).ToList();
        var peCandles1m = peBars1m.Select(c => c.ToCandle()).ToList();
        var ceCandlesTf = BacktestUtil.AggregateCandles(ceCandles1m, timeframe);
        var peCandlesTf = BacktestUtil.AggregateCandles(peCandles1m, timeframe);

        var context = new BacktestStrategyContext
        {
            Underlying = underlying,
            TimeframeMinutes = timeframe,
            Step = step,
            SpotBars = BacktestUtil.AggregateCandles(spotBars1m, timeframe),
            SpotBarsOneMinute = spotBars1m,
            ConfluenceSignalsAscending = Array.Empty<BacktestSignal>(),
            AllSignals = Array.Empty<BacktestSignal>(),
            ObvCeSeries = Array.Empty<ObvPoint>(),
            ObvPeSeries = Array.Empty<ObvPoint>(),
            CdvCeSeries = Array.Empty<ObvPoint>(),
            CdvPeSeries = Array.Empty<ObvPoint>(),
            // Ignores the strike argument on purpose - see this class's own doc comment.
            GetOptionBars = (_, isCall) => isCall ? ceCandlesTf : peCandlesTf,
            GetOptionBarsOneMinute = (_, isCall) => isCall ? ceCandles1m : peCandles1m,
            AtmCeBars = Array.Empty<Candle>(),
            AtmPeBars = Array.Empty<Candle>(),
            AtmCeVolumeBars = Array.Empty<CandleWithVolume>(),
            AtmPeVolumeBars = Array.Empty<CandleWithVolume>(),
            AtmStrike = null,
        };

        var trades = strategy.Simulate(context, mergedParameters);
        var signals = strategy.EntrySignals(context, mergedParameters);

        return new ExpiredBacktestResult(
            true, null, trades, signals, expiryCode, ceStrike, peStrike, ceError, peError,
            spotBars1m.Count, ceBars1m.Count, peBars1m.Count);
    }

    private static string StrikeToken(int steps) => steps == 0 ? "ATM" : $"ATM{(steps > 0 ? "+" : "")}{steps}";

    /// <summary>Derives Dhan's expiryCode (0,1,2... - see DhanRollingOptionDataService's own doc
    /// comment for why it is neither negative nor relative to today) from an actual calendar expiry
    /// date: how many expiry CYCLES of the chosen cadence fall between the query range's own start
    /// and the requested expiry.
    ///
    /// WEEKLY expiries land on a fixed weekday (Thursday, historically, though NSE has moved this
    /// before and a holiday shifts any individual week's own expiry by a day) - but every week still
    /// has exactly one, so counting whole 7-day cycles between the two dates is robust to exactly
    /// WHICH day of the week it falls on, only to how many weeks have passed. MONTHLY expiries are
    /// even more stable: exactly one per calendar month regardless of holidays, so counting calendar
    /// months elapsed is exact rather than approximate.
    ///
    /// This is still a DERIVATION, not something Dhan confirms - RunAsync's caller can nudge it via
    /// expiryCodeAdjust if a run's results don't look like they landed on the intended contract.</summary>
    internal static int ComputeExpiryCode(string expiryFlag, DateOnly fromDay, DateOnly toDay)
    {
        if (string.Equals(expiryFlag, "MONTH", StringComparison.OrdinalIgnoreCase))
        {
            var months = (toDay.Year * 12 + toDay.Month) - (fromDay.Year * 12 + fromDay.Month);
            return Math.Clamp(months, 0, 10);
        }

        var weeks = (int)Math.Round((toDay.DayNumber - fromDay.DayNumber) / 7.0, MidpointRounding.AwayFromZero);
        return Math.Clamp(weeks, 0, 10);
    }
}

namespace OptionAnalytics.Server.Models;

/// <summary>One stored 1-minute OI/IV reading for a single, ABSOLUTE strike/side - see
/// StrikeOiIvHistoryService's own doc comment for how this gets reconstructed from
/// NiftyDataCollector's ATM-relative rolling-option storage. Carries no price - the Strike Data
/// page already has that from its own OHLC candle fetch; this exists purely to be merged into that
/// same table by matching Time.</summary>
public readonly record struct StrikeOiIvPoint(DateTimeOffset Time, long? OpenInterest, decimal? ImpliedVolatility);

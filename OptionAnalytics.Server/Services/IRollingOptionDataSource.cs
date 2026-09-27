using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// One "give me this relative contract's own bars" source, abstracted so
/// ExpiredOptionBacktestService can switch between two interchangeable implementations at runtime,
/// per request (see its own useStoredData parameter):
///
///  - DhanRollingOptionDataService - live, calls Dhan's /charts/rollingoption on every request not
///    already served by ExpiredOptionDataStore's own CSV cache.
///  - StoredRollingOptionDataService - reads NiftyDataCollector's own TimescaleDB
///    (rolling_option_bars_1m), which already holds real historical OI/IV/OHLC for the same
///    underlying/expiryFlag/expiryCode/strike-offset/side shape Dhan's own endpoint uses - no live
///    Dhan call at all when this path is taken.
///
/// Both take `underlying` (e.g. "NIFTY") even though only the stored implementation actually needs
/// it (the live one identifies the underlying by underlyingSecurityId instead) - one shared
/// signature keeps ExpiredOptionBacktestService's own call sites identical regardless of which
/// source is selected.
/// </summary>
public interface IRollingOptionDataSource
{
    /// <summary><paramref name="interactive"/> only matters for the live Dhan-backed
    /// implementation (DhanRollingOptionDataService) - see DhanDataApiRateLimiter's own doc
    /// comment for why a call made directly on behalf of a waiting user needs a separate lane from
    /// a hosted background service's own prefetch work. StoredRollingOptionDataService ignores it
    /// entirely (no Dhan call, no rate limit to lane).</summary>
    Task<(IReadOnlyList<(CandleWithVolume Bar, decimal? Strike, decimal? Spot, long? OpenInterest, decimal? ImpliedVolatility)> Bars, string? Error)> GetRollingOptionCandlesAsync(
        string underlying, uint underlyingSecurityId, string expiryFlag, int expiryCode, string strike, string drvOptionType,
        DateOnly fromDay, DateOnly toDay, int intervalMinutes, CancellationToken cancellationToken, bool interactive = true);
}

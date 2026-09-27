using System.Threading.RateLimiting;
using Microsoft.Extensions.Options;

namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// Enforces Dhan API v2's own documented "Data APIs" rate limit - 5 requests/second, 100,000/day,
/// confirmed ACCOUNT-WIDE rather than per-endpoint (Dhan's official v2 docs, cross-confirmed by
/// its support article on API rate limits, and independently corroborated by
/// DhanRollingOptionDataService's own pre-existing doc comment stating the same fact) - shared
/// across every Data-API-category caller in this process: DhanHistoricalDataService's
/// /charts/intraday and DhanRollingOptionDataService's /charts/rollingoption. Registered as a
/// SINGLETON precisely because the limit is account-wide: a limiter scoped to one service
/// instance, or one incoming page request, cannot see calls made by any other service/request at
/// the same time, so only a single shared instance can actually gate the true combined call rate
/// Dhan measures.
///
/// Deliberately NOT used by DhanOrderClient/DhanSuperOrderClient/DhanPositionsClient (Order APIs -
/// a different, higher documented limit: 10/sec - and these place live-money orders, so this
/// change stays scoped away from them entirely) or by DhanOptionChainQuotes (which already
/// self-throttles to that endpoint's own documented, stricter "one call every 3 seconds per
/// underlying/expiry" via its own MinimumCallSpacing, a different category again). Mixing all of
/// those into one limiter would either starve Order APIs of headroom they are documented to have,
/// or under-use what Data APIs are actually allowed.
///
/// A SlidingWindowRateLimiter, not a plain concurrency semaphore (the previous approach in
/// OiReplayService, before this change): a semaphore caps how many requests may be IN FLIGHT
/// simultaneously, which does not bound the RATE new requests start at when responses return
/// quickly - exactly what a fast Dhan response would do. Only a real rate limiter enforces "at
/// most N per second," the actual shape of Dhan's documented limit.
/// </summary>
public sealed class DhanDataApiRateLimiter : IDisposable
{
    private readonly RateLimiter _limiter;
    private readonly ILogger<DhanDataApiRateLimiter> _logger;

    public DhanDataApiRateLimiter(IOptions<DhanOptions> options, ILogger<DhanDataApiRateLimiter> logger)
    {
        _logger = logger;
        var permitsPerSecond = Math.Max(1, options.Value.DataApiRequestsPerSecond);
        _limiter = new SlidingWindowRateLimiter(new SlidingWindowRateLimiterOptions
        {
            PermitLimit = permitsPerSecond,
            Window = TimeSpan.FromSeconds(1),
            SegmentsPerWindow = permitsPerSecond,
            QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
            // RateLimiter requires a finite queue - generous rather than tight, since OiReplayService's
            // own worst case (42 strike/side fetches queuing at once) comfortably fits well within it.
            QueueLimit = 200,
        });
    }

    /// <summary>Waits until Dhan's own documented per-second Data-API ceiling allows one more
    /// call, then returns - the caller sends its actual HTTP request immediately after this
    /// returns. Never throws on a lease that could not be queued (this limiter's own generous
    /// QueueLimit already makes that rare) - callers still fire immediately rather than blocking
    /// forever, since DhanRollingOptionDataService's own SendWithRateLimitRetryAsync already
    /// retries on Dhan's own rate-limit rejection as a graceful fallback for whatever slips
    /// through.</summary>
    public async Task WaitForPermitAsync(CancellationToken cancellationToken)
    {
        using var lease = await _limiter.AcquireAsync(1, cancellationToken);
        if (!lease.IsAcquired)
            _logger.LogDebug("Dhan data-API rate limiter's queue was full - proceeding without a permit; Dhan's own rate-limit-retry fallback covers this.");
    }

    public void Dispose() => _limiter.Dispose();
}

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
///
/// Split into two INDEPENDENT lanes - interactive and background - each its own limiter, rather
/// than one shared FIFO queue for every caller. A real deployment showed exactly why a single
/// shared queue is wrong here: CdvHostedService's own periodic strike recenter/backfill loop (see
/// its own "spending the shared Dhan history rate limit" comment - already calling this out as a
/// shared, finite resource even before this class existed) can queue dozens of background calls at
/// once, especially right after startup. Under one shared limiter, a user loading OI Replay at the
/// same moment would queue FIFO behind every one of those background calls - turning a page load
/// that used to take a few seconds into one that can take tens of seconds, long enough to trip a
/// reverse-proxy timeout in front of the app and surface to the browser as a bare "Load failed"
/// rather than any error this app itself produced. Giving background callers their own smaller,
/// separate lane means an interactive request's own permits are never behind a background job's
/// queue - it only ever waits on its OWN lane's per-second ceiling.
///
/// Both lanes are still derived from the SAME configured DataApiRequestsPerSecond total (not a
/// second config knob), so their COMBINED worst-case simultaneous rate never exceeds the one
/// number Dhan actually documents - this only changes which queue a caller waits in, not how much
/// total throughput the whole app is allowed.
/// </summary>
public sealed class DhanDataApiRateLimiter : IDisposable
{
    private readonly RateLimiter _interactive;
    private readonly RateLimiter _background;
    private readonly ILogger<DhanDataApiRateLimiter> _logger;

    public DhanDataApiRateLimiter(IOptions<DhanOptions> options, ILogger<DhanDataApiRateLimiter> logger)
    {
        _logger = logger;
        var total = Math.Max(1, options.Value.DataApiRequestsPerSecond);
        // Background gets a small, fixed slice (never more than 1/5th of the total, floor 1) -
        // enough that a recenter/backfill loop still makes steady progress, never enough to starve
        // an interactive page load waiting in its own, separate queue. Interactive gets whatever is
        // left, so the two lanes' combined ceiling still equals the configured total exactly.
        var backgroundPermits = Math.Max(1, total / 5);
        var interactivePermits = Math.Max(1, total - backgroundPermits);
        _interactive = CreateLimiter(interactivePermits);
        _background = CreateLimiter(backgroundPermits);
    }

    private static RateLimiter CreateLimiter(int permitsPerSecond) => new SlidingWindowRateLimiter(new SlidingWindowRateLimiterOptions
    {
        PermitLimit = permitsPerSecond,
        Window = TimeSpan.FromSeconds(1),
        SegmentsPerWindow = permitsPerSecond,
        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
        // RateLimiter requires a finite queue - generous rather than tight, since OiReplayService's
        // own worst case (42 strike/side fetches queuing at once, on the interactive lane) comfortably
        // fits well within it.
        QueueLimit = 200,
    });

    /// <summary>Waits until Dhan's own documented per-second Data-API ceiling allows one more
    /// call on the given lane, then returns - the caller sends its actual HTTP request immediately
    /// after this returns. <paramref name="interactive"/> selects the lane: true for a call made
    /// directly on behalf of a waiting user (a page load, a "Run" click), false for a hosted
    /// background service's own prefetch/backfill/recenter work - see this class's own doc comment
    /// for why that split exists. Never throws on a lease that could not be queued (each lane's own
    /// generous QueueLimit already makes that rare) - callers still fire immediately rather than
    /// blocking forever, since DhanRollingOptionDataService's own SendWithRateLimitRetryAsync
    /// already retries on Dhan's own rate-limit rejection as a graceful fallback for whatever slips
    /// through.</summary>
    public async Task WaitForPermitAsync(bool interactive, CancellationToken cancellationToken)
    {
        var limiter = interactive ? _interactive : _background;
        using var lease = await limiter.AcquireAsync(1, cancellationToken);
        if (!lease.IsAcquired)
            _logger.LogDebug("Dhan data-API rate limiter's {Lane} queue was full - proceeding without a permit; Dhan's own rate-limit-retry fallback covers this.",
                interactive ? "interactive" : "background");
    }

    public void Dispose()
    {
        _interactive.Dispose();
        _background.Dispose();
    }
}

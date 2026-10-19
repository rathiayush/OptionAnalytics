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
/// Two lanes - interactive and background - rather
/// than one shared FIFO queue for every caller. A real deployment showed exactly why a single
/// shared queue is wrong here: CdvHostedService's own periodic strike recenter/backfill loop (see
/// its own "spending the shared Dhan history rate limit" comment - already calling this out as a
/// shared, finite resource even before this class existed) can queue dozens of background calls at
/// once, especially right after startup. Under one shared limiter, a user loading OI Replay at the
/// same moment would queue FIFO behind every one of those background calls - turning a page load
/// that used to take a few seconds into one that can take tens of seconds, long enough to trip a
/// reverse-proxy timeout in front of the app and surface to the browser as a bare "Load failed"
/// rather than any error this app itself produced. So background work never queues on the shared
/// limiter: it takes a permit only when no page load is waiting and more than one is free, and at
/// most its own lane's share (1/5th) - a page load always finds the shared limiter's own queue
/// empty of background calls, and may use the whole per-second total while the app is quiet.
///
/// Every call, either lane, takes a permit of the ONE configured DataApiRequestsPerSecond total,
/// so the combined rate never exceeds the one number Dhan actually documents.
/// </summary>
public sealed class DhanDataApiRateLimiter : IDisposable
{
    private static readonly TimeSpan BackgroundPoll = TimeSpan.FromMilliseconds(100);
    // Every call takes a permit of _total (the configured 5/s - nothing ever goes over it). A page load takes all of
    // it while the app is quiet; background work is also held to its own small lane (_background, 1/5th, floor 1) and
    // never takes the last free permit or one a page load is queued for, so a page arriving a moment later is served at once.
    private readonly RateLimiter _total;
    private readonly RateLimiter _background;
    private readonly ILogger<DhanDataApiRateLimiter> _logger;

    public DhanDataApiRateLimiter(IOptions<DhanOptions> options, ILogger<DhanDataApiRateLimiter> logger)
    {
        _logger = logger;
        var total = Math.Max(1, options.Value.DataApiRequestsPerSecond);
        _total = CreateLimiter(total);
        _background = CreateLimiter(Math.Max(1, total / 5));
    }

    private static RateLimiter CreateLimiter(int permitsPerSecond) => new SlidingWindowRateLimiter(new SlidingWindowRateLimiterOptions
    {
        PermitLimit = permitsPerSecond,
        Window = TimeSpan.FromSeconds(1),
        SegmentsPerWindow = permitsPerSecond,
        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
        // RateLimiter requires a finite queue - generous rather than tight, since OiReplayService's
        // own worst case (42 strike/side fetches queuing at once) comfortably fits well within it.
        QueueLimit = 200,
    });

    /// <summary>Waits until Dhan's documented per-second Data-API ceiling allows one more call, then returns - the
    /// caller sends its request immediately after. <paramref name="interactive"/>: true for a call made for a waiting
    /// user (a page load, a "Run" click) - it may use the whole per-second allowance; false for a hosted service's own
    /// prefetch / backfill / recenter work - at most its lane's share, and only from permits no page load is waiting
    /// for. A full queue is waited out, never sent over the limit.</summary>
    public async Task WaitForPermitAsync(bool interactive, CancellationToken cancellationToken)
    {
        if (interactive)
        {
            while (true)
            {
                using var lease = await _total.AcquireAsync(1, cancellationToken);
                if (lease.IsAcquired) return;
                _logger.LogDebug("Dhan data-API rate limiter's queue was full - waiting rather than sending over the limit.");
                await Task.Delay(BackgroundPoll, cancellationToken);
            }
        }
        while (true)
        {
            var stats = _total.GetStatistics();
            if (stats is { CurrentQueuedCount: 0, CurrentAvailablePermits: > 1 })
            {
                using var own = _background.AttemptAcquire(1);
                if (own.IsAcquired)
                {
                    using var shared = _total.AttemptAcquire(1);
                    if (shared.IsAcquired) return;
                }
            }
            await Task.Delay(BackgroundPoll, cancellationToken);
        }
    }

    public void Dispose()
    {
        _total.Dispose();
        _background.Dispose();
    }
}

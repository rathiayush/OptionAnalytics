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
/// queue. A background call may also use an interactive permit nobody is waiting for (see
/// WaitForPermitAsync) - never one an interactive call is queued for, so at worst an interactive
/// request that arrives just after waits one 1-second window.
///
/// Both lanes are still derived from the SAME configured DataApiRequestsPerSecond total (not a
/// second config knob), so their COMBINED worst-case simultaneous rate never exceeds the one
/// number Dhan actually documents - this only changes which queue a caller waits in, not how much
/// total throughput the whole app is allowed.
/// </summary>
public sealed class DhanDataApiRateLimiter : IDisposable
{
    /// <summary>Set for the length of a request that asked to be served at background priority (header
    /// "X-Request-Priority: background" - the strategy tuning job during market hours): every Dhan Data-API call made
    /// on its behalf, including the concurrent strike fetches it starts, is background work (see WaitForPermitAsync).</summary>
    private static readonly AsyncLocal<bool> BackgroundRequest = new();

    /// <summary>Whether the current request asked for background priority.</summary>
    public static bool IsBackgroundRequest => BackgroundRequest.Value;

    /// <summary>Marks the current async flow (one request) as background priority until disposed.</summary>
    public static IDisposable BackgroundScope()
    {
        var before = BackgroundRequest.Value;
        BackgroundRequest.Value = true;
        return new Restore(before);
    }

    private sealed class Restore(bool before) : IDisposable
    {
        public void Dispose() => BackgroundRequest.Value = before;
    }

    /// <summary>Whether a failed Dhan response is Dhan's rate limit - HTTP 429, DH-904 ("Too many requests on server from
    /// single user breaching rate limits") or the Data APIs' 805 ("Too many requests or connections"), per Dhan's annexure
    /// (https://dhanhq.co/docs/v2/annexure/) - worth a short wait and another try, unlike a bad parameter or no data.</summary>
    public static bool IsRateLimited(int statusCode, string? message) =>
        statusCode == 429
        || (message is { Length: > 0 } m && (m.Contains("DH-904", StringComparison.OrdinalIgnoreCase)
            || System.Text.RegularExpressions.Regex.IsMatch(m, @"(^|\D)805(\D|$)")
            || m.Contains("too many", StringComparison.OrdinalIgnoreCase)
            || (m.Contains("rate", StringComparison.OrdinalIgnoreCase) && m.Contains("limit", StringComparison.OrdinalIgnoreCase))));

    /// <summary>The wait before retry <paramref name="attempt"/> (0-based) after a rate limit: 0.5 s, 1 s, 2 s. Dhan's
    /// Data-API limit is per second (5/s), so half a second already clears most of the window and a second clears it all -
    /// a longer wait would just hold up the page (or the job) that is waiting; none at all risks the blocking Dhan's 805
    /// warns of ("Further requests may result in the user being blocked").</summary>
    public static TimeSpan RateLimitBackoff(int attempt) => TimeSpan.FromMilliseconds(500 * (1 << Math.Clamp(attempt, 0, 3)));

    /// <summary>How many times a rate-limited call is retried: a page load or the live scanner waits at most ~1.5 s in all,
    /// background work (a tuning job) a little longer - it has time, a waiting person does not.</summary>
    public static int RateLimitRetries => IsBackgroundRequest ? 3 : 2;

    // How often background work looks again for a free permit: short, so it keeps the allowed rate rather than losing a
    // slice of every second to polling, growing to MaxBackgroundPollMs while nothing is free.
    private const int BackgroundPollMs = 20;
    private const int MaxBackgroundPollMs = 100;
    private static readonly TimeSpan BackgroundPoll = TimeSpan.FromMilliseconds(BackgroundPollMs);
    private readonly RateLimiter _interactive;
    private readonly RateLimiter _background;
    private readonly ILogger<DhanDataApiRateLimiter> _logger;
    private readonly int _dailyLimit;

    public DhanDataApiRateLimiter(IOptions<DhanOptions> options, ILogger<DhanDataApiRateLimiter> logger)
    {
        _logger = logger;
        _dailyLimit = Math.Max(1, options.Value.DataApiRequestsPerDay);
        var total = Math.Max(1, options.Value.DataApiRequestsPerSecond);
        // Background gets a small, fixed slice of its own (1/5th of the total, floor 1) - enough that a recenter/backfill
        // loop always makes progress; it may also use whatever the interactive lane leaves unused (WaitForPermitAsync).
        // The two lanes' permits still add up to the configured total exactly.
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

    /// <summary>Waits until Dhan's documented per-second Data-API ceiling (5/s, account-wide - https://dhanhq.co/docs/v2/)
    /// allows one more call, then returns - the caller sends its request immediately after. <paramref name="interactive"/>
    /// picks the lane: true for a call made for a waiting user (a page load, the server scanner), false for background
    /// work (a hosted service's backfill, or any call inside a request that asked for background priority - the strategy
    /// tuning job in market hours). A background call takes a permit the interactive lane is not using at that moment -
    /// never the last free one and never one an interactive call is already queued for (oldest-first order refuses a
    /// non-waiting acquire while anyone waits) - else one of its own lane; so a long job runs at up to 4/s while the live
    /// app is quiet and at its 1/s share while it is busy, and a page load always finds a permit free. A full queue is waited out,
    /// never sent over the limit: Dhan's 805 warns that further requests may get the user blocked.</summary>
    public async Task WaitForPermitAsync(bool interactive, CancellationToken cancellationToken)
    {
        var lane = interactive && !BackgroundRequest.Value;
        if (!lane)
        {
            // Backs off a little while nothing is free, so a job's many waiting calls do not spin: a permit comes free
            // every fifth of a second at most, which a 20 - 100 ms look still catches at once.
            var waitMs = BackgroundPollMs;
            while (true)
            {
                // A spare interactive permit. While the live app is in use, never the LAST one: it is left free so a page
                // load arriving a moment later is served at once rather than waiting out the window. Once nothing
                // interactive has asked for a while (a night, a weekend - when a long tuning job runs), that reservation
                // is pointless and background work uses the whole 5/s Dhan allows.
                var keepOneFree = !InteractiveIdle;
                if (_interactive.GetStatistics()?.CurrentAvailablePermits > (keepOneFree ? 1 : 0))
                    using (var spare = _interactive.AttemptAcquire(1)) if (spare.IsAcquired) { Count(background: true); return; }
                using (var own = _background.AttemptAcquire(1)) if (own.IsAcquired) { Count(background: true); return; }
                await Task.Delay(waitMs, cancellationToken);
                waitMs = Math.Min(MaxBackgroundPollMs, waitMs + BackgroundPollMs);
            }
        }
        Volatile.Write(ref _lastInteractiveTicks, Environment.TickCount64);
        while (true)
        {
            using var lease = await _interactive.AcquireAsync(1, cancellationToken);
            if (lease.IsAcquired) { Count(background: false); return; }
            _logger.LogDebug("Dhan data-API rate limiter's interactive queue was full - waiting rather than sending over the limit.");
            await Task.Delay(BackgroundPoll, cancellationToken);
        }
    }

    /// <summary>How long after the last interactive call background work still leaves a permit free for the live app.</summary>
    private static readonly long InteractiveQuietMs = 5_000;
    private long _lastInteractiveTicks = long.MinValue / 2;

    /// <summary>Whether nothing interactive has asked for a Dhan call recently (so a long job may use the full rate).</summary>
    public bool InteractiveIdle => Environment.TickCount64 - Volatile.Read(ref _lastInteractiveTicks) > InteractiveQuietMs;

    // Dhan's documented daily Data-API limit (100,000/day), counted per IST day in this process (a restart starts the count
    // again; another process on the same account is not seen). Shown on the Strategy tuning page; a tuning job stops
    // scanning before it would take the last of the day's allowance (tune.mjs).
    private readonly object _countLock = new();
    private DateOnly _countDay;
    private long _countToday;
    // Of those, the ones made for BACKGROUND work - a hosted service's backfill, or any call inside a request that
    // asked for background priority, which the strategy tuning job's every request does (tuneFetch.mjs always sends
    // X-Request-Priority: background). Counted so a long job can say how many Dhan calls IT caused - the plain total
    // is account-wide and moves with whatever the live app is doing at the same time.
    private long _backgroundToday;

    private static DateOnly IstToday() => DateOnly.FromDateTime(DateTime.UtcNow.AddMinutes(330));

    private void Count(bool background)
    {
        var today = IstToday();
        lock (_countLock)
        {
            if (today != _countDay) { _countDay = today; _countToday = 0; _backgroundToday = 0; }
            _countToday++;
            if (background) _backgroundToday++;
        }
    }

    /// <summary>Dhan Data-API calls made today (IST) by this server, how many of those were background calls (see
    /// _backgroundToday), and the documented daily limit.</summary>
    public (DateOnly Day, long Calls, long BackgroundCalls, int DailyLimit) Usage()
    {
        var today = IstToday();
        lock (_countLock) return (today, _countDay == today ? _countToday : 0, _countDay == today ? _backgroundToday : 0, _dailyLimit);
    }

    public void Dispose()
    {
        _interactive.Dispose();
        _background.Dispose();
    }
}

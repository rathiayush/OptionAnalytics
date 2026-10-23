using Microsoft.Extensions.Options;

namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// Enforces Dhan API v2's own documented "Data APIs" rate limit - 5 requests/second, 100,000/day,
/// confirmed ACCOUNT-WIDE rather than per-endpoint (Dhan's official v2 docs, cross-confirmed by
/// its support article on API rate limits, and independently corroborated by
/// DhanRollingOptionDataService's own pre-existing doc comment stating the same fact) - shared
/// across every Data-API-category caller in this process: DhanHistoricalDataService's
/// /charts/intraday, DhanRollingOptionDataService's /charts/rollingoption, DhanOptionChainQuotes'
/// /optionchain, and DhanApiClient's own retry of a data call after a stale token
/// (DhanDataApiSharedLimitTests). Registered as a
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
/// Calls are evenly spaced (see the class body), not counted in a sliding window: a window lets a
/// burst through that Dhan, counting on arrival, can see as more than its limit. The spacing is kept
/// between the calls as they actually GO (DispatchAsync), not only between their booked slots. Dhan's Option Chain
/// API (DhanOptionChainQuotes) also takes a slot here, on top of its own one-call-per-3-seconds rule.
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
    /// <summary>After Dhan answers "too many requests" (DH-904 / 805 / 429), every Data-API call waits this long
    /// before the next one goes - so the calls already queued do not keep hitting the limit, one after another.</summary>
    internal static readonly TimeSpan RateLimitPause = TimeSpan.FromSeconds(1.5);

    // Calls go out EVENLY SPACED, one slot every _spacing (a 10% margin over 1 s / the configured per-second limit -
    // 220 ms for 5/s), never in a burst: Dhan counts calls as they ARRIVE, and a burst allowed by a windowed counter
    // (5 at once, then 5 more as the window slides) reaches Dhan as 6+ within its second whenever the network bunches
    // them. A page load (interactive) takes the next slot; background work takes one only while no page load is
    // waiting, and at most its own 1/5th share.
    private readonly TimeSpan _spacing;
    private readonly TimeSpan _backgroundSpacing;
    private readonly object _lock = new();
    private DateTimeOffset _nextSlot = DateTimeOffset.MinValue;
    private DateTimeOffset _nextBackgroundSlot = DateTimeOffset.MinValue;
    // When the last call actually went, and until when Dhan's "too many requests" holds every call back (Dispatch).
    private DateTimeOffset _lastSent = DateTimeOffset.MinValue;
    private DateTimeOffset _pausedUntil = DateTimeOffset.MinValue;
    private int _interactiveWaiting;
    private readonly ILogger<DhanDataApiRateLimiter> _logger;
    private readonly Func<DateTimeOffset> _clock;

    public DhanDataApiRateLimiter(IOptions<DhanOptions> options, ILogger<DhanDataApiRateLimiter> logger)
        : this(options, logger, () => DateTimeOffset.UtcNow) { }

    internal DhanDataApiRateLimiter(IOptions<DhanOptions> options, ILogger<DhanDataApiRateLimiter> logger, Func<DateTimeOffset> clock)
    {
        _logger = logger;
        _clock = clock;
        var perSecond = Math.Max(1, options.Value.DataApiRequestsPerSecond);
        _spacing = TimeSpan.FromMilliseconds(1100.0 / perSecond);
        _backgroundSpacing = TimeSpan.FromMilliseconds(1100.0 / Math.Max(1, perSecond / 5));
    }

    /// <summary>Waits for this call's slot, then returns - the caller sends its request immediately after.
    /// <paramref name="interactive"/>: true for a call made for a waiting user (a page load, a "Run" click, the live
    /// scanner); false for a hosted service's own prefetch / backfill / recenter work.</summary>
    public async Task WaitForPermitAsync(bool interactive, CancellationToken cancellationToken)
    {
        if (interactive)
        {
            Interlocked.Increment(ref _interactiveWaiting);
            try
            {
                await Task.Delay(Reserve(background: false), cancellationToken);
                await DispatchAsync(cancellationToken);
            }
            finally { Interlocked.Decrement(ref _interactiveWaiting); }
            return;
        }
        while (true)
        {
            TimeSpan? wait = null;
            lock (_lock)
            {
                var now = _clock();
                if (Volatile.Read(ref _interactiveWaiting) == 0 && now >= _nextBackgroundSlot && _nextSlot <= now + _spacing)
                    wait = Reserve(background: true);
            }
            if (wait is { } w)
            {
                await Task.Delay(w, cancellationToken);
                await DispatchAsync(cancellationToken);
                return;
            }
            await Task.Delay(BackgroundPoll, cancellationToken);
        }
    }

    /// <summary>For the tests: how many calls have been let go.</summary>
    internal int PermitsGiven { get; private set; }

    // The booked slot says when a call MAY go; this is when it DOES: never sooner than one spacing after the call before
    // it actually went, nor inside a "too many requests" pause. A timer that fires late (a busy server) would otherwise
    // let the calls booked after it go right behind it - 6 reaching Dhan within a second, though every slot was 220 ms
    // apart (DhanDataApiSharedLimitTests, run under the whole suite's load).
    private async Task DispatchAsync(CancellationToken cancellationToken)
    {
        while (true)
        {
            TimeSpan wait;
            lock (_lock)
            {
                var now = _clock();
                var earliest = _lastSent + _spacing;
                if (_pausedUntil > earliest) earliest = _pausedUntil;
                if (now >= earliest)
                {
                    _lastSent = now;
                    if (_nextSlot < now + _spacing) _nextSlot = now + _spacing;
                    PermitsGiven++;
                    return;
                }
                wait = earliest - now;
            }
            await Task.Delay(wait, cancellationToken);
        }
    }

    internal TimeSpan Reserve(bool background)
    {
        lock (_lock)
        {
            var now = _clock();
            var slot = _nextSlot > now ? _nextSlot : now;
            _nextSlot = slot + _spacing;
            if (background) _nextBackgroundSlot = slot + _backgroundSpacing;
            return slot - now;
        }
    }

    /// <summary>Dhan said "too many requests": hold every following call back for <see cref="RateLimitPause"/>.</summary>
    public void NoteRateLimited()
    {
        lock (_lock)
        {
            var resume = _clock() + RateLimitPause;
            if (_nextSlot < resume) _nextSlot = resume;
            if (_pausedUntil < resume) _pausedUntil = resume;
        }
        OptionAnalytics.Server.Services.LoadProgress.Warn($"⏸ Dhan said too many requests - every Dhan call pauses {RateLimitPause.TotalSeconds:0.0} s");
        _logger.LogWarning("Dhan answered \"too many requests\" - pausing every Data-API call for {Seconds} s.", RateLimitPause.TotalSeconds);
    }

    /// <summary>Whether a failed Dhan response is its rate limit - HTTP 429, DH-904 ("Too many requests on server from
    /// single user breaching rate limits") or 805 ("Too many requests or connections"), per Dhan's annexure - worth a
    /// short wait and another try, unlike a bad parameter or no data.</summary>
    public static bool IsRateLimited(System.Net.HttpStatusCode statusCode, string? message) =>
        (int)statusCode == 429
        || (message is { Length: > 0 } m && (m.Contains("DH-904", StringComparison.OrdinalIgnoreCase)
            || System.Text.RegularExpressions.Regex.IsMatch(m, @"(^|\D)805(\D|$)")
            || m.Contains("too many", StringComparison.OrdinalIgnoreCase)
            || (m.Contains("rate", StringComparison.OrdinalIgnoreCase) && m.Contains("limit", StringComparison.OrdinalIgnoreCase))));

    public void Dispose() { }
}

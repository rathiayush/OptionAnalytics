namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// Keeps DhanSession authenticated with zero human involvement, whenever TOTP credentials are
/// configured (DhanOptions.HasTotpCredentials) - takes priority over a plain static AccessToken,
/// since a self-renewing token never goes stale the way a once-a-day paste does. If TOTP isn't
/// configured, this service is a no-op and the session just runs on whatever static AccessToken
/// is set (or none, until one is pasted into config).
///
/// Trimmed from LiveSpreadCalculator's DhanTotpAutoRenewalHostedService - this app has no
/// dashboard to push an "auth restored" notification to, so that step is dropped; the renewal
/// schedule and reactive-invalidation behaviour are otherwise identical:
///
///  1. STARTUP - authenticated within seconds of boot, retried with backoff (2s doubling to 30s)
///     until it succeeds.
///  2. PROACTIVELY, an hour before the current token's own expiry.
///  3. REACTIVELY, the instant DhanSession.SessionInvalidated fires (a 401 from the REST API, or
///     a session-invalid disconnect code from the WS feed - see DhanApiClient and
///     DhanMarketFeedClient).
/// </summary>
public sealed class DhanTotpAutoRenewalHostedService : BackgroundService
{
    private static readonly TimeSpan RetryBackoffInitial = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan RetryBackoffMax = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan RenewalMargin = TimeSpan.FromHours(1);

    private readonly DhanOptions _options;
    private readonly DhanSession _session;
    private readonly DhanTotpAuthService _authService;
    private readonly ILogger<DhanTotpAutoRenewalHostedService> _logger;

    private readonly SemaphoreSlim _invalidatedSignal = new(0, 1);
    private int _invalidatedPending;

    public DhanTotpAutoRenewalHostedService(
        Microsoft.Extensions.Options.IOptions<DhanOptions> options,
        DhanSession session,
        DhanTotpAuthService authService,
        ILogger<DhanTotpAutoRenewalHostedService> logger)
    {
        _options = options.Value;
        _session = session;
        _authService = authService;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.HasTotpCredentials)
        {
            _logger.LogInformation("Dhan TOTP auto-login is not configured (Dhan:Pin / Dhan:TotpSecret missing) - using Dhan:AccessToken if set.");
            return;
        }

        _session.SessionInvalidated += OnInvalidated;
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                var expiresUtc = await RenewUntilSuccessAsync(stoppingToken);
                if (expiresUtc is null) return; // cancelled while retrying - shutting down

                await WaitForInvalidationOrDeadlineAsync(expiresUtc.Value - RenewalMargin, stoppingToken);
            }
        }
        finally
        {
            _session.SessionInvalidated -= OnInvalidated;
        }
    }

    private async Task<DateTimeOffset?> RenewUntilSuccessAsync(CancellationToken stoppingToken)
    {
        var backoff = RetryBackoffInitial;
        while (!stoppingToken.IsCancellationRequested)
        {
            var result = await _authService.GenerateAccessTokenAsync(stoppingToken);
            if (result.Success)
            {
                _logger.LogInformation("Dhan TOTP auto-login succeeded; token valid until {ExpiresUtc:u}.", result.ExpiresUtc);
                return result.ExpiresUtc ?? DateTimeOffset.UtcNow.AddHours(23);
            }

            _logger.LogWarning("Dhan TOTP auto-login failed: {Error} - retrying in {Seconds}s.", result.Error, backoff.TotalSeconds);

            if (!await DelayAsync(backoff, stoppingToken)) return null;
            backoff = Min(backoff * 2, RetryBackoffMax);
        }

        return null;
    }

    private async Task WaitForInvalidationOrDeadlineAsync(DateTimeOffset deadlineUtc, CancellationToken stoppingToken)
    {
        var delay = deadlineUtc - DateTimeOffset.UtcNow;
        if (delay <= TimeSpan.Zero)
        {
            Interlocked.Exchange(ref _invalidatedPending, 0);
            await DelayAsync(RetryBackoffInitial, stoppingToken);
            return;
        }

        using var deadlineCts = new CancellationTokenSource(delay);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken, deadlineCts.Token);
        try
        {
            await _invalidatedSignal.WaitAsync(linked.Token);
            Interlocked.Exchange(ref _invalidatedPending, 0);
        }
        catch (OperationCanceledException)
        {
            // Either the proactive deadline arrived or the service is stopping.
        }
    }

    private void OnInvalidated()
    {
        if (Interlocked.CompareExchange(ref _invalidatedPending, 1, 0) == 0)
        {
            try { _invalidatedSignal.Release(); }
            catch (SemaphoreFullException) { /* already armed - coalesced */ }
        }
    }

    private static TimeSpan Min(TimeSpan a, TimeSpan b) => a < b ? a : b;

    private static async Task<bool> DelayAsync(TimeSpan delay, CancellationToken cancellationToken)
    {
        try { await Task.Delay(delay, cancellationToken); return true; }
        catch (OperationCanceledException) { return false; }
    }
}

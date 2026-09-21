using Microsoft.Extensions.Options;

namespace NiftyDataCollector.Dhan;

/// <summary>
/// Keeps DhanSession authenticated with zero human involvement, whenever TOTP credentials are
/// configured (DhanOptions.HasTotpCredentials). PRIORITY ORDER, per explicit request: a configured
/// Dhan:AccessToken is used FIRST and is left alone as long as it keeps working - this service only
/// takes over with TOTP once that static token is either not configured at all, or is confirmed
/// dead (DhanSession.SessionInvalidated fires - a 401 from DhanApiClient). If TOTP isn't configured
/// either, this service is a no-op and the session just runs on whatever static AccessToken is set
/// (with no automatic recovery if that ever stops working).
///
/// Once TOTP has taken over (no static token, or the static one died), it stays authenticated by:
///  1. STARTUP OF TOTP MODE - authenticated within seconds, retried with backoff (2s doubling to
///     30s for an ordinary transient failure) until it succeeds - ~130s specifically when Dhan
///     reports its own "once every 2 minutes" cooldown, or DhanOptions.TooManyAttemptsCooldownSeconds
///     (configurable, defaults to 30s) on Dhan's separate account-level "too many attempts"
///     lockout - see that option's own doc comment for the tradeoff it controls.
///  2. PROACTIVELY, an hour before the current TOTP-minted token's own expiry.
///  3. REACTIVELY, the instant DhanSession.SessionInvalidated fires again.
///
/// There is deliberately no reverse fallback: once the static token is confirmed dead, this
/// service never goes back to trying it again (there'd be nothing to retry - it's a fixed value
/// that only a human editing config can fix), so from that point on it behaves exactly as it would
/// if only TOTP had ever been configured.
///
/// See DhanOptions' own doc comment for the real risk of running this ALONGSIDE
/// OptionAnalytics.Server's own TOTP renewal against the same Dhan account.
/// </summary>
public sealed class DhanTotpAutoRenewalHostedService : BackgroundService
{
    private static readonly TimeSpan RetryBackoffInitial = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan RetryBackoffMax = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan RenewalMargin = TimeSpan.FromHours(1);

    /// <summary>Dhan's own generateAccessToken endpoint refuses a repeat call for 2 minutes after
    /// the last one (regardless of whether it succeeded). Plain exponential backoff caps at 30s,
    /// too short to ever clear that cooldown - a little margin over Dhan's stated 2 minutes
    /// accounts for clock/latency slop.</summary>
    private static readonly TimeSpan RateLimitCooldown = TimeSpan.FromSeconds(130);

    private readonly DhanOptions _options;
    private readonly DhanSession _session;
    private readonly DhanTotpAuthService _authService;
    private readonly ILogger<DhanTotpAutoRenewalHostedService> _logger;

    private readonly SemaphoreSlim _invalidatedSignal = new(0, 1);
    private int _invalidatedPending;

    public DhanTotpAutoRenewalHostedService(
        IOptions<DhanOptions> options, DhanSession session, DhanTotpAuthService authService, ILogger<DhanTotpAutoRenewalHostedService> logger)
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

        // Static token is primary: if it's configured and DhanSession has already seeded a valid
        // session from it (see DhanSession's own constructor), stand by rather than immediately
        // trying to log in via TOTP - only take over once that token is confirmed dead.
        var usingStaticToken = !string.IsNullOrWhiteSpace(_options.AccessToken) && _session.IsAuthenticated;
        if (usingStaticToken)
            _logger.LogInformation(
                "Dhan:AccessToken is configured and currently valid - using it as the session's primary auth for now. " +
                "TOTP auto-login is on standby and takes over automatically the moment that token is cleared (expired/rejected).");

        _session.SessionInvalidated += OnInvalidated;
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                if (usingStaticToken)
                {
                    await WaitForInvalidationAsync(stoppingToken);
                    if (stoppingToken.IsCancellationRequested) return;

                    usingStaticToken = false;
                    _logger.LogWarning("Dhan:AccessToken was cleared (expired/rejected) - TOTP auto-login is now taking over as the session's primary auth method.");
                    continue;
                }

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

            var delay = result.RateLimited ? RateLimitCooldown
                : result.TooManyAttempts ? TimeSpan.FromSeconds(_options.TooManyAttemptsCooldownSeconds)
                : backoff;

            if (result.TooManyAttempts)
                _logger.LogError(
                    "Dhan TOTP login is being rejected as 'too many attempts' ({Error}). Check your clock against real UTC time (a common cause), but this can also be a genuine account-level lockout that simply needs time to clear - waiting {Seconds}s before retrying, rather than hammering it, since repeated attempts against an active lockout risk extending it.",
                    result.Error, delay.TotalSeconds);
            else
                _logger.LogWarning("Dhan TOTP auto-login failed: {Error} - retrying in {Seconds}s.", result.Error, delay.TotalSeconds);

            if (!await DelayAsync(delay, stoppingToken)) return null;
            backoff = result.RateLimited || result.TooManyAttempts ? RetryBackoffInitial : Min(backoff * 2, RetryBackoffMax);
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

    /// <summary>Blocks until DhanSession.SessionInvalidated fires (or the service is stopping) -
    /// no deadline, unlike WaitForInvalidationOrDeadlineAsync, because there's no TOTP-minted
    /// token expiry to race against while the static AccessToken is still the one in use.</summary>
    private async Task WaitForInvalidationAsync(CancellationToken stoppingToken)
    {
        try
        {
            await _invalidatedSignal.WaitAsync(stoppingToken);
            Interlocked.Exchange(ref _invalidatedPending, 0);
        }
        catch (OperationCanceledException)
        {
            // The service is stopping.
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

using Microsoft.Extensions.Options;

namespace NiftyDataCollector.Dhan;

/// <summary>
/// Keeps DhanSession authenticated with zero human involvement, whenever TOTP credentials are
/// configured (DhanOptions.HasTotpCredentials) - takes priority over a plain static AccessToken.
/// If TOTP isn't configured, this service is a no-op and the session just runs on whatever static
/// AccessToken is set. Ported verbatim from OptionAnalytics.Server's own
/// DhanTotpAutoRenewalHostedService (identical schedule and backoff, already validated in
/// production there):
///
///  1. STARTUP - authenticated within seconds of boot, retried with backoff (2s doubling to 30s,
///     including on Dhan's own account-level "too many attempts" lockout) until it succeeds - or
///     ~130s specifically when Dhan reports its own "once every 2 minutes" cooldown.
///  2. PROACTIVELY, an hour before the current token's own expiry.
///  3. REACTIVELY, the instant DhanSession.SessionInvalidated fires (a 401 from DhanApiClient).
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

            var delay = result.RateLimited ? RateLimitCooldown : backoff;

            if (result.TooManyAttempts)
                _logger.LogError(
                    "Dhan TOTP login is being rejected as 'too many attempts' ({Error}). This almost always means this machine's clock is out of sync with real time - TOTP codes are only valid for a ~30-second window. Check your clock against real UTC time - retrying in {Seconds}s regardless; if the clock is genuinely skewed this will keep re-triggering the same lockout until it's fixed.",
                    result.Error, delay.TotalSeconds);
            else
                _logger.LogWarning("Dhan TOTP auto-login failed: {Error} - retrying in {Seconds}s.", result.Error, delay.TotalSeconds);

            if (!await DelayAsync(delay, stoppingToken)) return null;
            backoff = result.RateLimited ? RetryBackoffInitial : Min(backoff * 2, RetryBackoffMax);
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

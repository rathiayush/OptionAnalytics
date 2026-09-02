using Microsoft.Extensions.Options;

namespace OptionAnalytics.Server.Dhan;

/// <summary>The outcome of one TOTP login attempt - what DiagnosticsController reports so an
/// unauthenticated deployment can be diagnosed without reaching its container logs. Carries only
/// the OUTCOME, never any credential.</summary>
public sealed record DhanAuthAttempt(
    DateTimeOffset AtUtc,
    bool Success,
    string? Error,
    bool RateLimited,
    int ConsecutiveFailures);

/// <summary>
/// In-memory holder for the live Dhan access token, seeded from DhanOptions.AccessToken at
/// construction (static-token mode). When TOTP auto-login is configured
/// (DhanOptions.HasTotpCredentials), DhanTotpAutoRenewalHostedService overwrites both fields with
/// a freshly minted token instead - every Dhan call site (DhanApiClient, DhanMarketFeedClient)
/// reads AccessToken fresh on each attempt, so a renewal takes effect immediately with no further
/// plumbing.
/// </summary>
public sealed class DhanSession
{
    public DhanSession(IOptions<DhanOptions> options)
    {
        var o = options.Value;
        AccessToken = string.IsNullOrWhiteSpace(o.AccessToken) ? null : o.AccessToken;
        ClientId = string.IsNullOrWhiteSpace(o.ClientId) ? null : o.ClientId;
    }

    public string? AccessToken { get; set; }
    public string? ClientId { get; set; }

    public bool IsAuthenticated => !string.IsNullOrEmpty(AccessToken) && !string.IsNullOrEmpty(ClientId);

    /// <summary>The outcome of the most recent TOTP login attempt, recorded by DhanTotpAuthService
    /// on every path (success, credential rejection, rate limit, malformed secret, network error).
    /// Exists so DiagnosticsController can answer "why is this not authenticated?" over the REST
    /// API - when this app runs somewhere its container logs aren't readily reachable, the only
    /// alternative is guessing. Never holds a secret, only the outcome.</summary>
    public DhanAuthAttempt? LastAuthAttempt { get; private set; }

    /// <summary>Records one login attempt's outcome, keeping a running count of consecutive
    /// failures so the diagnostic can distinguish "one transient blip" from "failing forever".</summary>
    public void RecordAuthAttempt(bool success, string? error, bool rateLimited)
    {
        var previousFailures = LastAuthAttempt?.ConsecutiveFailures ?? 0;
        LastAuthAttempt = new DhanAuthAttempt(
            DateTimeOffset.UtcNow, success, error, rateLimited,
            success ? 0 : previousFailures + 1);
    }

    /// <summary>Raised by <see cref="ClearAccessToken"/> - lets DhanTotpAutoRenewalHostedService
    /// react to a dead session immediately (a 401 from the REST API, or a session-invalid
    /// disconnect code on the WS feed - see DhanSymbology.IsSessionInvalidCode) instead of waiting
    /// for its next scheduled proactive renewal.</summary>
    public event Action? SessionInvalidated;

    public void ClearAccessToken()
    {
        AccessToken = null;
        SessionInvalidated?.Invoke();
    }
}

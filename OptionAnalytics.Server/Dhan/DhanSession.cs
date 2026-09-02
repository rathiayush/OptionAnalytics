using Microsoft.Extensions.Options;

namespace OptionAnalytics.Server.Dhan;

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

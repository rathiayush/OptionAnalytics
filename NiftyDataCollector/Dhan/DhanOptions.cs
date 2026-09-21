namespace NiftyDataCollector.Dhan;

/// <summary>
/// Dhan credentials for this collector. Two ways to authenticate, same as OptionAnalytics.Server -
/// and, per explicit request, PRIORITY ORDER matters here:
///
///  1. STATIC TOKEN (primary, when set) - paste a portal-generated AccessToken (Dhan Web -> Profile
///     -> DhanHQ Trading APIs). Used as-is for as long as it keeps working; needs a fresh paste
///     roughly once a day (portal tokens are fixed at 24h validity) if you're relying on it alone.
///  2. TOTP (fallback) - set ClientId + Pin + TotpSecret alongside it (or instead of it, leaving
///     AccessToken empty). DhanTotpAutoRenewalHostedService stands by and only starts minting/
///     renewing its own token once AccessToken is either not configured at all, or is confirmed
///     dead (rejected by Dhan) - see that service's own doc comment for exactly how the handover
///     works. Once TOTP has taken over, it stays authenticated automatically forever, same RFC
///     6238 algorithm as an authenticator app (see TotpGenerator).
///
/// THE REAL RISK, explicit per prior discussion: if OptionAnalytics.Server's own dashboard is ALSO
/// running in TOTP mode against this SAME Dhan account, the two processes' independent logins can
/// invalidate each other's currently active token - a fresh login commonly does that for the same
/// account. Running both in TOTP mode at once is a deliberate tradeoff you've chosen to accept, not
/// something this collector can make safe on its own; the static-token option above remains the
/// zero-risk choice if that ever becomes a problem in practice.
/// </summary>
public sealed class DhanOptions
{
    public const string SectionName = "Dhan";

    public string ClientId { get; set; } = "";
    public string AccessToken { get; set; } = "";

    /// <summary>Your Dhan account PIN - required for TOTP auto-login alongside TotpSecret. SECRET
    /// in the same sense as a password: together with TotpSecret it lets whoever holds both mint a
    /// fresh valid token at will, indefinitely. Never commit real values.</summary>
    public string? Pin { get; set; }

    /// <summary>The base32 TOTP seed from Dhan Web -> Profile -> DhanHQ Trading APIs -> Setup
    /// TOTP (the same string/QR an authenticator app would use).</summary>
    public string? TotpSecret { get; set; }

    public string RestBaseUrl { get; set; } = "https://api.dhan.co/v2";

    /// <summary>Host for Dhan's auth endpoints (generateAccessToken) - a different host from the
    /// trading API.</summary>
    public string AuthBaseUrl { get; set; } = "https://auth.dhan.co";

    /// <summary>True when everything TOTP auto-login needs is configured - takes priority over a
    /// plain static AccessToken (see DhanTotpAutoRenewalHostedService's doc comment).</summary>
    public bool HasTotpCredentials =>
        !string.IsNullOrWhiteSpace(ClientId) && !string.IsNullOrWhiteSpace(Pin) && !string.IsNullOrWhiteSpace(TotpSecret);

    /// <summary>How long DhanTotpAutoRenewalHostedService waits before retrying after Dhan's own
    /// account-level "Too many attempts. Please try again after sometime." lockout - a DIFFERENT,
    /// undocumented cooldown from the well-known 2-minute one for the plain "once every 2 minutes"
    /// throttle (that one is not configurable, since Dhan's own stated value for it is fixed and
    /// known). Defaults to 30s, matching the fast retry OptionAnalytics.Server's own original
    /// tuning uses for this case - configurable here because that fast setting trades recovery
    /// speed once a transient cause (clock skew, most commonly) clears against the risk of
    /// repeated attempts reading as continued abuse if the lockout is instead a genuine
    /// account-level one with its own longer, unknown reset window. Raise this if you hit that
    /// lockout for real and want fewer, more patient retries instead.</summary>
    public int TooManyAttemptsCooldownSeconds { get; set; } = 30;

    /// <summary>Minimum gap enforced between LITERALLY EVERY Dhan REST call this process makes,
    /// regardless of which endpoint - on top of DhanRateLimiter's own per-endpoint spacing, not
    /// instead of it. Exists because Dhan's own rate limit turned out to be PER ACCOUNT, not per
    /// endpoint ("Rate_Limit: Too many requests on server from single user breaching rate
    /// limits.", hit in practice running CollectorHostedService's option-bars backfill and
    /// RollingOptionBackfillHostedService at the same time) - two per-endpoint gates that are each
    /// individually within their own budget can still burst past Dhan's real limit when they run
    /// concurrently, since Dhan is counting the SAME account's calls across both. HistoricalData
    /// (200ms) and RollingOption (250ms) running at once can combine to ~9 req/s, which is what
    /// actually triggered the real Rate_Limit rejection above - this defaults to 300ms (~3.3 req/s
    /// combined ceiling across EVERYTHING) to comfortably undercut that. Raise this further if you
    /// still see Rate_Limit errors with multiple backfills running together, or lower it once
    /// you've confirmed Dhan tolerates faster for your account.</summary>
    public int GlobalCallSpacingMilliseconds { get; set; } = 300;
}

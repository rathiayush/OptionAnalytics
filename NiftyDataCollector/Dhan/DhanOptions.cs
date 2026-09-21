namespace NiftyDataCollector.Dhan;

/// <summary>
/// Dhan credentials for this collector. Two ways to authenticate, same as OptionAnalytics.Server:
///
///  1. STATIC TOKEN - paste a portal-generated AccessToken (Dhan Web -> Profile -> DhanHQ Trading
///     APIs). Needs a fresh paste roughly once a day (portal tokens are fixed at 24h validity).
///  2. TOTP - set ClientId + Pin + TotpSecret and leave AccessToken empty.
///     DhanTotpAutoRenewalHostedService then mints and renews its own token with zero manual
///     steps, same RFC 6238 algorithm as an authenticator app (see TotpGenerator). Takes priority
///     over a stale static AccessToken whenever HasTotpCredentials is true.
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
}

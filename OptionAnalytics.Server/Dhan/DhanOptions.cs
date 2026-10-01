namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// Everything needed to talk to DhanHQ API v2. Bound from the "Dhan" section of appsettings.json
/// (or the equivalent Dhan__* environment variables) - deliberately the same section name and
/// field names as the LiveSpreadCalculator app's DhanOptions, so an already-working credential set
/// can be copied across unchanged.
///
/// Two ways to authenticate, since this app has no login UI to drive Dhan's browser-based Consent
/// flow:
///
///  1. STATIC TOKEN - paste a portal-generated AccessToken (Dhan Web -> Profile -> DhanHQ Trading
///     APIs). Simplest, but needs a fresh paste roughly once a day (portal tokens are fixed at
///     24h validity).
///  2. TOTP - set ClientId + Pin + TotpSecret and leave AccessToken empty.
///     DhanTotpAutoRenewalHostedService then mints and renews its own token with zero manual
///     steps (see that class), the same algorithm an authenticator app uses (RFC 6238 - see
///     TotpGenerator). Used automatically whenever HasTotpCredentials is true, which takes
///     priority over a stale static AccessToken.
/// </summary>
public sealed class DhanOptions
{
    public const string SectionName = "Dhan";

    /// <summary>The Dhan account id (a numeric string). Sent as the client-id header on every
    /// REST call and as the clientId query parameter on the market-feed WebSocket.</summary>
    public string ClientId { get; set; } = "";

    /// <summary>A pre-generated access token from the Dhan web portal (Profile -> DhanHQ Trading
    /// APIs). Portal tokens are currently fixed at 24-hour validity, so this needs refreshing
    /// roughly once a day - or leave it empty and set Pin/TotpSecret instead for fully automatic
    /// login. Overwritten in memory once TOTP auto-login succeeds.</summary>
    public string AccessToken { get; set; } = "";

    /// <summary>Your Dhan account PIN - required for TOTP auto-login alongside TotpSecret.
    /// SECRET in the same sense as a password, not a rotating token: together with TotpSecret it
    /// lets whoever holds both mint a fresh valid token at will, indefinitely. Never commit real
    /// values (see appsettings.Local.json, which is gitignored).</summary>
    public string? Pin { get; set; }

    /// <summary>The base32 TOTP seed from Dhan Web -> Profile -> DhanHQ Trading APIs -> Setup
    /// TOTP (the same string/QR an authenticator app would use). See Pin's doc comment for the
    /// same secret-handling caveat.</summary>
    public string? TotpSecret { get; set; }

    public string RestBaseUrl { get; set; } = "https://api.dhan.co/v2";

    /// <summary>Host for Dhan's auth endpoints (generateAccessToken) - a different host from the
    /// trading API.</summary>
    public string AuthBaseUrl { get; set; } = "https://auth.dhan.co";

    /// <summary>Live market data feed. Authenticates via query string
    /// (?version=2&amp;token=...&amp;clientId=...&amp;authType=2).</summary>
    public string WsUrl { get; set; } = "wss://api-feed.dhan.co";

    /// <summary>Dhan's order-update socket - a message per order state change on the account (see
    /// DhanOrderUpdateFeed). Live trading refreshes positions off it instead of polling.</summary>
    public string OrderUpdateWsUrl { get; set; } = "wss://api-order-update.dhan.co";

    /// <summary>The compact instrument dump - the only one of Dhan's two scrip master files with
    /// a per-contract trading symbol column.</summary>
    public string ScripMasterUrl { get; set; } = "https://images.dhan.co/api-data/api-scrip-master.csv";

    /// <summary>Ceiling on outbound Dhan "Data API" calls (the /charts/intraday and
    /// /charts/rollingoption endpoints - historical/rolling-option candles) per second, shared
    /// across every caller in the whole process via DhanDataApiRateLimiter - see that class's own
    /// doc comment for why this has to be a single app-wide gate rather than a per-caller one.
    /// Defaults to Dhan API v2's own documented Data API limit (5 requests/second, account-wide -
    /// confirmed both via Dhan's official v2 docs and its support article on API rate limits, and
    /// independently corroborated by DhanRollingOptionDataService's own pre-existing doc comment
    /// that Dhan's limit is "account-wide, not per-endpoint"). Only meant to be dialed DOWN from
    /// here (more conservative than Dhan's own stated limit), never raised past what Dhan actually
    /// allows - Order APIs (10/sec) and Quote APIs (1/sec, already handled separately by
    /// DhanOptionChainQuotes' own MinimumCallSpacing) are different categories with different
    /// limits and are not affected by this setting at all.</summary>
    public int DataApiRequestsPerSecond { get; set; } = 5;

    public bool HasSession => !string.IsNullOrWhiteSpace(ClientId) && !string.IsNullOrWhiteSpace(AccessToken);

    /// <summary>True when everything TOTP auto-login needs is configured. Checked before
    /// DhanTotpAutoRenewalHostedService does anything, and takes priority over a plain static
    /// AccessToken (see DhanTotpAutoRenewalHostedService's doc comment).</summary>
    public bool HasTotpCredentials =>
        !string.IsNullOrWhiteSpace(ClientId) && !string.IsNullOrWhiteSpace(Pin) && !string.IsNullOrWhiteSpace(TotpSecret);
}

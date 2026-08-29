namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// Everything needed to talk to DhanHQ API v2. Bound from the "Dhan" section of appsettings.json
/// (or the equivalent Dhan__* environment variables) - deliberately the same section name and
/// field names as the LiveSpreadCalculator app's DhanOptions, so an already-working
/// ClientId/AccessToken pair can be copied across unchanged.
///
/// Only static-token auth is supported here (paste a portal-generated access token into
/// AccessToken). This app has no order/position surface that would justify the TOTP
/// auto-renewal machinery the trading app carries - a token that goes stale just means the feed
/// logs a clear "token expired" warning until it's refreshed.
/// </summary>
public sealed class DhanOptions
{
    public const string SectionName = "Dhan";

    /// <summary>The Dhan account id (a numeric string). Sent as the client-id header on every
    /// REST call and as the clientId query parameter on the market-feed WebSocket.</summary>
    public string ClientId { get; set; } = "";

    /// <summary>A pre-generated access token from the Dhan web portal (Profile -> DhanHQ Trading
    /// APIs). Portal tokens are currently fixed at 24-hour validity, so this needs refreshing
    /// roughly once a day.</summary>
    public string AccessToken { get; set; } = "";

    public string RestBaseUrl { get; set; } = "https://api.dhan.co/v2";

    /// <summary>Live market data feed. Authenticates via query string
    /// (?version=2&amp;token=...&amp;clientId=...&amp;authType=2).</summary>
    public string WsUrl { get; set; } = "wss://api-feed.dhan.co";

    /// <summary>The compact instrument dump - the only one of Dhan's two scrip master files with
    /// a per-contract trading symbol column.</summary>
    public string ScripMasterUrl { get; set; } = "https://images.dhan.co/api-data/api-scrip-master.csv";

    /// <summary>ltp, quote, or full. "full" is used by default so OHLC is available for building
    /// candles even before this app's own bar timer closes one.</summary>
    public string TickerMode { get; set; } = "full";

    public bool HasSession => !string.IsNullOrWhiteSpace(ClientId) && !string.IsNullOrWhiteSpace(AccessToken);
}

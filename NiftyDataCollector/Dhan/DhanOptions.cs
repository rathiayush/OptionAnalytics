namespace NiftyDataCollector.Dhan;

/// <summary>
/// Dhan credentials for this collector - STATIC TOKEN ONLY, deliberately. OptionAnalytics.Server's
/// own DhanTotpAutoRenewalHostedService mints a fresh token via TOTP login when configured that
/// way, and a SECOND independent process logging in against the same Dhan account risks
/// invalidating whichever token the other process is currently holding (a fresh login commonly
/// invalidates a previously issued one for the same account). Since this collector shares the main
/// app's Dhan session per its own design decision, it must never do its own login - only ever read
/// a token that was generated once (the portal's own 24h token, or whatever the main app is
/// currently using) and configured here directly.
///
/// If the main dashboard is running in TOTP auto-renewal mode, generate a separate portal token for
/// THIS collector instead of pointing it at the same Pin/TotpSecret - two independent token mints
/// against one account is the exact failure mode this class exists to avoid.
/// </summary>
public sealed class DhanOptions
{
    public const string SectionName = "Dhan";

    public string ClientId { get; set; } = "";
    public string AccessToken { get; set; } = "";
    public string RestBaseUrl { get; set; } = "https://api.dhan.co/v2";

    public bool HasSession => !string.IsNullOrWhiteSpace(ClientId) && !string.IsNullOrWhiteSpace(AccessToken);
}

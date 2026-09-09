namespace OptionAnalytics.Server.Auth;

/// <summary>Bound from the "Auth" config section. Exactly two fixed accounts - this app has no
/// user database and no self-service signup, matching its existing scale (a single-user/small-team
/// personal trading tool, not a multi-tenant product) - so hardcoded email+role pairs with
/// passwords supplied as configuration is the same pattern Dhan/Telegram credentials already use,
/// not a new one invented for this.
///
/// Passwords are secrets - set them in appsettings.Local.json (gitignored) for local runs, or as
/// Auth__AdminPassword/Auth__UserPassword environment variables in production (see
/// docker-compose.yml), never committed. A blank password (the default) means that account can
/// never log in - see AuthService.TryAuthenticate - so a fresh deploy fails closed rather than
/// accepting an empty password.</summary>
public sealed class AuthOptions
{
    public const string SectionName = "Auth";

    public string AdminEmail { get; set; } = "admin@backtest.com";
    public string AdminPassword { get; set; } = "";

    public string UserEmail { get; set; } = "user@backtest.com";
    public string UserPassword { get; set; } = "";
}

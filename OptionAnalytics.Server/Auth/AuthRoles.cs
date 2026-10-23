namespace OptionAnalytics.Server.Auth;

/// <summary>The roles AuthOptions' accounts map to - matched against
/// System.Security.Claims.ClaimTypes.Role by ASP.NET Core's own [Authorize(Roles = ...)]/
/// RequireRole, so these strings are load-bearing, not just labels.</summary>
public static class AuthRoles
{
    public const string Admin = "Admin";
    public const string User = "User";
    /// <summary>The outside viewer: the External page's two read-only views and nothing else (ExternalAccess).</summary>
    public const string External = "External";
}

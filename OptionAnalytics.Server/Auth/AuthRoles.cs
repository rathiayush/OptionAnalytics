namespace OptionAnalytics.Server.Auth;

/// <summary>The exact two roles AuthOptions' two accounts map to - matched against
/// System.Security.Claims.ClaimTypes.Role by ASP.NET Core's own [Authorize(Roles = ...)]/
/// RequireRole, so these strings are load-bearing, not just labels.</summary>
public static class AuthRoles
{
    public const string Admin = "Admin";
    public const string User = "User";
}

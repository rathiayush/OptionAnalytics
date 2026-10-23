using System.Security.Claims;

namespace OptionAnalytics.Server.Auth;

/// <summary>
/// The fence around the External account (AuthRoles.External): a request signed in as it may reach ONLY its own
/// read-only API (ExternalController, /api/external/...), sign in / out / "who am I" (/api/auth/...), the build stamp
/// (/api/version) and the page shell - every other API, every SignalR hub and swagger answer 403, whatever attribute
/// (or none) the endpoint carries. A deny-by-default allow list, checked after authentication, so a new controller added
/// later is closed to it too.
/// </summary>
public static class ExternalAccess
{
    private static readonly string[] AllowedPrefixes = { "/api/external/", "/api/auth/" };
    private static readonly string[] AllowedExact = { "/api/version" };
    // The page shell and its assets are served from paths outside these; anything under them is an API.
    private static readonly string[] ClosedPrefixes = { "/api", "/hubs", "/swagger" };

    /// <summary>May an External session make this request?</summary>
    public static bool Allows(PathString path)
    {
        // Lower case, repeated slashes collapsed: "//API//trades" is "/api/trades" here. Anything that merely STARTS with
        // a closed prefix ("/api%2f...", "/apix") stays closed too.
        var p = System.Text.RegularExpressions.Regex.Replace((path.Value ?? "/").ToLowerInvariant(), "/{2,}", "/");
        // Encoded, backslash or dot-dot paths: the External page never makes one - refused outright.
        if (p.Contains("..", StringComparison.Ordinal) || p.Contains('%') || p.Contains('\\')) return false;
        if (AllowedExact.Contains(p.TrimEnd('/'))) return true;
        if (AllowedPrefixes.Any(a => p.StartsWith(a, StringComparison.Ordinal))) return true;
        return !ClosedPrefixes.Any(c => p.StartsWith(c, StringComparison.Ordinal));
    }

    public static bool IsExternal(ClaimsPrincipal user) =>
        user.Identity?.IsAuthenticated == true && user.IsInRole(AuthRoles.External);

    public static IApplicationBuilder UseExternalAccessFence(this IApplicationBuilder app) => app.Use(async (context, next) =>
    {
        if (IsExternal(context.User) && !Allows(context.Request.Path))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }
        await next();
    });
}

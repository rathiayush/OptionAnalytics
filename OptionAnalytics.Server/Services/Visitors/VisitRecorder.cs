using System.Security.Claims;

namespace OptionAnalytics.Server.Services.Visitors;

/// <summary>Records a visit from a request: who (the signed-in account, or the browser's visitor id), the place from
/// the connection (GeoLocator - the address is looked up and dropped here, not passed on), and the device in words.</summary>
public sealed class VisitRecorder
{
    private readonly VisitorLog _log;
    private readonly GeoLocator _geo;

    public VisitRecorder(VisitorLog log, GeoLocator geo)
    {
        _log = log;
        _geo = geo;
    }

    /// <summary>`account` / `role`: who, when the request is not (yet) signed in as them - a sign-in, a failed one.</summary>
    public bool Record(HttpContext context, string kind, string? page = null, string? visitor = null, string? account = null, string? role = null)
    {
        var signedIn = context.User.Identity?.IsAuthenticated == true;
        var place = _geo.Locate(ClientAddress.Of(context));
        return _log.Record(new VisitEntry(
            default, kind,
            account ?? (signedIn ? context.User.Identity!.Name : null),
            role ?? (signedIn ? context.User.FindFirstValue(ClaimTypes.Role) : null),
            page, visitor, place?.City, place?.Region, place?.Country,
            DeviceOf(context.Request.Headers.UserAgent.ToString())));
    }

    /// <summary>"Chrome · Windows", "Safari · iPhone" - the browser and system from a User-Agent, in words.</summary>
    public static string? DeviceOf(string? userAgent)
    {
        if (string.IsNullOrWhiteSpace(userAgent)) return null;
        var ua = userAgent;
        bool Has(string s) => ua.Contains(s, StringComparison.OrdinalIgnoreCase);
        var browser = Has("Edg/") ? "Edge" : Has("OPR/") || Has("Opera") ? "Opera" : Has("SamsungBrowser") ? "Samsung Internet"
            : Has("Firefox/") || Has("FxiOS") ? "Firefox" : Has("CriOS") || Has("Chrome/") ? "Chrome"
            : Has("Safari/") ? "Safari" : Has("curl") || Has("python") || Has("bot") || Has("spider") ? "Script / bot" : "Other browser";
        var system = Has("iPhone") ? "iPhone" : Has("iPad") ? "iPad" : Has("Android") ? "Android" : Has("Windows") ? "Windows"
            : Has("Mac OS X") || Has("Macintosh") ? "macOS" : Has("CrOS") ? "ChromeOS" : Has("Linux") ? "Linux" : null;
        return system is null ? browser : $"{browser} · {system}";
    }
}

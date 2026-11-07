using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>
/// The admin CACHE page (CacheBrowser): the server's data caches - the Dhan data cache, the Order Flow days, the Expired
/// Backtest's CSVs - folder by folder with their sizes, and a file or folder deleted. Admin only: the User, Runner and
/// External accounts never reach it (ExternalAccess denies it by default).
/// </summary>
[ApiController]
[Route("api/cache")]
[Authorize(Roles = AuthRoles.Admin)]
public sealed class CacheController : ControllerBase
{
    private readonly CacheBrowser _browser;

    public CacheController(CacheBrowser browser) => _browser = browser;

    /// <summary>GET /api/cache - every cache: what it is, its folder, its files and size.</summary>
    [HttpGet("")]
    public object Roots() => new { roots = _browser.Roots() };

    /// <summary>GET /api/cache/{root}?path=a/b - one folder of a cache ("" = its top).</summary>
    [HttpGet("{root}")]
    public IActionResult List(string root, [FromQuery] string? path)
    {
        var (listing, error) = _browser.List(root, path);
        return listing is not null ? Ok(listing) : error!.StartsWith("Not found", StringComparison.Ordinal) || error == "No such cache." ? NotFound(new { error }) : BadRequest(new { error });
    }

    /// <summary>DELETE /api/cache/{root}?path=a/b - a file, or a folder and all in it. Everything in the cache (no path) only
    /// with all=true - so a request that lost its path never empties a cache.</summary>
    [HttpDelete("{root}")]
    public IActionResult Delete(string root, [FromQuery] string? path, [FromQuery] bool all = false)
    {
        if (string.IsNullOrWhiteSpace(path) && !all) return BadRequest(new { error = "Say which file or folder - or all=true for everything in this cache." });
        var (result, error) = _browser.Delete(root, all && string.IsNullOrWhiteSpace(path) ? "" : path, User.Identity?.Name ?? "an admin");
        return result is not null ? Ok(result) : error!.StartsWith("Not found", StringComparison.Ordinal) || error == "No such cache." ? NotFound(new { error }) : BadRequest(new { error });
    }
}

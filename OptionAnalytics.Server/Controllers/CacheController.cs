using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Net.Http.Headers;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>
/// The admin CACHE page (CacheBrowser): the server's data caches - the Dhan data cache, the Order Flow days, the Expired
/// Backtest's CSVs - folder by folder with their sizes, a file or folder deleted, and DOWNLOADED (a file as it is, a folder
/// or a cache as one zip, every cache as one zip - streamed); and the server's OWN RECORDS - the Telegram and visitor logs,
/// the saved strategies and their history, the background runs, the trade / risk settings CSVs - download only. Every folder
/// with its full path. Admin only: the User, Runner and External accounts never reach it (ExternalAccess denies it by
/// default).
/// </summary>
[ApiController]
[Route("api/cache")]
[Authorize(Roles = AuthRoles.Admin)]
public sealed class CacheController : ControllerBase
{
    private readonly CacheBrowser _browser;
    private readonly ILogger<CacheController> _logger;

    public CacheController(CacheBrowser browser, ILogger<CacheController>? logger = null)
    {
        _browser = browser;
        _logger = logger ?? Microsoft.Extensions.Logging.Abstractions.NullLogger<CacheController>.Instance;
    }

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

    /// <summary>GET /api/cache/{root}/download?path=a/b - a file as it is, or a folder ("" = the whole cache) as one zip.</summary>
    [HttpGet("{root}/download")]
    public IActionResult Download(string root, [FromQuery] string? path)
    {
        var (download, error) = _browser.Download(root, path);
        if (download is null) return error!.StartsWith("Not found", StringComparison.Ordinal) || error == "No such cache." ? NotFound(new { error }) : BadRequest(new { error });
        _logger.LogInformation("{Who} downloaded {Cache}/{Path} ({Bytes} bytes{Zip}).", User.Identity?.Name, root, string.IsNullOrWhiteSpace(path) ? "(everything)" : path,
            download.Bytes, download.Folder ? ", zipped" : "");
        return download.Folder
            ? new ZipStreamResult(_browser, download.Sources ?? new[] { (download.Prefix, download.FullPath) }, download.FileName)
            : PhysicalFile(download.FullPath, ContentTypeOf(download.FileName), download.FileName);
    }

    /// <summary>GET /api/cache/everything.zip?kind= - many roots in one zip, each its own top folder: `caches` (the default -
    /// every data cache), `records` (the server's own records), `csv` (every CSV file of every root - caches and records)
    /// or `all`.</summary>
    [HttpGet("everything.zip")]
    public IActionResult DownloadEverything([FromQuery] string? kind = null)
    {
        var k = (kind ?? "caches").ToLowerInvariant();
        if (k is not ("caches" or "records" or "csv" or "all")) return BadRequest(new { error = "kind is caches, records, csv or all." });
        _logger.LogInformation("{Who} downloaded {Kind} as one zip.", User.Identity?.Name, k);
        var folders = _browser.AllFolders(k == "csv" ? "all" : k);
        Func<string, bool>? include = k == "csv" ? n => n.EndsWith(".csv", StringComparison.OrdinalIgnoreCase) : null;
        return new ZipStreamResult(_browser, folders, $"option-analytics-{k}-{IstClock.Today():yyyy-MM-dd}.zip", include);
    }

    internal static string ContentTypeOf(string name) =>
        name.EndsWith(".gz", StringComparison.OrdinalIgnoreCase) ? "application/gzip"
        : name.EndsWith(".csv", StringComparison.OrdinalIgnoreCase) ? "text/csv"
        : name.EndsWith(".json", StringComparison.OrdinalIgnoreCase) ? "application/json"
        : "application/octet-stream";

    /// <summary>A zip written straight into the response as the files are read (CacheBrowser.WriteZip) - .NET's ZipArchive
    /// writes synchronously, so this one response allows it; stops when the browser goes away.</summary>
    internal sealed class ZipStreamResult(CacheBrowser browser, IReadOnlyList<(string Prefix, string Folder)> folders, string fileName,
        Func<string, bool>? include = null) : IActionResult
    {
        public async Task ExecuteResultAsync(ActionContext context)
        {
            var http = context.HttpContext;
            http.Response.ContentType = "application/zip";
            http.Response.Headers.ContentDisposition = new ContentDispositionHeaderValue("attachment") { FileNameStar = fileName, FileName = fileName }.ToString();
            if (http.Features.Get<IHttpBodyControlFeature>() is { } body) body.AllowSynchronousIO = true;
            try { await Task.Run(() => browser.WriteZip(http.Response.Body, folders, http.RequestAborted, include)); }
            catch (OperationCanceledException) { /* the browser went away */ }
        }
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

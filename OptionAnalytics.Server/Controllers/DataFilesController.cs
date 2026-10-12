using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>The server's files for the admin's Data files page (DataFilesService) - the scanner log CSVs, the cached
/// API data, the tuning's results / cache and the settings files: listed, read and downloaded. Read-only.</summary>
[ApiController]
[Route("api/data-files")]
[Authorize(Roles = AuthRoles.Admin)]
public sealed class DataFilesController : ControllerBase
{
    private readonly DataFilesService _files;

    public DataFilesController(DataFilesService files) => _files = files;

    /// <summary>GET /api/data-files - every place, with its file count, size and newest change.</summary>
    [HttpGet]
    public IActionResult Places() => Ok(new { places = _files.Places() });

    /// <summary>GET /api/data-files/{key}?path= - a folder's entries in a place.</summary>
    [HttpGet("{key}")]
    public IActionResult List(string key, [FromQuery] string? path)
    {
        var (entries, error) = _files.List(key, path);
        return entries is null ? BadRequest(new { error }) : Ok(new { key, path = path ?? "", entries });
    }

    /// <summary>GET /api/data-files/{key}/view?path=&amp;bytes= - the start of a file as text (csv / json / text).</summary>
    [HttpGet("{key}/view")]
    public IActionResult View(string key, [FromQuery] string? path, [FromQuery] int? bytes)
    {
        var (full, error) = _files.File(key, path);
        if (full is null) return error == "not there" ? NotFound(new { error }) : BadRequest(new { error });
        try { return Ok(DataFilesService.Preview(full, _files.RelativeOf(key, full), bytes ?? DataFilesService.DefaultPreviewBytes)); }
        catch (IOException ex) { return Problem($"could not read it: {ex.Message}"); }
        catch (InvalidDataException ex) { return Problem($"could not unzip it: {ex.Message}"); }
    }

    /// <summary>GET /api/data-files/{key}/download?path= - the file itself.</summary>
    [HttpGet("{key}/download")]
    public IActionResult Download(string key, [FromQuery] string? path)
    {
        var (full, error) = _files.File(key, path);
        if (full is null) return error == "not there" ? NotFound(new { error }) : BadRequest(new { error });
        return PhysicalFile(full, "application/octet-stream", Path.GetFileName(full));
    }
}

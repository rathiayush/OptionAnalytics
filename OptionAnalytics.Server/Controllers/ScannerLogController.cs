using System.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>The strategy scanner's record as CSV on the server (ScannerLogStore): the Order Flow page
/// posts each day's signals - with the day type and the adaptive call - and its option trades as they
/// change; they can be listed and downloaded per day, or every day of one kind at once.</summary>
[ApiController]
[Route("api/scanner-log")]
[Authorize]
public sealed class ScannerLogController : ControllerBase
{
    private readonly ScannerLogStore _store;

    public ScannerLogController(ScannerLogStore store) => _store = store;

    /// <summary>POST /api/scanner-log/day - upsert one day's signals and trades.</summary>
    [HttpPost("day")]
    [RequestSizeLimit(4_000_000)]
    public async Task<IActionResult> PostDay([FromBody] ScannerLogDayRequest request, CancellationToken cancellationToken)
    {
        if (request is null) return BadRequest(new { error = "No body." });
        var (signals, trades, error) = await _store.UpsertDayAsync(request, User.Identity?.Name, cancellationToken);
        return error is null ? Ok(new { signals, trades }) : BadRequest(new { error });
    }

    /// <summary>GET /api/scanner-log - the stored files, newest day first.</summary>
    [HttpGet]
    public IActionResult List() => Ok(_store.ListFiles());

    /// <summary>GET /api/scanner-log/file/{name} - one stored CSV.</summary>
    [HttpGet("file/{name}")]
    public IActionResult GetFile(string name)
    {
        var path = _store.PathOf(name);
        return path is null ? NotFound() : PhysicalFile(path, "text/csv", name);
    }

    /// <summary>GET /api/scanner-log/all/{kind} - every stored day of 'signals' or 'trades' as one CSV.</summary>
    [HttpGet("all/{kind}")]
    public IActionResult All(string kind)
    {
        var csv = _store.Combined(kind);
        return csv is null ? NotFound() : File(Encoding.UTF8.GetBytes(csv), "text/csv", $"{kind}_all.csv");
    }
}

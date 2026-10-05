using System.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>The strategy scanner's record on the server as two CSV files (ScannerLogStore) - signals.csv
/// and trades.csv, every day in each: the Order Flow page posts each day's signals (with the day type and
/// the adaptive call) and its option trades as they change, and either file can be downloaded.</summary>
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

    /// <summary>GET /api/scanner-log/signals or /api/scanner-log/trades - that whole file (every underlying,
    /// every day).</summary>
    [HttpGet("{kind}")]
    public IActionResult Download(string kind)
    {
        var csv = _store.ReadAll(kind);
        return csv is null ? NotFound() : File(Encoding.UTF8.GetBytes(csv), "text/csv", $"{kind}.csv");
    }
}

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

    /// <summary>GET /api/scanner-log/summary - the totals per underlying (NIFTY, BANKNIFTY ...): how many
    /// signals and trades, the futures points and option premium points captured, the P&amp;L net of
    /// charges - for each stored day and in total - as JSON (totals / days).</summary>
    [HttpGet("summary")]
    public async Task<IActionResult> Summary(CancellationToken cancellationToken, [FromQuery] string? source = null)
    {
        var rows = await _store.SummaryAsync(cancellationToken, source);
        return Ok(new { totals = rows.Where(r => r.Scope == "total"), days = rows.Where(r => r.Scope == "day") });
    }

    /// <summary>GET /api/scanner-log/summary/csv - the same totals as a CSV: a row per underlying and day,
    /// then that underlying's TOTAL row.</summary>
    [HttpGet("summary/csv")]
    public async Task<IActionResult> SummaryCsv(CancellationToken cancellationToken) =>
        File(Encoding.UTF8.GetBytes(ScannerLogStore.SummaryCsv(await _store.SummaryAsync(cancellationToken))), "text/csv", "summary.csv");

    /// <summary>GET /api/scanner-log/signals or /api/scanner-log/trades - that whole file (every underlying,
    /// every day).</summary>
    [HttpGet("{kind}")]
    public IActionResult Download(string kind)
    {
        var csv = _store.ReadAll(kind);
        return csv is null ? NotFound() : File(Encoding.UTF8.GetBytes(csv), "text/csv", $"{kind}.csv");
    }
}

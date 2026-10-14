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
    private readonly ScannerEvents? _events;

    public ScannerLogController(ScannerLogStore store, ScannerEvents? events = null)
    {
        _store = store;
        _events = events;
    }

    /// <summary>POST /api/scanner-log/day - upsert one day's signals and trades (the open record views are told - ScannerEvents).</summary>
    [HttpPost("day")]
    [RequestSizeLimit(4_000_000)]
    public async Task<IActionResult> PostDay([FromBody] ScannerLogDayRequest request, CancellationToken cancellationToken)
    {
        if (request is null) return BadRequest(new { error = "No body." });
        var (signals, trades, error) = await _store.UpsertDayAsync(request, User.Identity?.Name, cancellationToken);
        if (error is not null) return BadRequest(new { error });
        _events?.Record(request.Source, request.Underlying, request.Date);
        return Ok(new { signals, trades });
    }

    /// <summary>POST /api/scanner-log/legs/{kind} - fills in what the option bought / sold would have made on signals
    /// kept before those were recorded (the Trades page rebuilds them from that day's OI). Admin.</summary>
    [HttpPost("legs/{kind}")]
    [Authorize(Roles = OptionAnalytics.Server.Auth.AuthRoles.Admin)]
    [RequestSizeLimit(2_000_000)]
    public async Task<IActionResult> SetLegs(string kind, [FromBody] List<ScannerLegsRow>? rows, CancellationToken cancellationToken)
    {
        var (updated, error) = await _store.SetLegsAsync(kind, rows ?? new List<ScannerLegsRow>(), cancellationToken);
        if (error is not null) return BadRequest(new { error });
        if (updated > 0) _events?.Record(kind.StartsWith("server", StringComparison.OrdinalIgnoreCase) ? "server" : "page", null, null);
        return Ok(new { updated });
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

    /// <summary>GET /api/scanner-log/rows/{kind} - the same file as rows (JSON: column -> value) for the Trades page:
    /// signals / trades (the page's record) or server-signals / server-trades (the server scanner's).</summary>
    [HttpGet("rows/{kind}")]
    public IActionResult Rows(string kind)
    {
        var rows = _store.ReadRows(kind);
        return rows is null ? NotFound(new { error = "kind must be signals, trades, server-signals or server-trades." }) : Ok(rows);
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

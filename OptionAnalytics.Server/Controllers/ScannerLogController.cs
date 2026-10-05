using System.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>The strategy scanner's record as one CSV file on the server (ScannerLogStore): the Order
/// Flow page posts each day's signals - with the day type, the adaptive call and the trades punched for
/// them - as they change, and the file can be downloaded.</summary>
[ApiController]
[Route("api/scanner-log")]
[Authorize]
public sealed class ScannerLogController : ControllerBase
{
    private readonly ScannerLogStore _store;

    public ScannerLogController(ScannerLogStore store) => _store = store;

    /// <summary>POST /api/scanner-log/day - upsert one day's signals (and their trades).</summary>
    [HttpPost("day")]
    [RequestSizeLimit(4_000_000)]
    public async Task<IActionResult> PostDay([FromBody] ScannerLogDayRequest request, CancellationToken cancellationToken)
    {
        if (request is null) return BadRequest(new { error = "No body." });
        var (rows, error) = await _store.UpsertDayAsync(request, User.Identity?.Name, cancellationToken);
        return error is null ? Ok(new { rows }) : BadRequest(new { error });
    }

    /// <summary>GET /api/scanner-log - the whole file (every underlying, every day).</summary>
    [HttpGet]
    public IActionResult Download() => File(Encoding.UTF8.GetBytes(_store.ReadAll()), "text/csv", ScannerLogStore.FileName);
}

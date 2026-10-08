using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>The server-side strategy scanner (ScannerRunnerHostedService): its config - which indices, the
/// scanner settings - and what it reports.</summary>
[ApiController]
[Route("api/scanner-runner")]
public sealed class ScannerRunnerController : ControllerBase
{
    private readonly ScannerRunnerStore _store;

    public ScannerRunnerController(ScannerRunnerStore store) => _store = store;

    /// <summary>GET /api/scanner-runner/config - the runner reads it every minute; the page shows it.</summary>
    [HttpGet("config")]
    [Authorize(Roles = $"{AuthRoles.Admin},{ScannerRunnerKey.Role}")]
    public IActionResult GetConfig() => Ok(_store.Config());

    /// <summary>PUT /api/scanner-runner/config - an admin's page saves its scanner settings (and per-index SL /
    /// target levels) here as they change, and switches indices on / off. Only the keys sent change.</summary>
    [HttpPut("config")]
    [Authorize(Roles = AuthRoles.Admin)]
    [RequestSizeLimit(200_000)]
    public IActionResult PutConfig([FromBody] JsonObject patch)
    {
        if (patch is null) return BadRequest(new { error = "No body." });
        var allowed = new HashSet<string> { "settings", "levels", "enabled", "alertIds" };
        var unknown = patch.Select(kv => kv.Key).Where(k => !allowed.Contains(k)).ToList();
        if (unknown.Count > 0) return BadRequest(new { error = $"Unknown keys: {string.Join(", ", unknown)}" });
        return Ok(_store.Update(patch));
    }

    /// <summary>POST /api/scanner-runner/status - the runner's heartbeat (per index: last look, signals, paper trades).</summary>
    [HttpPost("status")]
    [Authorize(Roles = ScannerRunnerKey.Role)]
    [RequestSizeLimit(2_000_000)]
    public IActionResult PostStatus([FromBody] JsonNode status)
    {
        if (status is null) return BadRequest();
        _store.SetStatus(status);
        return Ok();
    }

    /// <summary>GET /api/scanner-runner/status - whether it is running and what it last reported.</summary>
    [HttpGet("status")]
    public IActionResult GetStatus() => Ok(_store.Status());
}

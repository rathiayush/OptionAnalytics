using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>The Signal backtest's BACKGROUND runs (SignalBacktestJobService): queue one (now or at a time), list them,
/// stop / remove one, read a finished one's report. Admin and User accounts only - each sees its own runs, an admin every
/// account's; the server scanner's Runner key and the External account never reach it.</summary>
[ApiController]
[Route("api/signal-backtest")]
[Authorize(Roles = AuthRoles.Admin + "," + AuthRoles.User)]
public sealed class SignalBacktestController : ControllerBase
{
    private readonly SignalBacktestJobService _jobs;

    public SignalBacktestController(SignalBacktestJobService jobs) => _jobs = jobs;

    /// <summary>Whose runs the caller sees: null (every account's) for an admin.</summary>
    private string? Scope => User.IsInRole(AuthRoles.Admin) ? null : Owner;
    private string Owner => User.Identity?.Name ?? "";

    /// <summary>GET /api/signal-backtest/jobs - the runs, newest first (settings, state, progress, the report's numbers).</summary>
    [HttpGet("jobs")]
    public IReadOnlyList<SignalBacktestJob> Jobs() => _jobs.List(Scope);

    /// <summary>POST /api/signal-backtest/jobs - queues a run: { settings, name, startAtUtc (null = now), telegram, kind
    /// ("backtest" - the default - or "features") }.</summary>
    [HttpPost("jobs")]
    public IActionResult Queue([FromBody] SignalBacktestRequest request)
    {
        var (job, error) = _jobs.Add(Owner, request, DateTimeOffset.UtcNow);
        return job is null ? BadRequest(new { error }) : Ok(job);
    }

    /// <summary>POST /api/signal-backtest/jobs/{id}/cancel - stops a waiting or running run.</summary>
    [HttpPost("jobs/{id}/cancel")]
    public IActionResult Cancel(string id) => _jobs.Cancel(id, Scope) ? Ok(_jobs.Get(id, Scope)) : NotFound(new { error = "No such run." });

    /// <summary>DELETE /api/signal-backtest/jobs/{id} - removes a run and its report.</summary>
    [HttpDelete("jobs/{id}")]
    public IActionResult Delete(string id) => _jobs.Delete(id, Scope) ? NoContent() : NotFound(new { error = "No such run." });

    /// <summary>GET /api/signal-backtest/jobs/{id}/result - a finished run's report (the file the job wrote).</summary>
    [HttpGet("jobs/{id}/result")]
    public IActionResult Result(string id) =>
        _jobs.ResultPath(id, Scope) is { } path
            ? PhysicalFile(path, "application/json")
            : NotFound(new { error = "No report for that run (not finished, failed or removed)." });

    /// <summary>GET /api/signal-backtest/jobs/{id}/features.csv - a finished Feature finder run's dataset (a row a candle, a
    /// column a reading and what came next).</summary>
    [HttpGet("jobs/{id}/features.csv")]
    public IActionResult Features(string id)
    {
        if (_jobs.FeaturesPath(id, Scope) is not { } path || _jobs.Get(id, Scope) is not { } job)
            return NotFound(new { error = "No dataset for that run (not a Feature finder run, not finished, failed or removed)." });
        var timeframe = job.Settings["timeframe"] is JsonValue v && v.TryGetValue<int>(out var tf) ? $"-{tf}m" : "";
        return PhysicalFile(path, "text/csv", $"features-{job.Underlying}{timeframe}-{job.From}-{job.To}.csv");
    }
}

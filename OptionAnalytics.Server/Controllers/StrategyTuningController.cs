using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>The strategy tuning job (StrategyTuningService): start it, watch it, read its result.</summary>
[ApiController]
[Route("api/strategy-tuning")]
public sealed class StrategyTuningController : ControllerBase
{
    private static readonly string[] Underlyings = { "NIFTY", "BANKNIFTY", "SENSEX" };
    private readonly StrategyTuningService _tuning;

    public StrategyTuningController(StrategyTuningService tuning) => _tuning = tuning;

    /// <summary>`What`: what is tuned - "trade" (the trade settings), "oi" (the OI confirmation) or "both"
    /// (the OI confirmation first, then the trade settings on top of it).</summary>
    public sealed record RunRequest(string Underlying, JsonNode? Strategies, int Days = 30, bool IncludeEstimated = false, int MinTrades = 8, string? What = null, string[]? OiFactors = null);
    private static readonly HashSet<string> OiFactorKeys = new() { "tradeOiWindow", "tradeFutWindow", "tradeOiFlow", "tradeOiCum", "tradeFutOi", "tradeWallRoom", "tradeWallOi" };
    private static readonly HashSet<string> TuneWhat = new() { "trade", "oi", "both" };

    /// <summary>POST /api/strategy-tuning/run - starts a job (one at a time).</summary>
    [HttpPost("run")]
    [Authorize(Roles = AuthRoles.Admin)]
    public IActionResult Run([FromBody] RunRequest request)
    {
        var u = (request?.Underlying ?? "").Trim().ToUpperInvariant();
        if (!Underlyings.Contains(u)) return BadRequest(new { error = "Underlying must be NIFTY, BANKNIFTY or SENSEX." });
        JsonNode? strategies = request!.Strategies switch
        {
            JsonValue v when v.TryGetValue<string>(out var s) && s is "top3" or "top5" or "all" => (JsonNode)v,
            JsonArray a when a.Count is > 0 and <= 40 && a.All(x => x is JsonValue xv && xv.TryGetValue<string>(out _)) => a,
            null => JsonValue.Create("top3"),
            _ => null,
        };
        if (strategies is null) return BadRequest(new { error = "Strategies must be top3, top5, all or a list of strategy ids." });
        var what = string.IsNullOrWhiteSpace(request.What) ? "trade" : request.What.Trim().ToLowerInvariant();
        if (!TuneWhat.Contains(what)) return BadRequest(new { error = "What must be trade, oi or both." });
        var factors = (request.OiFactors ?? Array.Empty<string>()).Distinct().ToList();
        if (factors.Any(f => !OiFactorKeys.Contains(f))) return BadRequest(new { error = "OiFactors must be one of tradeOiWindow, tradeFutWindow, tradeOiFlow, tradeOiCum, tradeFutOi, tradeWallRoom, tradeWallOi." });
        var error = _tuning.Start(new TuningJob(u, strategies.DeepClone(), Math.Clamp(request.Days, 1, 250), request.IncludeEstimated, Math.Clamp(request.MinTrades, 2, 100), what, factors));
        return error is null ? Ok(_tuning.Status()) : Conflict(new { error });
    }

    [HttpPost("cancel")]
    [Authorize(Roles = AuthRoles.Admin)]
    public IActionResult Cancel()
    {
        _tuning.Cancel();
        return Ok(_tuning.Status());
    }

    [HttpGet("status")]
    public TuningStatus Status() => _tuning.Status();

    /// <summary>GET /api/strategy-tuning/result/{underlying} - the last finished job for that index.</summary>
    [HttpGet("result/{underlying}")]
    public IActionResult Result(string underlying) => _tuning.Result(underlying) is { } r ? Ok(r) : NotFound(new { error = $"No tuning result for {underlying.ToUpperInvariant()} yet." });
}

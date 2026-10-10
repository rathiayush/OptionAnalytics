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
    private readonly OptionAnalytics.Server.Dhan.DhanDataApiRateLimiter _dhanLimiter;

    public StrategyTuningController(StrategyTuningService tuning, OptionAnalytics.Server.Dhan.DhanDataApiRateLimiter dhanLimiter)
    {
        _tuning = tuning;
        _dhanLimiter = dhanLimiter;
    }

    /// <summary>`What`: what is tuned - "trade" (the trade settings), "oi" (the OI confirmation) or "both"
    /// (the OI confirmation first, then the trade settings on top of it).</summary>
    public sealed record RunRequest(string Underlying, JsonNode? Strategies, int Days = 30, bool IncludeEstimated = false, int MinTrades = 8, string? What = null, string[]? OiFactors = null, string? Search = null, string? Data = null, string? From = null, string? To = null);
    private static readonly HashSet<string> OiFactorKeys = new() { "tradeOiWindow", "tradeFutWindow", "tradeOiFlow", "tradeOiCum", "tradeSideOi", "tradeSideCum", "tradeFutOi", "tradeMoveSize", "tradeDayType", "tradeWallRoom", "tradeWallOi" };
    private static readonly HashSet<string> TuneWhat = new() { "trade", "oi", "both", "option", "all" };

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
        if (!TuneWhat.Contains(what)) return BadRequest(new { error = "What must be trade, oi, both, option or all." });
        var search = string.IsNullOrWhiteSpace(request.Search) ? "step" : request.Search.Trim().ToLowerInvariant();
        if (search is not ("step" or "full")) return BadRequest(new { error = "Search must be step or full." });
        var data = string.IsNullOrWhiteSpace(request.Data) ? "futures" : request.Data.Trim().ToLowerInvariant();
        if (data is not ("futures" or "spot")) return BadRequest(new { error = "Data must be futures or spot." });
        // An optional date range (yyyy-MM-dd, either end may be open) instead of "the last N days".
        static bool Day(string? s, out DateOnly d) { d = default; return string.IsNullOrWhiteSpace(s) || DateOnly.TryParseExact(s.Trim(), "yyyy-MM-dd", out d); }
        if (!Day(request.From, out var from) || !Day(request.To, out var to)) return BadRequest(new { error = "From / To must be dates (yyyy-MM-dd)." });
        if (!string.IsNullOrWhiteSpace(request.From) && !string.IsNullOrWhiteSpace(request.To) && from > to) return BadRequest(new { error = "From must be on or before To." });
        var factors = (request.OiFactors ?? Array.Empty<string>()).Distinct().ToList();
        if (factors.Any(f => !OiFactorKeys.Contains(f))) return BadRequest(new { error = "OiFactors must be one of tradeOiWindow, tradeFutWindow, tradeOiFlow, tradeOiCum, tradeSideOi, tradeSideCum, tradeFutOi, tradeMoveSize, tradeDayType, tradeWallRoom, tradeWallOi." });
        var error = _tuning.Start(new TuningJob(u, strategies.DeepClone(), Math.Clamp(request.Days, 1, 250), request.IncludeEstimated, Math.Clamp(request.MinTrades, 2, 100), what, factors, search, data, string.IsNullOrWhiteSpace(request.From) ? null : request.From.Trim(), string.IsNullOrWhiteSpace(request.To) ? null : request.To.Trim()));
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

    /// <summary>GET /api/strategy-tuning/dhan-usage - Dhan Data-API calls this server made today (IST) against Dhan's
    /// documented 100,000/day: shown on the page, and read by the tuning job before each day so it never takes the last of
    /// the day's allowance from the live app.</summary>
    [HttpGet("dhan-usage")]
    public IActionResult DhanUsage()
    {
        var (day, calls, limit) = _dhanLimiter.Usage();
        return Ok(new { day = day.ToString("yyyy-MM-dd"), calls, dailyLimit = limit });
    }

    /// <summary>GET /api/strategy-tuning/trades/{underlying} - every trade of the last finished job for that index (each
    /// strategy as written on every day scanned, and each tuned strategy's best setting) - the Trades page.</summary>
    [HttpGet("trades/{underlying}")]
    public IActionResult Trades(string underlying, [FromQuery] string? data = null)
    {
        var d = string.Equals(data, "spot", StringComparison.OrdinalIgnoreCase) ? "spot" : "futures";
        return _tuning.Trades(underlying, d) is { } r ? Ok(r) : NotFound(new { error = $"No {(d == "spot" ? "spot + options " : "")}tuning trades for {underlying.ToUpperInvariant()} yet - run a tuning job (Strategy tuning page)." });
    }

    /// <summary>GET /api/strategy-tuning/result/{underlying} - the last finished job for that index.</summary>
    [HttpGet("result/{underlying}")]
    public IActionResult Result(string underlying, [FromQuery] string? data = null)
    {
        var d = string.Equals(data, "spot", StringComparison.OrdinalIgnoreCase) ? "spot" : "futures";
        return _tuning.Result(underlying, d) is { } r ? Ok(r) : NotFound(new { error = $"No {(d == "spot" ? "spot + options " : "")}tuning result for {underlying.ToUpperInvariant()} yet." });
    }
}

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
    private readonly StrategyTuningQueue _queue;
    private readonly ScannerLogStore _scannerLog;

    public StrategyTuningController(StrategyTuningService tuning, OptionAnalytics.Server.Dhan.DhanDataApiRateLimiter dhanLimiter, StrategyTuningQueue queue, ScannerLogStore scannerLog)
    {
        _tuning = tuning;
        _dhanLimiter = dhanLimiter;
        _queue = queue;
        _scannerLog = scannerLog;
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
        var (job, invalid) = BuildJob(request, request?.Underlying);
        if (job is null) return BadRequest(new { error = invalid });
        var error = _tuning.Start(job);
        return error is null ? Ok(_tuning.Status()) : Conflict(new { error });
    }

    /// <summary>A job from a request (the same checks for Run and the schedule), or why it is not valid.</summary>
    private static (TuningJob? Job, string? Error) BuildJob(RunRequest? request, string? underlying)
    {
        var u = (underlying ?? "").Trim().ToUpperInvariant();
        if (!Underlyings.Contains(u)) return (null, "Underlying must be NIFTY, BANKNIFTY or SENSEX.");
        JsonNode? strategies = request!.Strategies switch
        {
            JsonValue v when v.TryGetValue<string>(out var s) && s is "top3" or "top5" or "all" => (JsonNode)v,
            JsonArray a when a.Count is > 0 and <= 40 && a.All(x => x is JsonValue xv && xv.TryGetValue<string>(out _)) => a,
            null => JsonValue.Create("top3"),
            _ => null,
        };
        if (strategies is null) return (null, "Strategies must be top3, top5, all or a list of strategy ids.");
        var what = string.IsNullOrWhiteSpace(request.What) ? "trade" : request.What.Trim().ToLowerInvariant();
        if (!TuneWhat.Contains(what)) return (null, "What must be trade, oi, both, option or all.");
        var search = string.IsNullOrWhiteSpace(request.Search) ? "step" : request.Search.Trim().ToLowerInvariant();
        if (search is not ("step" or "full")) return (null, "Search must be step or full.");
        var data = string.IsNullOrWhiteSpace(request.Data) ? "futures" : request.Data.Trim().ToLowerInvariant();
        if (data is not ("futures" or "spot")) return (null, "Data must be futures or spot.");
        // An optional date range (yyyy-MM-dd, either end may be open) instead of "the last N days".
        static bool Day(string? s, out DateOnly d) { d = default; return string.IsNullOrWhiteSpace(s) || DateOnly.TryParseExact(s.Trim(), "yyyy-MM-dd", out d); }
        if (!Day(request.From, out var from) || !Day(request.To, out var to)) return (null, "From / To must be dates (yyyy-MM-dd).");
        if (!string.IsNullOrWhiteSpace(request.From) && !string.IsNullOrWhiteSpace(request.To) && from > to) return (null, "From must be on or before To.");
        var factors = (request.OiFactors ?? Array.Empty<string>()).Distinct().ToList();
        if (factors.Any(f => !OiFactorKeys.Contains(f))) return (null, "OiFactors must be one of tradeOiWindow, tradeFutWindow, tradeOiFlow, tradeOiCum, tradeSideOi, tradeSideCum, tradeFutOi, tradeMoveSize, tradeDayType, tradeWallRoom, tradeWallOi.");
        return (new TuningJob(u, strategies.DeepClone(), Math.Clamp(request.Days, 1, 250), request.IncludeEstimated, Math.Clamp(request.MinTrades, 2, 100), what, factors, search, data, string.IsNullOrWhiteSpace(request.From) ? null : request.From.Trim(), string.IsNullOrWhiteSpace(request.To) ? null : request.To.Trim()), null);
    }

    /// <summary>A job to schedule: the Run request, for one index or several (Underlyings), not before RunAtUtc (null:
    /// as soon as nothing else is running), and optionally again every day.
    /// ChunkDays: the job's date range split into consecutive pieces of this many calendar days, one job each (and each
    /// index), oldest first - a long range as several short jobs instead of one long one.</summary>
    public sealed record QueueRequest(RunRequest Job, string[]? Underlyings, DateTimeOffset? RunAtUtc, bool RepeatDaily = false, int? ChunkDays = null);

    /// <summary>[from, to] (yyyy-MM-dd) cut into consecutive pieces of <paramref name="days"/> calendar days, oldest first.</summary>
    internal static List<(string From, string To)> Chunks(string from, string to, int days)
    {
        var list = new List<(string, string)>();
        if (!DateOnly.TryParseExact(from, "yyyy-MM-dd", out var f) || !DateOnly.TryParseExact(to, "yyyy-MM-dd", out var t) || f > t || days < 1) return list;
        for (var start = f; start <= t; start = start.AddDays(days))
        {
            var end = start.AddDays(days - 1);
            list.Add((start.ToString("yyyy-MM-dd"), (end < t ? end : t).ToString("yyyy-MM-dd")));
        }
        return list;
    }

    /// <summary>GET /api/strategy-tuning/queue - the scheduled jobs, run one at a time.</summary>
    [HttpGet("queue")]
    public IReadOnlyList<TuningQueueItem> Queue() => _queue.Items();

    /// <summary>POST /api/strategy-tuning/queue - schedules a job for each index asked for.</summary>
    [HttpPost("queue")]
    [Authorize(Roles = AuthRoles.Admin)]
    public IActionResult AddToQueue([FromBody] QueueRequest request)
    {
        if (request?.Job is null) return BadRequest(new { error = "A job is required." });
        var indices = (request.Underlyings is { Length: > 0 } list ? list : new[] { request.Job.Underlying }).Select(x => (x ?? "").Trim().ToUpperInvariant()).Distinct().ToList();
        // One piece of the range per job when it is split (oldest first, every index for a piece before the next piece).
        var pieces = request.ChunkDays is > 0 && !string.IsNullOrWhiteSpace(request.Job.From) && !string.IsNullOrWhiteSpace(request.Job.To)
            ? Chunks(request.Job.From.Trim(), request.Job.To.Trim(), request.ChunkDays.Value)
            : new List<(string From, string To)> { (request.Job.From ?? "", request.Job.To ?? "") };
        if (pieces.Count == 0) return BadRequest(new { error = "From / To must be a valid range to split it." });
        if (pieces.Count * indices.Count > 100) return BadRequest(new { error = $"That is {pieces.Count * indices.Count} jobs - use bigger pieces or a shorter range (100 at most)." });
        var jobs = new List<TuningJob>();
        foreach (var (from, to) in pieces)
            foreach (var index in indices)
            {
                var piece = request.ChunkDays is > 0 ? request.Job with { From = from, To = to } : request.Job;
                var (job, error) = BuildJob(piece, index);
                if (job is null) return BadRequest(new { error });
                jobs.Add(job);
            }
        var added = jobs.Select(j => _queue.Add(j, request.RunAtUtc, request.RepeatDaily)).ToList();
        return Ok(added);
    }

    /// <summary>DELETE /api/strategy-tuning/queue/{id} - removes a scheduled job that has not started.</summary>
    [HttpDelete("queue/{id}")]
    [Authorize(Roles = AuthRoles.Admin)]
    public IActionResult RemoveFromQueue(string id) => _queue.Remove(id) ? Ok(_queue.Items()) : NotFound(new { error = "No such scheduled job (or it is running - stop it instead)." });

    /// <summary>POST /api/strategy-tuning/queue/clear-finished - drops the finished jobs from the list.</summary>
    [HttpPost("queue/clear-finished")]
    [Authorize(Roles = AuthRoles.Admin)]
    public IActionResult ClearFinished() { _queue.ClearFinished(); return Ok(_queue.Items()); }

    /// <summary>GET /api/strategy-tuning/performance - every run's trades added up per strategy, across all indices
    /// (TuningPerformance); `data` = futures / spot.</summary>
    [HttpGet("performance")]
    public IActionResult Performance([FromQuery] string? data = null)
    {
        var d = string.Equals(data, "spot", StringComparison.OrdinalIgnoreCase) ? "spot" : string.Equals(data, "futures", StringComparison.OrdinalIgnoreCase) ? "futures" : null;
        var history = _tuning.HistoryRuns();
        var (rows, runs, trades) = TuningPerformance.Build(history, _tuning.HistoryRows, d);
        // How many days were scanned per index - so "traded on 16 days" can be read against the days looked at.
        var coverage = TuningPerformance.Days(history, _tuning.HistoryRows, d).Coverage;
        return Ok(new { runs, trades, rows, coverage });
    }

    /// <summary>GET /api/strategy-tuning/performance/days?data= - every day the runs looked at, per index: used (and in
    /// how many runs it was a train / test day) or left out and why, plus the days scanned per index.</summary>
    [HttpGet("performance/days")]
    public IActionResult PerformanceDays([FromQuery] string? data = null)
    {
        var d = string.Equals(data, "spot", StringComparison.OrdinalIgnoreCase) ? "spot" : string.Equals(data, "futures", StringComparison.OrdinalIgnoreCase) ? "futures" : null;
        var (coverage, days) = TuningPerformance.Days(_tuning.HistoryRuns(), _tuning.HistoryRows, d);
        return Ok(new { coverage, days });
    }

    /// <summary>GET /api/strategy-tuning/performance/trades?strategy=&amp;setting=&amp;index=&amp;data= - every trade of one strategy
    /// across all runs (each counted once), oldest first.</summary>
    [HttpGet("performance/trades")]
    public IActionResult PerformanceTrades([FromQuery] string strategy, [FromQuery] string? setting = null, [FromQuery] string? index = null, [FromQuery] string? data = null)
    {
        if (string.IsNullOrWhiteSpace(strategy)) return BadRequest(new { error = "strategy is required." });
        var d = string.Equals(data, "spot", StringComparison.OrdinalIgnoreCase) ? "spot" : string.Equals(data, "futures", StringComparison.OrdinalIgnoreCase) ? "futures" : null;
        var s = setting is "as written" or "fine-tuned" ? setting : null;
        var i = string.IsNullOrWhiteSpace(index) || index == "all" ? null : index.Trim().ToUpperInvariant();
        return Ok(TuningPerformance.Trades(_tuning.HistoryRuns(), _tuning.HistoryRows, d, strategy.Trim(), s, i));
    }

    /// <summary>What to clear: the tuning results and history, the fetched-days cache, the scanner's record.</summary>
    public sealed record ClearRequest(bool Tuning, bool Cache, bool ScannerRecord);

    /// <summary>POST /api/strategy-tuning/clear - removes the data asked for (admin).</summary>
    [HttpPost("clear")]
    [Authorize(Roles = AuthRoles.Admin)]
    public async Task<IActionResult> Clear([FromBody] ClearRequest request, CancellationToken cancellationToken)
    {
        if (request is null || (!request.Tuning && !request.Cache && !request.ScannerRecord)) return BadRequest(new { error = "Nothing chosen to clear." });
        if (request.Tuning || request.Cache)
        {
            var error = request.Tuning ? _tuning.ClearHistory(request.Cache) : _tuning.ClearCache();
            if (error is not null) return Conflict(new { error });
        }
        if (request.ScannerRecord) await _scannerLog.ClearAsync(cancellationToken);
        return Ok(new { cleared = request });
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
    /// the day's allowance from the live app. backgroundCalls is how many of those were background calls (every request a
    /// tuning job makes is one), which the job reads before and after itself so its result can say how many Dhan calls it
    /// caused as a measured number rather than an estimate.</summary>
    [HttpGet("dhan-usage")]
    public IActionResult DhanUsage()
    {
        var (day, calls, backgroundCalls, limit) = _dhanLimiter.Usage();
        // bySource: today's calls by Dhan endpoint and by who made them (page route / scanner runner / tuning job /
        // background service) - where the calls are going.
        var bySource = _dhanLimiter.UsageBySource().Select(x => new { endpoint = x.Endpoint, source = x.Source, calls = x.Calls });
        return Ok(new { day = day.ToString("yyyy-MM-dd"), calls, backgroundCalls, dailyLimit = limit, bySource });
    }

    /// <summary>GET /api/strategy-tuning/history - every tuning run kept (runs.csv), newest first: when, which index,
    /// what was tuned, how many days and trades. The Trades page lists these and reads the ones picked.</summary>
    [HttpGet("history")]
    public IActionResult History() => Ok(_tuning.HistoryRuns());

    /// <summary>GET /api/strategy-tuning/history/{runId}/{kind} - one run's trades, settings or days (kind: trades, settings, days)
    /// as rows; `?format=csv` downloads the CSV file itself.</summary>
    [HttpGet("history/{runId}/{kind}")]
    public IActionResult HistoryFile(string runId, string kind, [FromQuery] string? format = null)
    {
        if (string.Equals(format, "csv", StringComparison.OrdinalIgnoreCase))
            return _tuning.HistoryPath(runId, kind) is { } path
                ? File(System.IO.File.ReadAllBytes(path), "text/csv", $"{runId}-{kind}.csv")
                : NotFound(new { error = $"No {kind} for run {runId}." });
        return _tuning.HistoryRows(runId, kind) is { } rows ? Ok(rows) : NotFound(new { error = $"No {kind} for run {runId}." });
    }

    /// <summary>GET /api/strategy-tuning/result/{underlying} - the last finished job for that index.</summary>
    [HttpGet("result/{underlying}")]
    public IActionResult Result(string underlying, [FromQuery] string? data = null)
    {
        var d = string.Equals(data, "spot", StringComparison.OrdinalIgnoreCase) ? "spot" : "futures";
        return _tuning.Result(underlying, d) is { } r ? Ok(r) : NotFound(new { error = $"No {(d == "spot" ? "spot + options " : "")}tuning result for {underlying.ToUpperInvariant()} yet." });
    }
}

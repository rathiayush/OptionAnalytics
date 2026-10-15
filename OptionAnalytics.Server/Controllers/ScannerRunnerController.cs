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
    private readonly TradeSettingsStore _trade;
    private readonly ServerLiveService _live;
    private readonly LiveListService _list;
    private readonly ScannerEvents? _events;

    public ScannerRunnerController(ScannerRunnerStore store, TradeSettingsStore trade, ServerLiveService live, LiveListService list, ScannerEvents? events = null)
    {
        _store = store;
        _trade = trade;
        _live = live;
        _list = list;
        _events = events;
    }

    /// <summary>GET /api/scanner-runner/config - the runner reads it every minute; the page shows it. The
    /// scanner settings synced from the Order Flow page, with each index's trade settings
    /// (trade-settings.csv) on top: whether it is scanned, its lots, SL / target / trail and what it trades.</summary>
    [HttpGet("config")]
    [Authorize(Roles = $"{AuthRoles.Admin},{ScannerRunnerKey.Role}")]
    public IActionResult GetConfig() => Ok(WithTradeSettings(_store.Config()));

    private JsonObject WithTradeSettings(JsonObject config)
    {
        var enabled = new JsonObject();
        var levels = new JsonObject();
        var trade = new JsonObject();
        var live = new JsonObject();
        var now = DateTimeOffset.UtcNow;
        foreach (var s in _trade.All())
        {
            enabled[s.Underlying] = s.ScannerEnabled;
            // sl / target / trail: a manual trade's; maxSl / maxTarget: the max rules every strategy's trade is held to.
            levels[s.Underlying] = new JsonObject { ["sl"] = s.SlPoints, ["target"] = s.TargetPoints, ["trailStart"] = s.TrailStart, ["trailGap"] = s.TrailGap, ["maxSl"] = s.MaxSl, ["maxTarget"] = s.MaxTarget };
            trade[s.Underlying] = new JsonObject { ["lots"] = s.Lots, ["autoTrade"] = s.AutoTrade, ["slippage"] = s.SlippagePoints };
            // Switched to Live today (ServerLiveService): the scanner asks the server to place each alert's order.
            live[s.Underlying] = _live.IsLive(s.Underlying, now);
        }
        config["live"] = live;
        // Each index's live list, best first (LiveListService) - the scanner takes the better-proven of two
        // signals in the same moment first; the server checks the list itself on every order.
        var lists = new JsonObject();
        foreach (var (u, entries) in _list.Lists())
            lists[u] = new JsonArray(entries.Where(e => e.OnList).Select(e => (JsonNode)JsonValue.Create(e.StrategyId)!).ToArray());
        config["liveList"] = lists;
        config["enabled"] = enabled;
        config["levels"] = levels;
        config["trade"] = trade;
        return config;
    }

    /// <summary>PUT /api/scanner-runner/config - an admin's page saves its scanner settings (and per-index SL /
    /// target levels) here as they change, and switches indices on / off. Only the keys sent change.</summary>
    [HttpPut("config")]
    [Authorize(Roles = AuthRoles.Admin)]
    [RequestSizeLimit(200_000)]
    public IActionResult PutConfig([FromBody] JsonObject patch)
    {
        if (patch is null) return BadRequest(new { error = "No body." });
        var allowed = new HashSet<string> { "settings", "levels", "enabled", "alertIds", "profileAlerts" };
        var unknown = patch.Select(kv => kv.Key).Where(k => !allowed.Contains(k)).ToList();
        if (unknown.Count > 0) return BadRequest(new { error = $"Unknown keys: {string.Join(", ", unknown)}" });
        // Which indices the server scans lives with the rest of each index's trade settings.
        if (patch["enabled"] is JsonObject enabledPatch)
        {
            foreach (var (u, v) in enabledPatch)
            {
                if (v is null || !TradeSettingsStore.Underlyings.Contains(u)) continue;
                _trade.Save(u, _trade.Get(u) with { ScannerEnabled = v.GetValue<bool>() });
            }
            patch.Remove("enabled");
        }
        // The SL / target levels too: trade-settings.csv is the one place they are kept.
        patch.Remove("levels");
        return Ok(WithTradeSettings(_store.Update(patch)));
    }

    /// <summary>POST /api/scanner-runner/reconcile - an admin asks the scanner to close out the past days it left open:
    /// the signals still showing "open" with no exit, and the paper trades still running. The scanner reads the ask with
    /// its config (so within a minute), re-reads each of those days' own minutes, judges every signal and closes every
    /// trade on them, and posts the day's record again. It reports what it did in its status (reconcile).</summary>
    [HttpPost("reconcile")]
    [Authorize(Roles = AuthRoles.Admin)]
    public IActionResult Reconcile([FromBody] ReconcileRequest? request) =>
        Ok(WithTradeSettings(_store.AskReconcile(request?.Days ?? 7, User.Identity?.Name)));

    /// <summary>POST /api/scanner-runner/status - the runner's heartbeat (per index: last look, signals, paper trades) - on to
    /// the open pages at once when its trades or P&amp;L changed (ScannerEvents).</summary>
    [HttpPost("status")]
    [Authorize(Roles = ScannerRunnerKey.Role)]
    [RequestSizeLimit(2_000_000)]
    public IActionResult PostStatus([FromBody] JsonNode status)
    {
        if (status is null) return BadRequest();
        _store.SetStatus(status);
        _events?.Status(status, _store.Status());
        return Ok();
    }

    // ---- Live trading by the server scanner (ServerLiveService) ------------------------------------------

    /// <summary>GET /api/scanner-runner/live - per index: Live today or paper, its limits, today's live trades.</summary>
    [HttpGet("live")]
    [Authorize(Roles = $"{AuthRoles.Admin},{ScannerRunnerKey.Role}")]
    public IActionResult GetLive() => Ok(_live.Status(DateTimeOffset.UtcNow));

    /// <summary>PUT /api/scanner-runner/live/{underlying} - an admin switches an index to Live for today, or back to paper,
    /// and sets its max live trades / max loss.</summary>
    [HttpPut("live/{underlying}")]
    [Authorize(Roles = AuthRoles.Admin)]
    public IActionResult SetLive(string underlying, [FromBody] ServerLiveSetRequest request)
    {
        if (request is null) return BadRequest(new { error = "No body." });
        var error = _live.Set(underlying, request.Live, request.MaxTrades, request.MaxLoss, User.Identity?.Name, DateTimeOffset.UtcNow);
        return error is null ? Ok(_live.Status(DateTimeOffset.UtcNow)) : BadRequest(new { error });
    }

    /// <summary>POST /api/scanner-runner/live/{underlying}/order - the scanner's alert, as a live order. Only the
    /// scanner calls it; every limit is checked here (ServerLiveService), not trusted to the scanner.</summary>
    [HttpPost("live/{underlying}/order")]
    [Authorize(Roles = ScannerRunnerKey.Role)]
    public async Task<IActionResult> LiveOrder(string underlying, [FromBody] ServerLiveOrderRequest request, CancellationToken cancellationToken)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.Key)) return BadRequest(new { error = "No order." });
        return Ok(await _live.PlaceAsync(underlying, request, DateTimeOffset.UtcNow, cancellationToken));
    }

    /// <summary>POST /api/scanner-runner/live/{underlying}/index-stop - the trade's trailing stop moved its index stop-loss
    /// (only ever tighter); the server's own check exits on it.</summary>
    [HttpPost("live/{underlying}/index-stop")]
    [Authorize(Roles = ScannerRunnerKey.Role)]
    public IActionResult LiveIndexStop(string underlying, [FromBody] ServerLiveStopRequest request) =>
        request is null || string.IsNullOrWhiteSpace(request.Key) ? BadRequest(new { error = "No trade." })
            : _live.MoveIndexStop(underlying, request.Key, request.Stop) ? Ok() : NotFound(new { error = "No such open live trade." });

    /// <summary>POST /api/scanner-runner/live/{underlying}/levels - the strategy moved an open live trade's option SL /
    /// target: its Dhan legs follow (held to the index's max rules).</summary>
    [HttpPost("live/{underlying}/levels")]
    [Authorize(Roles = ScannerRunnerKey.Role)]
    public async Task<IActionResult> LiveLevels(string underlying, [FromBody] ServerLiveLegsRequest request, CancellationToken cancellationToken)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.Key)) return BadRequest(new { error = "No trade." });
        var result = await _live.MoveLegsAsync(underlying, request.Key, request.StopLossPoints, request.TargetPoints, DateTimeOffset.UtcNow, cancellationToken);
        return result.Success ? Ok(result) : UnprocessableEntity(result);
    }

    /// <summary>POST /api/scanner-runner/live/{underlying}/exit - the scanner closed a live trade.</summary>
    [HttpPost("live/{underlying}/exit")]
    [Authorize(Roles = ScannerRunnerKey.Role)]
    public async Task<IActionResult> LiveExit(string underlying, [FromBody] ServerLiveExitRequest request, CancellationToken cancellationToken)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.Key)) return BadRequest(new { error = "No trade." });
        var result = await _live.ExitAsync(underlying, request.Key, request.Reason, request.Pnl, DateTimeOffset.UtcNow, cancellationToken);
        return result.Success ? Ok(result) : UnprocessableEntity(result);
    }

    /// <summary>PUT /api/scanner-runner/applied/{underlying}/{strategyId} - a fine-tuned setting applied to one strategy
    /// for ONE index (body { filters: {...} }, or { filters: null } to go back to its all-index filters).</summary>
    [HttpPut("applied/{underlying}/{strategyId}")]
    [Authorize(Roles = AuthRoles.Admin)]
    [RequestSizeLimit(50_000)]
    public IActionResult SetApplied(string underlying, string strategyId, [FromBody] JsonObject body)
    {
        var u = underlying.Trim().ToUpperInvariant();
        if (!TradeSettingsStore.Underlyings.Contains(u)) return BadRequest(new { error = $"Unknown index {underlying}." });
        if (strategyId.Length is 0 or > 64 || !strategyId.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '-'))
            return BadRequest(new { error = "Bad strategy id." });
        if (body is null || !body.ContainsKey("filters")) return BadRequest(new { error = "Send { filters: {...} } or { filters: null }." });
        var filters = body["filters"];
        if (filters is not null and not JsonObject) return BadRequest(new { error = "filters must be an object or null." });
        return Ok(WithTradeSettings(_store.SetIndexFilters(u, strategyId, filters as JsonObject)));
    }

    /// <summary>GET /api/scanner-runner/live-list - per index: every strategy with its tuning record (after costs) and live
    /// record, whether it is on the live list and why; plus the rules.</summary>
    [HttpGet("live-list")]
    [Authorize(Roles = AuthRoles.Admin)]
    public IActionResult GetLiveList() => Ok(new { rules = _list.Rules(), lists = _list.Lists() });

    /// <summary>PUT /api/scanner-runner/live-list - change the rules, or put a strategy on / off an index's list by hand
    /// (mode include / exclude / auto).</summary>
    [HttpPut("live-list")]
    [Authorize(Roles = AuthRoles.Admin)]
    public IActionResult SetLiveList([FromBody] LiveListSetRequest request)
    {
        if (request is null) return BadRequest(new { error = "No body." });
        var error = _list.Set(request.Rules, request.Underlying, request.StrategyId, request.Mode);
        return error is null ? Ok(new { rules = _list.Rules(), lists = _list.Lists() }) : BadRequest(new { error });
    }

    /// <summary>GET /api/scanner-runner/learning - what the live signals teach (LearningReport): per index and strategy,
    /// which order-flow conditions at the signal went with winning trades, from both scanner records.</summary>
    [HttpGet("learning")]
    [Authorize(Roles = AuthRoles.Admin)]
    public IActionResult Learning([FromServices] ScannerLogStore log)
    {
        var rows = new[] { "server-signals", "signals" }.Select(k => log.PathOf(k)).Where(p => p is not null)
            .SelectMany(p => ScannerLogStore.Read(p!)).ToList();
        return Ok(new { minSignals = LearningReport.MinSignals, minLiftR = LearningReport.MinLiftR, strategies = LearningReport.Build(rows) });
    }

    /// <summary>GET /api/scanner-runner/status - whether it is running and what it last reported.</summary>
    [HttpGet("status")]
    public IActionResult GetStatus() => Ok(_store.Status());
}

/// <summary>How many days back to look for a day the scanner never finished (1 - 60; 7 by default).</summary>
public sealed record ReconcileRequest(int? Days);

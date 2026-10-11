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

    public ScannerRunnerController(ScannerRunnerStore store, TradeSettingsStore trade, ServerLiveService live, LiveListService list)
    {
        _store = store;
        _trade = trade;
        _live = live;
        _list = list;
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
            levels[s.Underlying] = new JsonObject { ["sl"] = s.SlPoints, ["target"] = s.TargetPoints, ["trailStart"] = s.TrailStart, ["trailGap"] = s.TrailGap };
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

    /// <summary>POST /api/scanner-runner/live/{underlying}/exit - the scanner closed a live trade.</summary>
    [HttpPost("live/{underlying}/exit")]
    [Authorize(Roles = ScannerRunnerKey.Role)]
    public async Task<IActionResult> LiveExit(string underlying, [FromBody] ServerLiveExitRequest request, CancellationToken cancellationToken)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.Key)) return BadRequest(new { error = "No trade." });
        var result = await _live.ExitAsync(underlying, request.Key, request.Reason, request.Pnl, DateTimeOffset.UtcNow, cancellationToken);
        return result.Success ? Ok(result) : UnprocessableEntity(result);
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

    /// <summary>GET /api/scanner-runner/status - whether it is running and what it last reported.</summary>
    [HttpGet("status")]
    public IActionResult GetStatus() => Ok(_store.Status());
}

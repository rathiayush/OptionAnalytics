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

    public ScannerRunnerController(ScannerRunnerStore store, TradeSettingsStore trade)
    {
        _store = store;
        _trade = trade;
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
        foreach (var s in _trade.All())
        {
            enabled[s.Underlying] = s.ScannerEnabled;
            levels[s.Underlying] = new JsonObject { ["sl"] = s.SlPoints, ["target"] = s.TargetPoints, ["trailStart"] = s.TrailStart, ["trailGap"] = s.TrailGap };
            trade[s.Underlying] = new JsonObject { ["lots"] = s.Lots, ["autoTrade"] = s.AutoTrade, ["slippage"] = s.SlippagePoints };
        }
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

    /// <summary>GET /api/scanner-runner/status - whether it is running and what it last reported.</summary>
    [HttpGet("status")]
    public IActionResult GetStatus() => Ok(_store.Status());
}

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>The trade settings per index (TradeSettingsStore - trade-settings.csv on the server): read by every
/// page and the server scanner, changed by an admin (the Trade settings page, or any SL / target / lots box).</summary>
[ApiController]
[Route("api/trade-settings")]
public sealed class TradeSettingsController : ControllerBase
{
    private readonly TradeSettingsStore _store;

    public TradeSettingsController(TradeSettingsStore store) => _store = store;

    /// <summary>GET /api/trade-settings - every index's settings (the file is created with defaults if missing).</summary>
    [HttpGet]
    public IActionResult Get() => Ok(new { settings = _store.All(), file = Path.GetFileName(_store.FilePath) });

    /// <summary>PUT /api/trade-settings/{underlying} - saves one index's settings.</summary>
    [HttpPut("{underlying}")]
    [Authorize(Roles = AuthRoles.Admin)]
    public IActionResult Put(string underlying, [FromBody] TradeSettings request)
    {
        if (request is null) return BadRequest(new { error = "No body." });
        var (saved, error) = _store.Save(underlying, request);
        return error is null ? Ok(saved) : BadRequest(new { error });
    }
}

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>The daily loss limit and kill switch (KillSwitchService, RiskSettingsStore - risk-settings.csv):
/// shown on the Trade settings page, changed there by an admin once a day.</summary>
[ApiController]
[Route("api/risk")]
public sealed class RiskController : ControllerBase
{
    private readonly RiskSettingsStore _store;
    private readonly KillSwitchService _killSwitch;
    private readonly ILogger<RiskController> _logger;

    public RiskController(RiskSettingsStore store, KillSwitchService killSwitch, ILogger<RiskController> logger)
    {
        _store = store;
        _killSwitch = killSwitch;
        _logger = logger;
    }

    /// <summary>GET /api/risk - the limit, whether it can still be changed today, today's P&L and what is set on Dhan.</summary>
    [HttpGet]
    public KillSwitchStatus Get() => _killSwitch.Status();

    public sealed record ChangeRequest(decimal DailyLossLimit, bool Enabled);

    /// <summary>PUT /api/risk - changes the limit / switches it on or off; once per IST day.</summary>
    [HttpPut]
    [Authorize(Roles = AuthRoles.Admin)]
    public IActionResult Put([FromBody] ChangeRequest request)
    {
        if (request is null) return BadRequest(new { error = "No body." });
        var (saved, error) = _store.Change(request.DailyLossLimit, request.Enabled, IstClock.Today());
        if (error is not null) return BadRequest(new { error });
        _logger.LogWarning("{User} set the daily loss limit to {Limit} ({State}).", User.Identity?.Name, saved!.DailyLossLimit, saved.Enabled ? "on" : "off");
        return Ok(_killSwitch.Status());
    }
}

using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>GET /api/alerts - recent spot+ATM-option confluence alerts (see
/// ConfluenceAlertService), most recent first. Not underlying-scoped since the frontend shows one
/// combined feed across NIFTY and BANKNIFTY; a page load or Refresh click needs this to see
/// anything that fired before the tab was open, since SignalR's "confluenceAlert" push only
/// reaches a tab that's already connected.</summary>
[ApiController]
[Route("api/alerts")]
public sealed class AlertsController : ControllerBase
{
    private readonly ConfluenceAlertService _alerts;
    private readonly AlertModeStore _alertMode;

    public AlertsController(ConfluenceAlertService alerts, AlertModeStore alertMode)
    {
        _alerts = alerts;
        _alertMode = alertMode;
    }

    [HttpGet]
    public IActionResult GetRecent() => Ok(_alerts.GetRecentAlerts());

    /// <summary>Every underlying's CURRENT spot/ATM-CE/ATM-PE bias right now (see
    /// ConfluenceAlertService.GetCurrentStates) - a live snapshot, not history.</summary>
    [HttpGet("state")]
    public IActionResult GetState() => Ok(_alerts.GetCurrentStates());

    /// <summary>Whether EmaCrossoverAlertService/ConfluenceAlertService also re-check the still-
    /// forming candle ("Live") or only ever react to a closed, close-confirmed one
    /// ("ClosedConfirmed") - see AlertModeStore's own doc comment. One shared, app-wide setting,
    /// not per-browser: every viewer's dashboard toggle reads and writes this same value, since
    /// both underlyings' Telegram alerts go to the one shared chat regardless of who set it.</summary>
    [HttpGet("mode")]
    public IActionResult GetMode() => Ok(new { mode = _alertMode.Mode });

    /// <summary>Sets the shared alert mode. 400 if 'mode' isn't one of AlertModeStore.Live/
    /// ClosedConfirmed.</summary>
    [HttpPost("mode")]
    public IActionResult SetMode([FromBody] SetAlertModeRequest? request)
    {
        if (!_alertMode.TrySet(request?.Mode))
            return BadRequest(new { error = $"'mode' must be '{AlertModeStore.Live}' or '{AlertModeStore.ClosedConfirmed}'." });

        return Ok(new { mode = _alertMode.Mode });
    }

    public sealed record SetAlertModeRequest(string? Mode);
}

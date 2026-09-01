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

    public AlertsController(ConfluenceAlertService alerts)
    {
        _alerts = alerts;
    }

    [HttpGet]
    public IActionResult GetRecent() => Ok(_alerts.GetRecentAlerts());
}

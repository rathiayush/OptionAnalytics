using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Services.OrderFlow;

namespace OptionAnalytics.Server.Controllers;

/// <summary>The thresholds of the server's iceberg / big order Telegram per index (OrderFlowTelegramAlerts): GET for Admin
/// and User (the Order Flow page shows them), PUT for an Admin only. 0 lots = not sent for that index.</summary>
[ApiController]
[Route("api/order-flow-alerts")]
[Authorize(Roles = $"{AuthRoles.Admin},{AuthRoles.User}")]
public sealed class OrderFlowAlertsController : ControllerBase
{
    private readonly OrderFlowAlertSettingsStore _store;

    public OrderFlowAlertsController(OrderFlowAlertSettingsStore store) => _store = store;

    [HttpGet]
    public IActionResult Get() => Ok(_store.All());

    [HttpPut("{underlying}")]
    [Authorize(Roles = AuthRoles.Admin)]
    public IActionResult Put(string underlying, [FromBody] OrderFlowAlertRequest request)
    {
        var (saved, error) = _store.Save(underlying, request?.IcebergLots ?? -1, request?.BigOrderLots ?? -1);
        return saved is null ? BadRequest(new { error }) : Ok(saved);
    }
}

public sealed record OrderFlowAlertRequest(int IcebergLots, int BigOrderLots);

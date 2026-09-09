using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>CRUD for the saved strategy triggers the Triggers page manages - see
/// StrategyTriggerStore for what a trigger is and StrategyTriggerHostedService for what watches
/// them. A trigger takes the same inputs a Backtrack run does, so a rule tuned there can be armed
/// here unchanged.
///
/// Admin-only: this is where live trading gets armed/disarmed and real orders get a quantity and a
/// SlippagePoints, so the whole controller is gated rather than picking individual actions -
/// unlike CdvController, nothing here is also needed by a non-admin page.</summary>
[ApiController]
[Route("api/triggers")]
[Authorize(Roles = AuthRoles.Admin)]
public sealed class TriggersController : ControllerBase
{
    private readonly StrategyTriggerStore _store;
    private readonly TriggerOrderHistoryStore _orderHistory;

    public TriggersController(StrategyTriggerStore store, TriggerOrderHistoryStore orderHistory)
    {
        _store = store;
        _orderHistory = orderHistory;
    }

    [HttpGet]
    public IActionResult GetAll() => Ok(_store.GetAll());

    /// <summary>Every order-pipeline outcome (placed/filled/failed/cancelled/skipped/...) any trigger
    /// has produced, most recent first - the same text each one already sent to Telegram via
    /// StrategyTriggerHostedService.NotifyFollowUpAsync, kept here so the page can show "what
    /// actually happened" without depending on catching that message. ?triggerId= filters to one
    /// trigger; ?limit= caps how many rows come back (default 100, capped at 500 - this is a recent-
    /// activity feed, not an export).</summary>
    [HttpGet("orders")]
    public IActionResult GetOrderHistory([FromQuery] string? triggerId, [FromQuery] int limit = 100) =>
        Ok(_orderHistory.GetRecent(triggerId, Math.Clamp(limit <= 0 ? 100 : limit, 1, 500)));

    [HttpPost]
    public IActionResult Create([FromBody] StrategyTriggerRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Underlying)) return BadRequest(new { error = "Underlying is required." });
        if (string.IsNullOrWhiteSpace(request.StrategyKey)) return BadRequest(new { error = "StrategyKey is required." });

        return Ok(_store.Create(request));
    }

    [HttpPut("{id}")]
    public IActionResult Update(string id, [FromBody] StrategyTriggerRequest request)
    {
        var updated = _store.Update(id, request);
        return updated is null ? NotFound(new { error = $"No trigger '{id}'." }) : Ok(updated);
    }

    [HttpDelete("{id}")]
    public IActionResult Delete(string id) =>
        _store.Delete(id) ? Ok(new { deleted = id }) : NotFound(new { error = $"No trigger '{id}'." });
}

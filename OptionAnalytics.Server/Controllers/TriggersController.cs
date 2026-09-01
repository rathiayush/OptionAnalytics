using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>CRUD for the saved strategy triggers the Triggers page manages - see
/// StrategyTriggerStore for what a trigger is and StrategyTriggerHostedService for what watches
/// them. A trigger takes the same inputs a Backtrack run does, so a rule tuned there can be armed
/// here unchanged.</summary>
[ApiController]
[Route("api/triggers")]
public sealed class TriggersController : ControllerBase
{
    private readonly StrategyTriggerStore _store;

    public TriggersController(StrategyTriggerStore store)
    {
        _store = store;
    }

    [HttpGet]
    public IActionResult GetAll() => Ok(_store.GetAll());

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

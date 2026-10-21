using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>OI Replay's paper positions for the signed-in account and an IST day (PaperPositionStore) - the same in every
/// browser the account opens. The page polls GET and sends each change with POST.</summary>
[ApiController]
[Route("api/paper-positions")]
[Authorize(Roles = $"{AuthRoles.Admin},{AuthRoles.User}")]
public sealed class PaperPositionsController : ControllerBase
{
    private readonly PaperPositionStore _store;

    public PaperPositionsController(PaperPositionStore store) => _store = store;

    private string Account => User.Identity?.Name ?? "";

    /// <summary>GET /api/paper-positions?date=yyyy-MM-dd (today when omitted) - the day's positions and version.</summary>
    [HttpGet]
    public IActionResult Get([FromQuery] DateOnly? date) => Ok(_store.Get(Account, date ?? IstClock.Today()));

    /// <summary>POST /api/paper-positions?date=yyyy-MM-dd - { upsert: [position...], remove: [id...], clear } - returns the day after it.</summary>
    [HttpPost]
    public IActionResult Post([FromQuery] DateOnly? date, [FromBody] PaperPositionChange? change)
    {
        if (change is null) return BadRequest(new { error = "No body." });
        var (result, error) = _store.Change(Account, date ?? IstClock.Today(), change.Upsert, change.Remove, change.Clear);
        return error is null ? Ok(result) : BadRequest(new { error });
    }
}

public sealed record PaperPositionChange(List<JsonObject>? Upsert, List<string>? Remove, bool Clear);

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>The signed-in account's page preferences (UserPreferencesStore) - the same in every browser it opens and
/// kept through restarts and deploys. The page reads them once when it starts or someone signs in, and sends each
/// change.</summary>
[ApiController]
[Route("api/preferences")]
[Authorize(Roles = $"{AuthRoles.Admin},{AuthRoles.User}")]
public sealed class PreferencesController : ControllerBase
{
    private readonly UserPreferencesStore _store;

    public PreferencesController(UserPreferencesStore store) => _store = store;

    private string Account => User.Identity?.Name ?? "";

    /// <summary>GET /api/preferences - { version, values: { key: text } }.</summary>
    [HttpGet]
    public IActionResult Get() => Ok(_store.Get(Account));

    /// <summary>PUT /api/preferences - { values: { key: text, or null to remove it } } - returns them after it.</summary>
    [HttpPut]
    public IActionResult Put([FromBody] PreferencesChange? change)
    {
        var (result, error) = _store.Change(Account, change?.Values);
        return error is null ? Ok(result) : BadRequest(new { error });
    }
}

public sealed record PreferencesChange(Dictionary<string, string?>? Values);

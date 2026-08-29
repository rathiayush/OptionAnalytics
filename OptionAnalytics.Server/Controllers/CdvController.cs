using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

[ApiController]
[Route("api/cdv")]
public sealed class CdvController : ControllerBase
{
    private readonly CdvHostedService _cdv;

    public CdvController(CdvHostedService cdv)
    {
        _cdv = cdv;
    }

    [HttpGet("{underlying}/series")]
    public IActionResult GetSeries(string underlying)
    {
        if (!_cdv.States.TryGetValue(underlying.ToUpperInvariant(), out var state))
            return NotFound(new { error = $"Unknown underlying '{underlying}'." });

        return Ok(state.GetSeries());
    }

    [HttpGet("{underlying}/snapshot")]
    public IActionResult GetSnapshot(string underlying)
    {
        if (!_cdv.States.TryGetValue(underlying.ToUpperInvariant(), out var state))
            return NotFound(new { error = $"Unknown underlying '{underlying}'." });

        return Ok(state.ToSnapshot());
    }
}

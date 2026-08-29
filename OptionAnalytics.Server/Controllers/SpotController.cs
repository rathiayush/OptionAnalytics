using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

[ApiController]
[Route("api/spot")]
public sealed class SpotController : ControllerBase
{
    private readonly SpotFeedHostedService _feed;

    public SpotController(SpotFeedHostedService feed)
    {
        _feed = feed;
    }

    /// <summary>The underlyings this app charts, and the strike step each one's spot price is
    /// rounded to - drives the dropdown on the frontend.</summary>
    [HttpGet("underlyings")]
    public IActionResult GetUnderlyings() =>
        Ok(_feed.States.Values.Select(s => new { underlying = s.Underlying, step = s.Step }));

    [HttpGet("{underlying}/candles")]
    public IActionResult GetCandles(string underlying)
    {
        if (!_feed.States.TryGetValue(underlying.ToUpperInvariant(), out var state))
            return NotFound(new { error = $"Unknown underlying '{underlying}'." });

        return Ok(state.GetCandles());
    }

    [HttpGet("{underlying}/snapshot")]
    public IActionResult GetSnapshot(string underlying)
    {
        if (!_feed.States.TryGetValue(underlying.ToUpperInvariant(), out var state))
            return NotFound(new { error = $"Unknown underlying '{underlying}'." });

        return Ok(state.ToSnapshot());
    }
}

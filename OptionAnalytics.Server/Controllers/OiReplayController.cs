using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>Backs the OI Replay page - see OiReplayService's own doc comment for why this endpoint
/// never makes a live Dhan call under any circumstance, unlike Expired Backtest.</summary>
[ApiController]
[Route("api/oi-replay")]
public sealed class OiReplayController : ControllerBase
{
    private readonly OiReplayService _service;

    public OiReplayController(OiReplayService service)
    {
        _service = service;
    }

    /// <summary>One full day's worth of spot candles (already aggregated to timeframeMinutes) plus
    /// the same day's CE/PE OI/IV history across the fetched strike band, in one response - the
    /// frontend plays it back candle by candle itself, with no further request per tick.</summary>
    [HttpGet("{underlying}/run")]
    public async Task<ActionResult> Run(
        string underlying,
        [FromQuery] DateOnly date,
        [FromQuery] int timeframeMinutes,
        [FromQuery] string expiryFlag,
        CancellationToken cancellationToken)
    {
        var result = await _service.RunAsync(underlying.ToUpperInvariant(), date, timeframeMinutes, expiryFlag.ToUpperInvariant(), cancellationToken);
        return Ok(result);
    }
}

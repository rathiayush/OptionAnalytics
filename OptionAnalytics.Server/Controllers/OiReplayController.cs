using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>Backs the OI Replay page - see OiReplayService's own doc comment for when (and why)
/// this endpoint falls back to a live Dhan call at all, e.g. for replaying the current, still-
/// forming session (OiReplayOptions.AllowLiveDataFallback) - it otherwise stays stored-data-only.</summary>
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
        CancellationToken cancellationToken,
        // Defaults to false, preserving OI Replay's own existing stored-data-first behavior exactly -
        // only the Live OI Dashboard page passes true, for which stored-vs-live has no good default
        // (it only ever asks for today, and always wants the freshest reading available, in every
        // environment including local dev - see OiReplayService.RunAsync's own doc comment).
        [FromQuery] bool forceLive = false)
    {
        var result = await _service.RunAsync(underlying.ToUpperInvariant(), date, timeframeMinutes, expiryFlag.ToUpperInvariant(), cancellationToken, forceLive);
        return Ok(result);
    }
}

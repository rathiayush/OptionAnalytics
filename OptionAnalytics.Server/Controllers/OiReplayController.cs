using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Dhan;
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
    private readonly DhanOptionChainMaster _optionChainMaster;

    public OiReplayController(OiReplayService service, DhanOptionChainMaster optionChainMaster)
    {
        _service = service;
        _optionChainMaster = optionChainMaster;
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

    /// <summary>The REAL calendar date "Weekly"/"Monthly" each currently resolve to for this
    /// underlying - exposed so a picker can show the actual date instead of an ambiguous label, and
    /// so the two can be told apart even when they happen to be the SAME date (the final week before
    /// a monthly expiry - see OiReplayLiveFeedService.ResolveNearestExpiryCore's own doc comment for
    /// why that specific overlap used to silently resolve to the wrong, further-out contract).
    /// Either field is null when that flag isn't available at all for this underlying (e.g.
    /// BANKNIFTY has no weekly expiry) or nothing is currently listed.</summary>
    [HttpGet("{underlying}/expiries")]
    public async Task<IActionResult> GetExpiries(string underlying, CancellationToken cancellationToken)
    {
        await _optionChainMaster.EnsureLoadedAsync(cancellationToken);
        var listed = _optionChainMaster.GetExpiries(underlying.ToUpperInvariant()).Where(e => e >= IstClock.Today()).OrderBy(e => e).ToList();
        return Ok(new
        {
            week = OiReplayLiveFeedService.ResolveNearestExpiryCore(listed, "WEEK"),
            month = OiReplayLiveFeedService.ResolveNearestExpiryCore(listed, "MONTH"),
        });
    }
}

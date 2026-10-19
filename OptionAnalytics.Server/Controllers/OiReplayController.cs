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
    private readonly LiveOptionLegStore? _legs;

    public OiReplayController(OiReplayService service, DhanOptionChainMaster optionChainMaster, LiveOptionLegStore? legs = null)
    {
        _service = service;
        _optionChainMaster = optionChainMaster;
        _legs = legs;
    }

    /// <summary>Today's newest live reading of each option leg of one chain (index + expiry flag N1, N2 ...) - from
    /// the live feed's memory (LiveOptionLegStore), never a Dhan call, so a page can poll it freely. Empty before
    /// the feed has seen that chain today.</summary>
    [HttpGet("{underlying}/live-legs")]
    public ActionResult LiveLegs(string underlying, [FromQuery] string expiryFlag = "N1") =>
        Ok((_legs?.Latest(underlying.ToUpperInvariant(), expiryFlag.ToUpperInvariant(), IstClock.Today()) ?? Array.Empty<LiveOptionTick>())
            .Select(t => new { t.Strike, t.Side, t.Price, t.OpenInterest, t.Time }));

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
        // Defaults to false, preserving OI Replay's own stored-data-first behavior for a genuinely
        // past day - the frontend passes true whenever the requested date is TODAY (its own "Go
        // Live" mode), for which stored-vs-live has no good default: it's about to hand off to the
        // live tick feed anyway, so it always wants the freshest reading available, in every
        // environment including local dev - see OiReplayService.RunAsync's own doc comment.
        [FromQuery] bool forceLive = false)
    {
        var result = await _service.RunAsync(underlying.ToUpperInvariant(), date, timeframeMinutes, expiryFlag.ToUpperInvariant(), cancellationToken, forceLive);
        return Ok(result);
    }

    /// <summary>The previous trading day's volume profile (POC/VAH/VAL/HVN/LVN) relative to
    /// `date` - see OiReplayService.GetPreviousDayVolumeProfileAsync's own doc comment for exactly
    /// which day that resolves to and how each level is computed. `date` is whatever day the
    /// frontend is currently viewing (today's live session or a historical replay day alike), not
    /// the profile's own date - the response's own ProfileDate says which day was actually used.</summary>
    [HttpGet("{underlying}/previous-day-volume-profile")]
    public async Task<ActionResult> GetPreviousDayVolumeProfile(string underlying, [FromQuery] DateOnly date, CancellationToken cancellationToken)
    {
        var result = await _service.GetPreviousDayVolumeProfileAsync(underlying.ToUpperInvariant(), date, cancellationToken);
        return Ok(result);
    }

    /// <summary>The REAL calendar date "Weekly"/"Monthly" each currently resolve to for this
    /// underlying - exposed so a picker can show the actual date instead of an ambiguous label, and
    /// so the two can be told apart even when they happen to be the SAME date (the final week before
    /// a monthly expiry - see OiReplayLiveFeedService.ResolveNearestExpiryCore's own doc comment for
    /// why that specific overlap used to silently resolve to the wrong, further-out contract).
    /// Either field is null when that flag isn't available at all for this underlying (e.g.
    /// BANKNIFTY has no weekly expiry) or nothing is currently listed.
    ///
    /// expiries is the flat, ordered list backing OI Replay's own live-mode explicit expiry picker
    /// (the user's own "list active expiry and select from there" ask) - up to
    /// OiReplayLiveFeedService.PositionalExpiriesPerUnderlying dates, index i (0-based) here always
    /// matches flag "N{i+1}" (see ResolveNearestExpiryCore's own doc comment on that flag shape), so
    /// the frontend can join "c:{underlying}:N{i+1}" for whichever entry the user picks with no
    /// separate lookup needed.</summary>
    [HttpGet("{underlying}/expiries")]
    public async Task<IActionResult> GetExpiries(string underlying, CancellationToken cancellationToken)
    {
        await _optionChainMaster.EnsureLoadedAsync(cancellationToken);
        var listed = _optionChainMaster.GetExpiries(underlying.ToUpperInvariant()).Where(e => e >= IstClock.Today()).OrderBy(e => e).ToList();
        return Ok(new
        {
            week = OiReplayLiveFeedService.ResolveNearestExpiryCore(listed, "WEEK"),
            month = OiReplayLiveFeedService.ResolveNearestExpiryCore(listed, "MONTH"),
            expiries = listed.Take(OiReplayLiveFeedService.PositionalExpiriesPerUnderlying),
        });
    }
}

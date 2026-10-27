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
    private readonly LoadProgressStore? _progress;

    public OiReplayController(OiReplayService service, DhanOptionChainMaster optionChainMaster, LiveOptionLegStore? legs = null, LoadProgressStore? progress = null,
        OptionExpiryResolver? expiries = null)
    {
        _service = service;
        _optionChainMaster = optionChainMaster;
        _legs = legs;
        _progress = progress;
        _expiries = expiries;
    }

    private readonly OptionExpiryResolver? _expiries;

    // The options' expiry date for the GEX card - never a reason for the day's load to fail.
    private async Task<(DateOnly Date, string Source)?> ExpiryOrNullAsync(string underlying, DateOnly date, string expiryFlag, CancellationToken cancellationToken)
    {
        if (_expiries is null) return null;
        try { return await _expiries.ResolveAsync(underlying, date, expiryFlag, cancellationToken); }
        catch (Exception) when (!cancellationToken.IsCancellationRequested) { return null; }
    }

    /// <summary>What a day load started with ?progressId= is doing - the page polls this while it waits: series done of
    /// the total, how many came from disk or from Dhan, rate limits, retries and failures, and the log entries after
    /// the first <paramref name="since"/>.</summary>
    [HttpGet("progress/{id}")]
    public ActionResult Progress(string id, [FromQuery] int since = 0) =>
        _progress?.Get(id) is { } progress ? Ok(progress.Snapshot(since)) : NotFound();

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
        [FromQuery] bool forceLive = false,
        // The page's Clear cache: today's held backfill of this index is dropped and asked of Dhan afresh.
        [FromQuery] bool refresh = false,
        // Opt-in: skip the saved days (the Dhan day cache, the stored database), ask Dhan for the whole day afresh and write
        // what comes back over the cache - the OI Replay page's "Force fetch from Dhan".
        [FromQuery] bool forceFetch = false,
        // The page's own id for this load - its progress is then readable at GET progress/{id} while it runs.
        [FromQuery] string? progressId = null)
    {
        var progress = !string.IsNullOrWhiteSpace(progressId) && progressId.Length <= 64 ? _progress?.Start(progressId) : null;
        using var recording = LoadProgress.Use(progress);
        if (refresh) _service.RefreshToday(underlying);
        try
        {
            // The options' expiry (GEX's time to expiry) is looked up alongside the day.
            var expiry = ExpiryOrNullAsync(underlying, date, expiryFlag, cancellationToken);
            var result = await _service.RunAsync(underlying.ToUpperInvariant(), date, timeframeMinutes, expiryFlag.ToUpperInvariant(), cancellationToken, forceLive, forceFetch);
            if (result.Success && await expiry is { } found) result = result with { OptionExpiry = found.Date, OptionExpirySource = found.Source };
            progress?.Finish(result.Success ? null : result.Error);
            return Ok(result);
        }
        catch (Exception ex)
        {
            progress?.Finish(ex is OperationCanceledException ? "cancelled" : ex.Message);
            throw;
        }
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

    /// <summary>The previous trading day's 1-minute bars of the futures contract `expiry` (the chart's; omitted = that
    /// day's front month) before `date` - OI Replay's futures chart draws the previous session's volume profile from
    /// them (OiReplayService.GetPreviousDayFuturesAsync).</summary>
    [HttpGet("{underlying}/previous-day-futures")]
    public async Task<ActionResult> GetPreviousDayFutures(string underlying, [FromQuery] DateOnly date, [FromQuery] DateOnly? expiry, CancellationToken cancellationToken)
    {
        var result = await _service.GetPreviousDayFuturesAsync(underlying.ToUpperInvariant(), date, expiry, cancellationToken);
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

using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;
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
        // Defaults to false, preserving OI Replay's own stored-data-first behavior for a genuinely
        // past day - the frontend passes true whenever the requested date is TODAY (its own "Go
        // Live" mode), for which stored-vs-live has no good default: it's about to hand off to the
        // live tick feed anyway, so it always wants the freshest reading available, in every
        // environment including local dev - see OiReplayService.RunAsync's own doc comment.
        [FromQuery] bool forceLive = false,
        // Opt-in, default false, so this endpoint behaves for every existing caller (the OI Replay
        // page, the server scanner, the tuning job, Scan day) exactly as it always has: true instead
        // serves the SAME single day through the range path (GET .../range's own machinery), so the
        // tuning job can fetch one day both ways and compare them itself before trusting the fast
        // path for a whole job. See also .../range-check, which does that comparison server-side.
        [FromQuery] bool viaRange = false)
    {
        var underlyingKey = underlying.ToUpperInvariant();
        var flag = expiryFlag.ToUpperInvariant();
        if (!viaRange)
        {
            var result = await _service.RunAsync(underlyingKey, date, timeframeMinutes, flag, cancellationToken, forceLive);
            return Ok(result);
        }

        var range = await _service.RunRangeAsync(underlyingKey, date, date, timeframeMinutes, flag, cancellationToken);
        if (!range.Success) return Ok(OiReplayResult.Failed(underlyingKey, date, Math.Max(1, timeframeMinutes), range.Error ?? "The range fetch failed."));
        return Ok(range.Days.FirstOrDefault(d => d.Date == date)
            ?? OiReplayResult.Failed(underlyingKey, date, Math.Max(1, timeframeMinutes), $"The range fetch returned no day for {date:dd MMM yyyy}."));
    }

    /// <summary>EVERY trading day between from and to in one response, each day in the exact same
    /// shape .../run returns for a single day - so a caller (the strategy tuning job scanning months
    /// of history) builds its OI context from a day here with unchanged code, while the server fetches
    /// a whole expiry cycle of days per Dhan call instead of 42 calls per day. See
    /// OiReplayService.RunRangeAsync for what it refuses to do rather than risk (a window never
    /// crosses an expiry; a day a window cannot fully answer for is fetched the per-day way instead),
    /// and OiReplayRangeWindows.MaxRangeDays for the width cap - a wider range is refused with a
    /// clear message rather than silently trimmed, since Dhan itself serves at most 30 days per
    /// call.</summary>
    [HttpGet("{underlying}/range")]
    public async Task<ActionResult> Range(
        string underlying,
        [FromQuery] DateOnly from,
        [FromQuery] DateOnly to,
        [FromQuery] int timeframeMinutes,
        [FromQuery] string expiryFlag,
        CancellationToken cancellationToken,
        // Defaults to true, so every existing caller behaves exactly as before. false instead: a day no window could
        // answer for is returned as an unsuccessful day naming that, listed in unservedDays, and NO Dhan call is spent
        // on it inside this request - the caller fetches it through .../run itself. The strategy tuning job asks for
        // that, so one range request timing out can never throw away per-day calls already made inside it (and so the
        // calls it did make are split in the response: windowOptionSeriesCalls vs fallbackOptionSeriesCalls).
        [FromQuery] bool perDayFallback = true,
        // spanExpiries: ONE Dhan call per strike for the whole span (up to 31 days) straight across the expiries,
        // instead of one per expiry cycle - only for a caller that has the proof (.../range-span-check). spanFrom /
        // spanTo name that span when this request asks for a slice of it (the band is fetched once and kept a few
        // minutes); includeExpiryDays lets the expiry days come out of it too (otherwise they are per-day days).
        [FromQuery] bool spanExpiries = false,
        [FromQuery] bool includeExpiryDays = false,
        [FromQuery] DateOnly? spanFrom = null,
        [FromQuery] DateOnly? spanTo = null)
    {
        var result = await _service.RunRangeAsync(underlying.ToUpperInvariant(), from, to, timeframeMinutes, expiryFlag.ToUpperInvariant(), cancellationToken, perDayFallback,
            spanExpiries, includeExpiryDays, spanFrom, spanTo);
        // A refusal is the caller's own mistake to fix (too wide a range, an unsupported underlying,
        // a future date), so it answers 400 with the reason rather than a 200 nobody checks.
        return result.Success ? Ok(result) : BadRequest(result);
    }

    /// <summary>Fetches ONE day both ways - out of a real multi-day window and through the per-day
    /// path - and compares every OI point (strike, minute, open interest, premium, IV, the minute's
    /// own OHLC). The range endpoint's own proof, meant to be run before a long job leans on it: a
    /// caller that gets match=false should use .../run for the whole job. See
    /// OiReplayService.CheckDayAsync / OiReplayDayComparer.</summary>
    [HttpGet("{underlying}/range-check")]
    public async Task<ActionResult> RangeCheck(
        string underlying,
        [FromQuery] DateOnly date,
        [FromQuery] int timeframeMinutes,
        [FromQuery] string expiryFlag,
        CancellationToken cancellationToken)
    {
        var (comparison, windowFrom, windowTo, error) = await _service.CheckDayAsync(
            underlying.ToUpperInvariant(), date, timeframeMinutes, expiryFlag.ToUpperInvariant(), cancellationToken);
        return Ok(new
        {
            underlying = underlying.ToUpperInvariant(),
            date,
            windowFrom,
            windowTo,
            windowDays = windowTo.DayNumber - windowFrom.DayNumber + 1,
            // No comparison at all is NEVER reported as a pass: a caller that cannot be shown the two
            // fetches agreeing should stay on the per-day path.
            match = comparison?.Match ?? false,
            comparison,
            error,
        });
    }

    /// <summary>The proof behind .../range?spanExpiries=true: one window straight across a real expiry near
    /// `date`, and the day before it, the expiry day and the day after it each compared point for point with the
    /// per-day fetch (OiReplayService.CheckSpanAsync). acrossMatch=false: stay on per-cycle windows.</summary>
    [HttpGet("{underlying}/range-span-check")]
    public async Task<ActionResult> RangeSpanCheck(
        string underlying,
        [FromQuery] DateOnly date,
        [FromQuery] int timeframeMinutes,
        [FromQuery] string expiryFlag,
        CancellationToken cancellationToken) =>
        Ok(await _service.CheckSpanAsync(underlying.ToUpperInvariant(), date, timeframeMinutes, expiryFlag.ToUpperInvariant(), cancellationToken));

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

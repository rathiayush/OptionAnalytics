using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.TrueData;

namespace OptionAnalytics.Server.Controllers;

/// <summary>The Tick Flow page's data (TrueData's real-time ticks - TrueDataLiveFeed / TickBook): the exact footprint, the bubbles and
/// the best bid / ask trail per index. Its own - nothing of the Order Flow page's. Only registered while TrueData:Live:Enabled.
/// Admin / User; the External account never reaches it (deny by default).</summary>
[ApiController]
[Route("api/tick-flow")]
public sealed class TickFlowController : ControllerBase
{
    private readonly TrueDataLiveFeed? _feed;
    private readonly TickHistoryDays? _history;
    private readonly OptionTickHistoryDays? _optionHistory;
    private readonly TickDayDiskCache? _disk;

    public TickFlowController(IServiceProvider services)
    {
        _feed = services.GetService<TrueDataLiveFeed>();
        _history = services.GetService<TickHistoryDays>();
        _optionHistory = services.GetService<OptionTickHistoryDays>();
        _disk = services.GetService<TickDayDiskCache>();
    }

    [HttpGet("status")]
    public ActionResult Status() =>
        _feed is null
            ? Ok(new { enabled = false, state = "off", note = "TrueData:Live:Enabled is off or the TrueData login is not set (TrueData__UserId / TrueData__Password)." })
            : Ok(new { enabled = true, status = _feed.Snapshot() });

    /// <summary>HOW OFTEN THE FEED REALLY SENDS: per stream (a futures contract's trades and quotes, the options') the messages applied today, the rate over the last
    /// 10 s / 60 s, the busiest second, seconds with 1 / 2 / 3 / 4+ messages, the median gap and a verdict - tick by tick, or a snapshot about once a second.</summary>
    [HttpGet("rate")]
    public ActionResult Rate() =>
        _feed is null
            ? Ok(new { enabled = false })
            : Ok(new { enabled = true, state = _feed.Snapshot().State, now = DateTimeOffset.UtcNow, rates = _feed.Rates.Snapshot(DateTimeOffset.UtcNow) });

    /// <summary>The big option orders watched from TrueData's live ticks (the Tick Flow page's card): the option stream's state (the index, the
    /// expiry, the ATM, how many options are subscribed against the symbol cap, the ticks seen, why not) and the orders after <paramref name="since"/>.</summary>
    [HttpGet("options")]
    public ActionResult Options([FromQuery] long since = 0, [FromQuery] int limit = 1000) =>
        _feed is null
            ? Ok(new { enabled = false })
            : Ok(new { enabled = true, optionTicks = _feed.OptionTicksOn, options = _feed.OptionsSnapshot(), events = _feed.Watch.Since(since, Math.Clamp(limit, 1, 5000)) });

    /// <summary>The options' minute-by-minute flow (every tick's quantity on the side of the quote before it, and the premium's open / close) from
    /// <paramref name="since"/> (epoch ms of a minute; 0 = the whole day) - the Tick Flow page's Option CDV / OBV. Live only; memory, a new IST day starts empty.</summary>
    [HttpGet("options/flow")]
    public ActionResult OptionsFlow([FromQuery] long since = 0) =>
        _feed is null
            ? Ok(new { enabled = false })
            : Ok(new { enabled = true, optionTicks = _feed.OptionTicksOn, now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), rows = _feed.Watch.FlowSince(since) });

    /// <summary>The big option orders of a PAST day (replay), rebuilt from TrueData's tick history of the option contracts: the first ask starts the build in the
    /// background (state "loading", contracts done of total - ask again), then "ready" with every order of the day (the page cuts them at its clock) or "failed" with why.</summary>
    [HttpGet("options/day")]
    public ActionResult OptionsDay([FromQuery] string underlying, [FromQuery] DateOnly date, [FromQuery] int strikes = 10, [FromQuery] bool flow = false)
    {
        if (_feed is null || _optionHistory is null) return NotFound(new { error = "The TrueData live feed is off (TrueData:Live:Enabled)." });
        if (!_feed.OptionTicksOn) return NotFound(new { error = "Option tick processing is off (TrueData:Live:OptionTicks)." });
        var instrument = _feed.InstrumentFor(underlying);
        if (instrument is null) return NotFound(new { error = $"{underlying?.ToUpperInvariant()} is not streamed (TrueData:Live:Instruments)." });
        var s = _optionHistory.Request(instrument, date, strikes);
        return Ok(new { state = s.State, done = s.Done, total = s.Total, failed = s.Failed, error = s.Error, expiry = s.Expiry, step = s.Step, events = flow ? Array.Empty<BigOrderEvent>() : s.Events, flow = flow ? s.Flow : null });
    }

    public sealed record OptionsRequest(string? Underlying, int Strikes);

    /// <summary>Picks the index whose options are streamed ("" = none) and the strikes either side of the ATM. Admin only - it changes what the one
    /// TrueData login subscribes to (the trial allows 50 symbols); kept across a restart.</summary>
    [HttpPut("options")]
    [Microsoft.AspNetCore.Authorization.Authorize(Roles = AuthRoles.Admin)]
    public ActionResult SetOptions([FromBody] OptionsRequest request)
    {
        if (_feed is null) return NotFound(new { error = "The TrueData live feed is off (TrueData:Live:Enabled)." });
        if (!_feed.OptionTicksOn) return BadRequest(new { error = "Option tick processing is off (TrueData:Live:OptionTicks)." });
        return _feed.SetOptions(request.Underlying, request.Strikes)
            ? Ok(new { options = _feed.OptionsSnapshot() })
            : BadRequest(new { error = "That index is not streamed (TrueData:Live:Instruments)." });
    }

    public sealed record SourceRequest(string? Transport);

    /// <summary>Picks where the live ticks come from: "websocket" or "tcp" (TrueData's two streams). Admin only - it closes the open
    /// connection and reconnects through the other; the choice is kept across a restart.</summary>
    [HttpPut("source")]
    [Microsoft.AspNetCore.Authorization.Authorize(Roles = AuthRoles.Admin)]
    public ActionResult Source([FromBody] SourceRequest request)
    {
        if (_feed is null) return NotFound(new { error = "The TrueData live feed is off (TrueData:Live:Enabled)." });
        return _feed.SetTransport(request.Transport)
            ? Ok(new { transport = _feed.Transport })
            : BadRequest(new { error = "transport must be \"websocket\" or \"tcp\"." });
    }

    /// <summary>A past futures day as the profile cards read it: the 1-minute bars with their footprint rows at a 1-point row (the page regroups to its own
    /// row size) and the contract's lot size. Kept on disk once built.</summary>
    public sealed record FuturesProfileDay(int LotSize, decimal TickSize, IReadOnlyList<TickBar> Bars);

    /// <summary>A PAST day's futures footprint for the delta profiles / the delta and cumulative delta chart (and the "previous day" loads of them): from the disk
    /// when kept, else rebuilt from TrueData's tick history (<see cref="TickHistoryDays"/>) and kept. Past days only; NIFTY only for now.</summary>
    [HttpGet("{underlying}/profile-day")]
    public async Task<ActionResult<FuturesProfileDay>> ProfileDay(string underlying, [FromQuery] DateOnly date, CancellationToken cancellationToken = default)
    {
        if (_feed is null) return NotFound(new { error = "The TrueData live feed is off (TrueData:Live:Enabled)." });
        if (!TickDayDiskCache.Keeps(underlying)) return NotFound(new { error = $"Past-day profiles are NIFTY only for now ({underlying.ToUpperInvariant()} later)." });
        if (date >= IstClock.Today()) return BadRequest(new { error = "A past day only - today's profile is built from the live day." });
        var kept = _disk?.Read<FuturesProfileDay>("futures", underlying, date);
        if (kept is { Bars.Count: > 0 }) return kept;
        var instrument = _feed.InstrumentFor(underlying);
        if (instrument is null) return NotFound(new { error = $"{underlying.ToUpperInvariant()} is not streamed (TrueData:Live:Instruments)." });
        if (_history is null) return NotFound(new { error = "Replay needs TrueData's tick history." });
        var result = await _history.DayAsync(instrument, date, cancellationToken);
        if (result.Book is null) return NotFound(new { error = result.Error });
        var snapshot = result.Book.Snapshot(1, long.MaxValue, 1, 1);
        var day = new FuturesProfileDay(result.Book.LotSize, instrument.TickSize, snapshot.Bars);
        if (day.Bars.Count > 0) _disk?.Write("futures", underlying, date, day);
        return day;
    }

    /// <param name="rowSize">Price points per footprint row (0 = the contract's tick).</param>
    /// <param name="minBubbleLots">The smallest bubble returned, in lots (1 = every print).</param>
    /// <param name="date">A past day (yyyy-MM-dd) for REPLAY, rebuilt from TrueData's tick history; omitted or today = the live day. A
    /// replay asks for every bubble (maxBubbles up to 400 000) and the whole quote trail so the page can cut it at its clock.</param>
    [HttpGet("{underlying}")]
    public async Task<ActionResult<TickDay>> Get(string underlying, [FromQuery] DateOnly? date = null, [FromQuery] decimal rowSize = 1, [FromQuery] int minBubbleLots = 1,
        [FromQuery] int maxBubbles = 6000, [FromQuery] int maxQuotes = 6000, CancellationToken cancellationToken = default)
    {
        if (_feed is null) return NotFound(new { error = "The TrueData live feed is off (TrueData:Live:Enabled)." });
        var instrument = _feed.InstrumentFor(underlying);
        if (instrument is null) return NotFound(new { error = $"{underlying.ToUpperInvariant()} is not streamed (TrueData:Live:Instruments)." });
        TickBook? book;
        if (date is { } day && day != IstClock.Today())
        {
            var result = await _history!.DayAsync(instrument, day, cancellationToken);
            if (result.Book is null) return NotFound(new { error = result.Error });
            book = result.Book;
        }
        else book = _feed.BookFor(underlying);
        if (book is null) return NotFound(new { error = "Not streamed." });
        return book.Snapshot(Math.Clamp(rowSize, 0, 1000), Math.Max(1, minBubbleLots) * (long)book.LotSize, Math.Clamp(maxBubbles, 100, TickBook.MaxBubbles), Math.Clamp(maxQuotes, 100, 100_000));
    }
}

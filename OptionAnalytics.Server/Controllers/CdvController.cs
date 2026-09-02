using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Models;
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
    public IActionResult GetSeries(string underlying, [FromQuery] string? expiry)
    {
        if (!TryGetState(underlying, ParseExpiry(expiry), out var state)) return NotFoundResult(underlying);
        return Ok(state.GetSeries());
    }

    [HttpGet("{underlying}/snapshot")]
    public IActionResult GetSnapshot(string underlying, [FromQuery] string? expiry)
    {
        if (!TryGetState(underlying, ParseExpiry(expiry), out var state)) return NotFoundResult(underlying);
        return Ok(state.ToSnapshot());
    }

    [HttpGet("{underlying}/atm-ce/candles")]
    public IActionResult GetAtmCeCandles(string underlying, [FromQuery] string? expiry)
    {
        if (!TryGetState(underlying, ParseExpiry(expiry), out var state)) return NotFoundResult(underlying);
        return Ok(state.GetAtmCandles(isCall: true));
    }

    [HttpGet("{underlying}/atm-pe/candles")]
    public IActionResult GetAtmPeCandles(string underlying, [FromQuery] string? expiry)
    {
        if (!TryGetState(underlying, ParseExpiry(expiry), out var state)) return NotFoundResult(underlying);
        return Ok(state.GetAtmCandles(isCall: false));
    }

    /// <summary>The strikes the dashboard's option-chart picker offers around the current ATM, with
    /// live premium/OI merged in where Dhan's Option Chain API can supply it - see
    /// CdvHostedService.GetChainAsync. ?span=20 (the default) is how many strike steps either side
    /// of ATM to offer.</summary>
    [HttpGet("{underlying}/chain")]
    public async Task<IActionResult> GetChain(string underlying, [FromQuery] int span, [FromQuery] string? expiry, CancellationToken cancellationToken)
    {
        var chain = await _cdv.GetChainAsync(underlying.ToUpperInvariant(), span > 0 ? Math.Min(span, 50) : 20, cancellationToken, ParseExpiry(expiry));
        return chain is null ? NotFoundResult(underlying) : Ok(chain);
    }

    /// <summary>Premium candles for ONE strike - the picker's chart source. In memory and live for a
    /// tracked strike, fetched from Dhan's intraday history on demand for any other listed one (see
    /// CdvHostedService.GetStrikeCandlesAsync).</summary>
    [HttpGet("{underlying}/option/candles")]
    public async Task<IActionResult> GetOptionCandles(
        string underlying, [FromQuery] decimal strike, [FromQuery] string? type, [FromQuery] string? expiry, CancellationToken cancellationToken)
    {
        if (strike <= 0) return BadRequest(new { error = "A positive 'strike' is required." });

        var normalized = type?.Trim().ToUpperInvariant();
        if (normalized is not ("CE" or "PE")) return BadRequest(new { error = "'type' must be CE or PE." });

        if (!TryGetState(underlying, ParseExpiry(expiry), out _)) return NotFoundResult(underlying);
        return Ok(await _cdv.GetStrikeCandlesAsync(underlying.ToUpperInvariant(), strike, normalized == "CE", cancellationToken, ParseExpiry(expiry)));
    }

    [HttpGet("{underlying}/obv-series")]
    public IActionResult GetObvSeries(string underlying, [FromQuery] string? expiry)
    {
        if (!TryGetState(underlying, ParseExpiry(expiry), out var state)) return NotFoundResult(underlying);
        return Ok(new ObvSeriesResponse(state.GetObvSeries(isCall: true), state.GetObvSeries(isCall: false)));
    }

    /// <summary>The previous trading day's reconstructed CDV curve - a separate reference series
    /// for visual comparison against today's live one, never merged into it (CDV resets daily -
    /// see CdvUnderlyingState.Reset). Empty until the day's first backfill batch has run.</summary>
    [HttpGet("{underlying}/previous-day-series")]
    public IActionResult GetPreviousDaySeries(string underlying, [FromQuery] string? expiry)
    {
        if (!TryGetState(underlying, ParseExpiry(expiry), out var state)) return NotFoundResult(underlying);
        return Ok(state.GetPreviousDaySeries());
    }

    private static readonly int[] DefaultLookbackBars = { 3, 5, 7 };

    /// <summary>CE/PE %-change over a caller-configurable set of lookback windows - see
    /// CdvUnderlyingState.GetLookbackTable. ?bars=3,5,7 (the default); any positive, comma-separated
    /// list of bar counts works, e.g. ?bars=10,20,30.</summary>
    [HttpGet("{underlying}/lookback")]
    public IActionResult GetLookback(string underlying, [FromQuery] string? bars, [FromQuery] string? expiry)
    {
        if (!TryGetState(underlying, ParseExpiry(expiry), out var state)) return NotFoundResult(underlying);
        return Ok(state.GetLookbackTable(ParseBars(bars)));
    }

    /// <summary>The OBV counterpart of the lookback table - same windows, same %-change formula,
    /// measured against the delta-weighted OBV series instead of CDV (see
    /// CdvUnderlyingState.GetObvLookbackTable).</summary>
    [HttpGet("{underlying}/obv-lookback")]
    public IActionResult GetObvLookback(string underlying, [FromQuery] string? bars, [FromQuery] string? expiry)
    {
        if (!TryGetState(underlying, ParseExpiry(expiry), out var state)) return NotFoundResult(underlying);
        return Ok(state.GetObvLookbackTable(ParseBars(bars)));
    }

    private static IReadOnlyList<int> ParseBars(string? bars)
    {
        if (string.IsNullOrWhiteSpace(bars)) return DefaultLookbackBars;

        var parsed = bars.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(s => int.TryParse(s, out var n) && n > 0 ? n : (int?)null)
            .Where(n => n is not null)
            .Select(n => n!.Value)
            .Distinct()
            .ToList();

        return parsed.Count > 0 ? parsed : DefaultLookbackBars;
    }

    /// <summary>Every expiry listed for this underlying plus which one CDV is currently tracking -
    /// the dashboard/Backtrack expiry selector's payload. See CdvHostedService.GetExpiryOptions.</summary>
    [HttpGet("{underlying}/expiries")]
    public IActionResult GetExpiries(string underlying)
    {
        if (!TryGetState(underlying, null, out _)) return NotFoundResult(underlying);
        return Ok(_cdv.GetExpiryOptions(underlying.ToUpperInvariant()));
    }

    /// <summary>Points this underlying's ALWAYS-ON consumers - the SignalR broadcast and the live
    /// alert services, which have no page to ask - at a different tracked expiry. Every tracked
    /// expiry is held live at once now, so this is a pointer move rather than the unsubscribe-wipe-
    /// re-backfill it used to be (see CdvHostedService.SelectExpiryAsync).
    ///
    /// Pages do NOT need this: they pass ?expiry= on their own read requests and never disturb each
    /// other. A null (or omitted) 'expiry' reverts to the nearest tracked expiry. 400 with a reason
    /// when the underlying is unknown or that expiry is not currently tracked.</summary>
    [HttpPost("{underlying}/expiry")]
    public async Task<IActionResult> SelectExpiry(string underlying, [FromBody] SelectExpiryRequest? request, CancellationToken cancellationToken)
    {
        var error = await _cdv.SelectExpiryAsync(underlying.ToUpperInvariant(), request?.Expiry, cancellationToken);
        if (error is not null) return BadRequest(new { error });

        return Ok(_cdv.GetExpiryOptions(underlying.ToUpperInvariant()));
    }

    public sealed record SelectExpiryRequest(DateOnly? Expiry);

    /// <summary>Verification endpoint: every strike/side actually summed into the CDV total today,
    /// active or not - see CdvHostedService.GetTrackedStrikes / CdvUnderlyingState.GetTrackedStrikes.</summary>
    [HttpGet("{underlying}/strikes")]
    public IActionResult GetStrikes(string underlying, [FromQuery] string? expiry)
    {
        var parsed = ParseExpiry(expiry);
        if (!TryGetState(underlying, parsed, out _)) return NotFoundResult(underlying);
        return Ok(_cdv.GetTrackedStrikes(underlying.ToUpperInvariant(), parsed));
    }

    /// <summary>The state for the requested expiry, or the selected one when ?expiry= is omitted.
    /// Every tracked expiry is held at once (see CdvHostedService), so naming one here is just a
    /// read - it never switches what any other page sees.</summary>
    private bool TryGetState(string underlying, DateOnly? expiry, out CdvUnderlyingState state)
    {
        state = _cdv.StateFor(underlying, expiry)!;
        return state is not null;
    }

    /// <summary>?expiry=yyyy-MM-dd, or null when absent/unparseable - an unparseable value reads as
    /// "no preference" rather than an error, so a stale bookmark degrades to the selected expiry.</summary>
    private static DateOnly? ParseExpiry(string? expiry) =>
        DateOnly.TryParse(expiry, System.Globalization.CultureInfo.InvariantCulture, out var parsed) ? parsed : null;

    private static IActionResult NotFoundResult(string underlying) =>
        new NotFoundObjectResult(new { error = $"Unknown underlying '{underlying}'." });
}

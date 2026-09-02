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
    public IActionResult GetSeries(string underlying)
    {
        if (!TryGetState(underlying, out var state)) return NotFoundResult(underlying);
        return Ok(state.GetSeries());
    }

    [HttpGet("{underlying}/snapshot")]
    public IActionResult GetSnapshot(string underlying)
    {
        if (!TryGetState(underlying, out var state)) return NotFoundResult(underlying);
        return Ok(state.ToSnapshot());
    }

    [HttpGet("{underlying}/atm-ce/candles")]
    public IActionResult GetAtmCeCandles(string underlying)
    {
        if (!TryGetState(underlying, out var state)) return NotFoundResult(underlying);
        return Ok(state.GetAtmCandles(isCall: true));
    }

    [HttpGet("{underlying}/atm-pe/candles")]
    public IActionResult GetAtmPeCandles(string underlying)
    {
        if (!TryGetState(underlying, out var state)) return NotFoundResult(underlying);
        return Ok(state.GetAtmCandles(isCall: false));
    }

    /// <summary>The strikes the dashboard's option-chart picker offers around the current ATM, with
    /// live premium/OI merged in where Dhan's Option Chain API can supply it - see
    /// CdvHostedService.GetChainAsync. ?span=20 (the default) is how many strike steps either side
    /// of ATM to offer.</summary>
    [HttpGet("{underlying}/chain")]
    public async Task<IActionResult> GetChain(string underlying, [FromQuery] int span, CancellationToken cancellationToken)
    {
        var chain = await _cdv.GetChainAsync(underlying.ToUpperInvariant(), span > 0 ? Math.Min(span, 50) : 20, cancellationToken);
        return chain is null ? NotFoundResult(underlying) : Ok(chain);
    }

    /// <summary>Premium candles for ONE strike - the picker's chart source. In memory and live for a
    /// tracked strike, fetched from Dhan's intraday history on demand for any other listed one (see
    /// CdvHostedService.GetStrikeCandlesAsync).</summary>
    [HttpGet("{underlying}/option/candles")]
    public async Task<IActionResult> GetOptionCandles(
        string underlying, [FromQuery] decimal strike, [FromQuery] string? type, CancellationToken cancellationToken)
    {
        if (strike <= 0) return BadRequest(new { error = "A positive 'strike' is required." });

        var normalized = type?.Trim().ToUpperInvariant();
        if (normalized is not ("CE" or "PE")) return BadRequest(new { error = "'type' must be CE or PE." });

        if (!TryGetState(underlying, out _)) return NotFoundResult(underlying);
        return Ok(await _cdv.GetStrikeCandlesAsync(underlying.ToUpperInvariant(), strike, normalized == "CE", cancellationToken));
    }

    [HttpGet("{underlying}/obv-series")]
    public IActionResult GetObvSeries(string underlying)
    {
        if (!TryGetState(underlying, out var state)) return NotFoundResult(underlying);
        return Ok(new ObvSeriesResponse(state.GetObvSeries(isCall: true), state.GetObvSeries(isCall: false)));
    }

    /// <summary>The previous trading day's reconstructed CDV curve - a separate reference series
    /// for visual comparison against today's live one, never merged into it (CDV resets daily -
    /// see CdvUnderlyingState.Reset). Empty until the day's first backfill batch has run.</summary>
    [HttpGet("{underlying}/previous-day-series")]
    public IActionResult GetPreviousDaySeries(string underlying)
    {
        if (!TryGetState(underlying, out var state)) return NotFoundResult(underlying);
        return Ok(state.GetPreviousDaySeries());
    }

    private static readonly int[] DefaultLookbackBars = { 3, 5, 7 };

    /// <summary>CE/PE %-change over a caller-configurable set of lookback windows - see
    /// CdvUnderlyingState.GetLookbackTable. ?bars=3,5,7 (the default); any positive, comma-separated
    /// list of bar counts works, e.g. ?bars=10,20,30.</summary>
    [HttpGet("{underlying}/lookback")]
    public IActionResult GetLookback(string underlying, [FromQuery] string? bars)
    {
        if (!TryGetState(underlying, out var state)) return NotFoundResult(underlying);
        return Ok(state.GetLookbackTable(ParseBars(bars)));
    }

    /// <summary>The OBV counterpart of the lookback table - same windows, same %-change formula,
    /// measured against the delta-weighted OBV series instead of CDV (see
    /// CdvUnderlyingState.GetObvLookbackTable).</summary>
    [HttpGet("{underlying}/obv-lookback")]
    public IActionResult GetObvLookback(string underlying, [FromQuery] string? bars)
    {
        if (!TryGetState(underlying, out var state)) return NotFoundResult(underlying);
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
        if (!TryGetState(underlying, out _)) return NotFoundResult(underlying);
        return Ok(_cdv.GetExpiryOptions(underlying.ToUpperInvariant()));
    }

    /// <summary>Switches this underlying onto a different listed expiry - unsubscribes the current
    /// expiry's contracts from the Dhan feed and re-centers onto the new one, wiping and rebuilding
    /// the CDV/OBV/option-chain state both the dashboard and the Backtrack page read (see
    /// CdvHostedService.SelectExpiryAsync for exactly what that entails and why the reset is
    /// required). 400 with a reason when the underlying or expiry isn't recognized.</summary>
    [HttpPost("{underlying}/expiry")]
    public async Task<IActionResult> SelectExpiry(string underlying, [FromBody] SelectExpiryRequest request, CancellationToken cancellationToken)
    {
        if (request?.Expiry is not { } expiry) return BadRequest(new { error = "An 'expiry' date is required." });

        var error = await _cdv.SelectExpiryAsync(underlying.ToUpperInvariant(), expiry, cancellationToken);
        if (error is not null) return BadRequest(new { error });

        return Ok(_cdv.GetExpiryOptions(underlying.ToUpperInvariant()));
    }

    public sealed record SelectExpiryRequest(DateOnly? Expiry);

    /// <summary>Verification endpoint: every strike/side actually summed into the CDV total today,
    /// active or not - see CdvHostedService.GetTrackedStrikes / CdvUnderlyingState.GetTrackedStrikes.</summary>
    [HttpGet("{underlying}/strikes")]
    public IActionResult GetStrikes(string underlying)
    {
        if (!TryGetState(underlying, out _)) return NotFoundResult(underlying);
        return Ok(_cdv.GetTrackedStrikes(underlying.ToUpperInvariant()));
    }

    private bool TryGetState(string underlying, out CdvUnderlyingState state) =>
        _cdv.States.TryGetValue(underlying.ToUpperInvariant(), out state!);

    private static IActionResult NotFoundResult(string underlying) =>
        new NotFoundObjectResult(new { error = $"Unknown underlying '{underlying}'." });
}

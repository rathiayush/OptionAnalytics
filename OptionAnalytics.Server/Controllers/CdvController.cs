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

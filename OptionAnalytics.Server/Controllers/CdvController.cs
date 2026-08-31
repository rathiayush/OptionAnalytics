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

    private bool TryGetState(string underlying, out CdvUnderlyingState state) =>
        _cdv.States.TryGetValue(underlying.ToUpperInvariant(), out state!);

    private static IActionResult NotFoundResult(string underlying) =>
        new NotFoundObjectResult(new { error = $"Unknown underlying '{underlying}'." });
}

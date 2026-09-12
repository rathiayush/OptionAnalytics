using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>Backs a page that runs a real strategy backtest (trades, P&amp;L, signals - not just a
/// chart) against an EXPIRED contract, given an actual calendar expiry date - see
/// ExpiredOptionBacktestService for the data-sourcing and why only two of this app's strategies can
/// run here at all.</summary>
[ApiController]
[Route("api/expired-backtest")]
public sealed class ExpiredBacktestController : ControllerBase
{
    private readonly ExpiredOptionBacktestService _service;

    public ExpiredBacktestController(ExpiredOptionBacktestService service)
    {
        _service = service;
    }

    /// <summary>Just the strategies this page can run - see ExpiredOptionBacktestService.
    /// SupportedStrategyKeys. Same BacktestStrategyInfo shape as GET /api/backtest/strategies, so
    /// the frontend's existing generic strategy-picker/parameter-control code works unchanged.</summary>
    [HttpGet("strategies")]
    public IActionResult GetStrategies() => Ok(_service.GetStrategies());

    /// <summary>Runs one supported strategy against the given underlying's contract expiring on
    /// expiryDate (WEEK or MONTH cadence), over the lookbackDays before it. Every query param other
    /// than the named ones below that parses as a number is passed through as the strategy's own
    /// parameter (?otmSteps=1&amp;slPoints=10&amp;...), the same generic convention
    /// BacktestController.GetTrades uses. expiryCodeAdjust (default 0) nudges the derived
    /// expiryCode - see ExpiredOptionBacktestService.ComputeExpiryCode for why that derivation is a
    /// documented guess rather than something Dhan states directly.</summary>
    [HttpGet("{underlying}/run")]
    public async Task<IActionResult> Run(
        string underlying,
        [FromQuery] string? expiryFlag,
        [FromQuery] string? expiryDate,
        [FromQuery] int lookbackDays,
        [FromQuery] string? strategy,
        [FromQuery] int timeframe,
        [FromQuery] int expiryCodeAdjust,
        CancellationToken cancellationToken)
    {
        var normalizedFlag = expiryFlag?.Trim().ToUpperInvariant();
        if (normalizedFlag is not ("WEEK" or "MONTH"))
            return BadRequest(new { error = "'expiryFlag' must be WEEK or MONTH." });

        if (!DateOnly.TryParse(expiryDate, out var parsedExpiry))
            return BadRequest(new { error = "'expiryDate' must be a valid date." });

        if (string.IsNullOrWhiteSpace(strategy))
            return BadRequest(new { error = "'strategy' is required." });

        var result = await _service.RunAsync(
            underlying.ToUpperInvariant(), normalizedFlag, parsedExpiry, lookbackDays > 0 ? lookbackDays : 30,
            strategy, Math.Max(1, timeframe), expiryCodeAdjust, ReadParameters(), cancellationToken);

        return result.Success ? Ok(result) : BadRequest(new { error = result.Error });
    }

    /// <summary>Every query param other than the named ones above that parses as a number, passed
    /// through as the selected strategy's own parameter - generic on purpose, matching
    /// BacktestController.ReadParameters, so a new strategy's parameters reach it with no
    /// controller change.</summary>
    private Dictionary<string, decimal> ReadParameters()
    {
        var parameters = new Dictionary<string, decimal>();
        foreach (var (key, value) in Request.Query)
        {
            if (key is "expiryFlag" or "expiryDate" or "lookbackDays" or "strategy" or "timeframe" or "expiryCodeAdjust") continue;
            if (decimal.TryParse(value, out var parsed)) parameters[key] = parsed;
        }
        return parameters;
    }
}

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
    private readonly SpotFeedHostedService _spotFeed;

    public ExpiredBacktestController(ExpiredOptionBacktestService service, SpotFeedHostedService spotFeed)
    {
        _service = service;
        _spotFeed = spotFeed;
    }

    /// <summary>Just the strategies this page can run - see ExpiredOptionBacktestService.
    /// SupportedStrategyKeys. Same BacktestStrategyInfo shape as GET /api/backtest/strategies, so
    /// the frontend's existing generic strategy-picker/parameter-control code works unchanged.</summary>
    [HttpGet("strategies")]
    public IActionResult GetStrategies() => Ok(_service.GetStrategies());

    /// <summary>Every expiry date this page will actually accept for the given underlying/cadence -
    /// see ExpiredOptionBacktestService.GetAvailableExpiries for what "accept" means (a genuine
    /// listed expiry). The page's own expiry picker is populated from this rather than a free date
    /// field, so a request that reaches POST /run can only ever name a date this endpoint itself
    /// offered.</summary>
    [HttpGet("{underlying}/expiries")]
    public IActionResult GetExpiries(string underlying, [FromQuery] string? expiryFlag)
    {
        var normalizedFlag = expiryFlag?.Trim().ToUpperInvariant();
        if (normalizedFlag is not ("WEEK" or "MONTH"))
            return BadRequest(new { error = "'expiryFlag' must be WEEK or MONTH." });

        var expiries = _service.GetAvailableExpiries(underlying.ToUpperInvariant(), normalizedFlag);
        return Ok(new { expiries = expiries.Select(d => d.ToString("yyyy-MM-dd")) });
    }

    /// <summary>Runs one supported strategy against the given underlying's contract expiring on
    /// expiryDate (WEEK or MONTH cadence), over the lookbackDays before it (clamped to
    /// ExpiredOptionBacktestService.MaxLookbackDays - see that class's own doc comment for why: it
    /// is what keeps expiryCode=1 pointed unambiguously at this one contract). Every query param
    /// other than the named ones below that parses as a number is passed through as the strategy's
    /// own parameter (?otmSteps=1&amp;slPoints=10&amp;...), the same generic convention
    /// BacktestController.GetTrades uses.</summary>
    [HttpGet("{underlying}/run")]
    public async Task<IActionResult> Run(
        string underlying,
        [FromQuery] string? expiryFlag,
        [FromQuery] string? expiryDate,
        [FromQuery] int lookbackDays,
        [FromQuery] string? strategy,
        [FromQuery] int timeframe,
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
            strategy, Math.Max(1, timeframe), ReadParameters(), cancellationToken);

        return result.Success ? Ok(result) : BadRequest(new { error = result.Error });
    }

    /// <summary>The raw rolling-option series for one relative strike/side - no strategy run, just
    /// literally what Dhan's rolling-option endpoint returns for this underlying/expiry/strike,
    /// including the per-bar RESOLVED strike and any splice this app's own safety net already flags
    /// - see ExpiredOptionBacktestService.GetRollingChartAsync's own doc comment for why this exists
    /// separately from POST /run (a real premium anomaly is easier to see directly than to infer
    /// from a trade's own surprising exit).
    ///
    /// Dhan's rolling-option endpoint itself only ever takes a RELATIVE strike ("ATM"/"ATM+-K"), so
    /// an ABSOLUTE strike (<paramref name="strike"/>, e.g. the exact "56200" a trade's own row named)
    /// is converted to the otmSteps that reaches it, computed against the underlying's CURRENT live
    /// spot (SpotFeedHostedService) - the only real-time ATM reference this controller has. This is
    /// necessarily an approximation of "the same otmSteps a run on that historical day would have
    /// used" (spot has moved since), which is fine for INSPECTING roughly the right contract but is
    /// why otmSteps, not strike, is what actually reaches GetRollingChartAsync - strike is purely a
    /// convenience for finding a starting otmSteps, never sent to Dhan itself. Takes priority over an
    /// explicit otmSteps when both are given.</summary>
    [HttpGet("{underlying}/rolling-chart")]
    public async Task<IActionResult> GetRollingChart(
        string underlying,
        [FromQuery] string? expiryFlag,
        [FromQuery] string? expiryDate,
        [FromQuery] int otmSteps,
        [FromQuery] decimal? strike,
        [FromQuery] string? side,
        [FromQuery] int lookbackDays,
        CancellationToken cancellationToken)
    {
        var normalizedFlag = expiryFlag?.Trim().ToUpperInvariant();
        if (normalizedFlag is not ("WEEK" or "MONTH"))
            return BadRequest(new { error = "'expiryFlag' must be WEEK or MONTH." });

        if (!DateOnly.TryParse(expiryDate, out var parsedExpiry))
            return BadRequest(new { error = "'expiryDate' must be a valid date." });

        var normalizedSide = side?.Trim().ToUpperInvariant();
        if (normalizedSide is not ("CE" or "PE"))
            return BadRequest(new { error = "'side' must be CE or PE." });

        var resolvedOtmSteps = otmSteps;
        if (strike is { } absoluteStrike)
        {
            if (!_spotFeed.States.TryGetValue(underlying.ToUpperInvariant(), out var spotState) || spotState.LastPrice <= 0 || spotState.Step <= 0)
                return BadRequest(new { error = $"Current spot price for {underlying} is not available yet - try again shortly, or use Strike offset instead." });

            var atm = Math.Round(spotState.LastPrice / spotState.Step) * spotState.Step;
            var stepsFromAtm = (int)Math.Round((absoluteStrike - atm) / spotState.Step, MidpointRounding.AwayFromZero);
            // Same sign convention GetRollingChartAsync/RunAsync already use: otmSteps is "how far
            // OTM for the side being looked at", which is ABOVE current ATM for a call and BELOW it
            // for a put - so a PE's absolute strike converts with the sign flipped.
            resolvedOtmSteps = normalizedSide == "CE" ? stepsFromAtm : -stepsFromAtm;
        }

        var result = await _service.GetRollingChartAsync(
            underlying.ToUpperInvariant(), normalizedFlag, parsedExpiry, resolvedOtmSteps, normalizedSide == "CE",
            lookbackDays > 0 ? lookbackDays : 30, cancellationToken);

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
            if (key is "expiryFlag" or "expiryDate" or "lookbackDays" or "strategy" or "timeframe") continue;
            if (decimal.TryParse(value, out var parsed)) parameters[key] = parsed;
        }
        return parameters;
    }
}

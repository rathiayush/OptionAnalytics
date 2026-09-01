using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>Backtrack page endpoints - all compute fresh on every call (see BacktestService),
/// nothing is cached, since the underlying source data itself only ever grows/rolls forward.</summary>
[ApiController]
[Route("api/backtest")]
public sealed class BacktestController : ControllerBase
{
    private readonly BacktestService _backtest;

    public BacktestController(BacktestService backtest)
    {
        _backtest = backtest;
    }

    /// <summary>Every spot/ATM-CE/ATM-PE EMA crossover + confluence signal that would have fired at
    /// the given timeframe (1/2/5-minute bars, aggregated from the native 1-minute series), most
    /// recent first.</summary>
    [HttpGet("{underlying}")]
    public IActionResult Get(string underlying, [FromQuery] int timeframe = 1) =>
        Ok(_backtest.Replay(underlying.ToUpperInvariant(), timeframe));

    /// <summary>Every registered strategy's metadata - key, name, description, and the parameter
    /// controls the Backtrack page should render for it. See Services.Backtesting.IBacktestStrategy
    /// for how to add a new one; it shows up here automatically once registered in Program.cs.</summary>
    [HttpGet("strategies")]
    public IActionResult GetStrategies() => Ok(_backtest.GetStrategies());

    /// <summary>Runs one registered strategy (?strategy=, defaulting to the original OTM/Confluence
    /// one) over the underlying's current history at the given timeframe - see
    /// Services.Backtesting.IBacktestStrategy.Simulate for what a strategy actually does with this.
    /// Every query param other than "strategy"/"timeframe" that parses as a number is passed
    /// through as that strategy's own parameter (keyed by name, e.g. ?otmSteps=1&amp;slPoints=10) -
    /// generic on purpose, so a new strategy's parameters need no controller change to reach it.
    /// Any parameter the strategy declares but the caller omits falls back to that parameter's own
    /// default (see BacktestService.RunStrategy).</summary>
    [HttpGet("{underlying}/trades")]
    public IActionResult GetTrades(string underlying, [FromQuery] string strategy = "otm-confluence", [FromQuery] int timeframe = 1)
    {
        var parameters = new Dictionary<string, decimal>();
        foreach (var (key, value) in Request.Query)
        {
            if (key is "strategy" or "timeframe") continue;
            if (decimal.TryParse(value, out var parsed)) parameters[key] = parsed;
        }

        return Ok(_backtest.RunStrategy(underlying.ToUpperInvariant(), strategy, Math.Max(1, timeframe), parameters));
    }
}

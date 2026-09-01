using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>Backtrack page endpoints - both compute fresh on every call (see BacktestService),
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

    /// <summary>Simulates one long-only OTM CE/PE trade per Confluence signal at that timeframe -
    /// see BacktestService.SimulateTrades for the entry/exit/SL-TP rules. otmSteps is how many
    /// strike-steps OTM from ATM to trade (0 = ATM itself); slPoints/tpPoints are both absolute
    /// premium points (not a percentage).</summary>
    [HttpGet("{underlying}/trades")]
    public IActionResult GetTrades(
        string underlying,
        [FromQuery] int timeframe = 1,
        [FromQuery] int otmSteps = 1,
        [FromQuery] decimal slPoints = 10,
        [FromQuery] decimal tpPoints = 20) =>
        Ok(_backtest.SimulateTrades(underlying.ToUpperInvariant(), timeframe, Math.Max(0, otmSteps), Math.Max(0.05m, slPoints), Math.Max(0.05m, tpPoints)));
}

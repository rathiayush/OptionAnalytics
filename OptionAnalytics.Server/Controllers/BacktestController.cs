using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>GET /api/backtest/{underlying} - every spot/ATM-CE/ATM-PE EMA crossover + confluence
/// signal that would have fired across whatever candle history the underlying currently holds in
/// memory (see BacktestService), most recent first. Computed fresh on every call - nothing is
/// cached, since the underlying source data itself only ever grows/rolls forward.</summary>
[ApiController]
[Route("api/backtest")]
public sealed class BacktestController : ControllerBase
{
    private readonly BacktestService _backtest;

    public BacktestController(BacktestService backtest)
    {
        _backtest = backtest;
    }

    [HttpGet("{underlying}")]
    public IActionResult Get(string underlying) => Ok(_backtest.Replay(underlying.ToUpperInvariant()));
}

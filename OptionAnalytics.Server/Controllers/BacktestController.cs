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
    public IActionResult Get(string underlying, [FromQuery] string strategy = "five-ema", [FromQuery] int timeframe = 1, [FromQuery] string? expiry = null) =>
        Ok(_backtest.ReplayForStrategy(underlying.ToUpperInvariant(), strategy, Math.Max(1, timeframe), ReadParameters(), ParseExpiry(expiry)));

    /// <summary>Every registered strategy's metadata - key, name, description, and the parameter
    /// controls the Backtrack page should render for it. See Services.Backtesting.IBacktestStrategy
    /// for how to add a new one; it shows up here automatically once registered in Program.cs.
    /// ?timeframe=, when given, applies that strategy's own per-timeframe Default overrides (see
    /// IBacktestStrategy.DefaultsForTimeframe) - the page passes its own currently-selected
    /// timeframe and re-fetches this whenever that selector changes.</summary>
    [HttpGet("strategies")]
    public IActionResult GetStrategies([FromQuery] int? timeframe = null) => Ok(_backtest.GetStrategies(timeframe));

    /// <summary>Runs one registered strategy (?strategy=, defaulting to the 5 EMA one) over the
    /// underlying's current history at the given timeframe - see
    /// Services.Backtesting.IBacktestStrategy.Simulate for what a strategy actually does with this.
    /// Every query param other than "strategy"/"timeframe" that parses as a number is passed
    /// through as that strategy's own parameter (keyed by name, e.g. ?otmSteps=1&amp;slPoints=10) -
    /// generic on purpose, so a new strategy's parameters need no controller change to reach it.
    /// Any parameter the strategy declares but the caller omits falls back to that parameter's own
    /// default (see BacktestService.RunStrategy).
    ///
    /// Uses RunStrategyAsync, so a signal on a strike that never entered the ATM+-8 window (and
    /// therefore has no in-memory candles) gets its history fetched from Dhan on demand rather than
    /// showing as a "No Data" row - see that method for why it is a two-pass fetch.</summary>
    [HttpGet("{underlying}/trades")]
    public async Task<IActionResult> GetTrades(string underlying, [FromQuery] string strategy = "five-ema", [FromQuery] int timeframe = 1, [FromQuery] string? expiry = null) =>
        Ok(await _backtest.RunStrategyAsync(
            underlying.ToUpperInvariant(), strategy, Math.Max(1, timeframe), ReadParameters(), HttpContext.RequestAborted, ParseExpiry(expiry)));

    /// <summary>?expiry=yyyy-MM-dd - which tracked expiry to run against, or the selected one when
    /// absent. Every tracked expiry is held live at once, so this is a read: running Backtrack on
    /// next month does not change what the dashboard or an armed trigger sees.</summary>
    private static DateOnly? ParseExpiry(string? expiry) =>
        DateOnly.TryParse(expiry, System.Globalization.CultureInfo.InvariantCulture, out var parsed) ? parsed : null;

    /// <summary>Every query param other than "strategy"/"timeframe"/"expiry" that parses as a
    /// number, passed through as the selected strategy's own parameter - generic on purpose, so a
    /// new strategy's parameters reach it with no controller change. "expiry" is skipped
    /// explicitly rather than relying on a date failing to parse as a decimal: a bare year would
    /// parse, and would then be handed to a strategy as a parameter named "expiry".</summary>
    private Dictionary<string, decimal> ReadParameters()
    {
        var parameters = new Dictionary<string, decimal>();
        foreach (var (key, value) in Request.Query)
        {
            if (key is "strategy" or "timeframe" or "expiry") continue;
            if (decimal.TryParse(value, out var parsed)) parameters[key] = parsed;
        }
        return parameters;
    }
}

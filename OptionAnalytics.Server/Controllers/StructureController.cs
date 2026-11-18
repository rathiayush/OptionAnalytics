using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>The Spot structure page's data - an index's spot candles over many days at one timeframe (SpotStructureService).</summary>
[ApiController]
[Route("api/structure")]
public sealed class StructureController : ControllerBase
{
    private static readonly HashSet<string> Underlyings = new(StringComparer.OrdinalIgnoreCase) { "NIFTY", "BANKNIFTY", "SENSEX" };
    private readonly SpotStructureService _service;

    public StructureController(SpotStructureService service) => _service = service;

    /// <summary>`tf` in minutes - 1440 (a day), 240, 60, 15, 5, 3 or 1; `days` calendar days back (each timeframe has its
    /// default and limit). Built from the spot's 1-minute candles: the past days from the server's disk cache first (OI Replay's
    /// and the backtests' kept days), Dhan only for the days not kept; today from the spot feed.</summary>
    [HttpGet("{underlying}/candles")]
    public async Task<IActionResult> Candles(string underlying, [FromQuery] int tf = 60, [FromQuery] int? days = null, CancellationToken cancellationToken = default)
    {
        if (!Underlyings.Contains(underlying)) return BadRequest(new { error = $"'{underlying}' is not supported - only NIFTY, BANKNIFTY and SENSEX." });
        if (!SpotStructureService.Timeframes.ContainsKey(tf)) return BadRequest(new { error = $"Timeframe {tf} is not offered - one of {string.Join(", ", SpotStructureService.Timeframes.Keys)}." });
        var result = await _service.CandlesAsync(underlying, tf, days, cancellationToken);
        return Ok(new
        {
            underlying = result.Underlying,
            timeframe = result.Timeframe,
            days = result.Days,
            from = result.From,
            to = result.To,
            todayIncluded = result.TodayIncluded,
            error = result.Error,
            daysHeld = result.DaysHeld,
            daysFromDisk = result.DaysFromDisk,
            daysAskedOfDhan = result.DaysAskedOfDhan,
            candles = result.Candles.Select(c => new { time = c.Time, open = c.Open, high = c.High, low = c.Low, close = c.Close, volume = c.Volume }),
        });
    }
}

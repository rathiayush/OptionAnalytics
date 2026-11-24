using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Services.OrderFlow;
using OptionAnalytics.Server.TrueData;

namespace OptionAnalytics.Server.Controllers;

/// <summary>The Tick Flow page (TrueData's real-time tick feed - see TrueDataLiveFeed): the day's footprint, delta, tape and
/// best bid / ask trail per index, in the Order Flow snapshot's own shape so the page's charts are the Order Flow page's.
/// NIFTY and BANKNIFTY. Only registered while TrueData:Live:Enabled (else "enabled": false and no data). Admin / User; the
/// External account never reaches it (deny by default).</summary>
[ApiController]
[Route("api/tick-flow")]
public sealed class TickFlowController : ControllerBase
{
    private readonly TrueDataLiveFeed? _feed;

    public TickFlowController(IServiceProvider services) => _feed = services.GetService<TrueDataLiveFeed>();

    /// <summary>Whether the feed is on, its state and each index's counters (trades, sequence gaps, the best bid / ask).</summary>
    [HttpGet("status")]
    public ActionResult Status() =>
        _feed is null
            ? Ok(new { enabled = false, state = "off", note = "TrueData:Live:Enabled is off or the TrueData login is not set (TrueData__UserId / TrueData__Password)." })
            : Ok(new { enabled = true, status = _feed.Snapshot() });

    /// <summary>The day so far for one index in the Order Flow snapshot's shape. The heatmap is the best bid / ask trail only -
    /// TrueData has no NSE depth past level 1.</summary>
    [HttpGet("{underlying}")]
    public ActionResult<OrderFlowSnapshot> Get(string underlying, [FromQuery] decimal rowSize = 1, [FromQuery] int minTradeLots = 1, [FromQuery] int heatmapColumns = 900)
    {
        if (_feed is null) return NotFound(new { error = "The TrueData live feed is off (TrueData:Live:Enabled)." });
        var engine = _feed.EngineFor(underlying);
        if (engine is null) return NotFound(new { error = $"{underlying.ToUpperInvariant()} is not streamed (TrueData:Live:Instruments)." });
        return engine.Snapshot(Math.Clamp(rowSize, 0, 1000), Math.Max(1, minTradeLots) * (long)engine.LotSize, Math.Clamp(heatmapColumns, 50, 3000));
    }

    /// <summary>Time &amp; Sales: the last prints of at least <paramref name="minTradeLots"/>.</summary>
    [HttpGet("{underlying}/tape")]
    public ActionResult<IReadOnlyList<OrderFlowTrade>> Tape(string underlying, [FromQuery] int count = 500, [FromQuery] int minTradeLots = 1)
    {
        var engine = _feed?.EngineFor(underlying);
        if (engine is null) return NotFound(new { error = "Not streamed." });
        return Ok(engine.Tape(null, Math.Clamp(count, 1, 5000), Math.Max(1, minTradeLots) * (long)engine.LotSize));
    }
}

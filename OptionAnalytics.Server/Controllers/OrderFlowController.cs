using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Services.OrderFlow;

namespace OptionAnalytics.Server.Controllers;

/// <summary>The Order Flow page's initial load - see OrderFlowEngine. After this the page follows
/// the "orderFlowLive" push on SignalR group "of:{underlying}".</summary>
[ApiController]
[Route("api/order-flow")]
public sealed class OrderFlowController : ControllerBase
{
    private readonly OrderFlowService _orderFlow;

    public OrderFlowController(OrderFlowService orderFlow) => _orderFlow = orderFlow;

    /// <param name="rowSize">Price points per footprint/heatmap row (0 = the contract's own tick).</param>
    /// <param name="minTradeLots">Smallest print returned, in lots.</param>
    /// <param name="heatmapColumns">At most this many depth snapshots for the heatmap.</param>
    [HttpGet("{underlying}")]
    public ActionResult<OrderFlowSnapshot> Get(string underlying, [FromQuery] decimal rowSize = 1, [FromQuery] int minTradeLots = 1, [FromQuery] int heatmapColumns = 900)
    {
        var engine = _orderFlow.EngineFor(underlying);
        if (engine is null)
            return NotFound(new { error = $"No {underlying.ToUpperInvariant()} futures contract is being tracked yet - the futures list may still be loading, or order flow is turned off." });
        return engine.Snapshot(Math.Clamp(rowSize, 0, 1000), Math.Max(1, minTradeLots) * (long)engine.LotSize, Math.Clamp(heatmapColumns, 50, 3000));
    }
}

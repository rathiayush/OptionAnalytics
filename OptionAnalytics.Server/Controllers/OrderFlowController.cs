using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Services.OrderFlow;

namespace OptionAnalytics.Server.Controllers;

/// <summary>The Order Flow page's initial load - see OrderFlowEngine. After this the page follows
/// the "orderFlowLive" push on SignalR group "of:{underlying}" (and the DOM "domLive" on
/// "dom:{underlying}"). Also the recorded days for replay.</summary>
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

    /// <summary>The days recorded for replay, newest first - see OrderFlowRecorder. Dhan has no
    /// historical tick or depth data, so only days the server was running for are here.</summary>
    [HttpGet("{underlying}/days")]
    public ActionResult<IReadOnlyList<RecordedOrderFlowDay>> Days(string underlying) => Ok(_orderFlow.Recorder.Days(underlying));

    /// <summary>A recorded day in the same shape as the live load, for replay. The heatmap can be
    /// asked for in more columns (up to 12000, i.e. every 2s snapshot) so a replay stays detailed.</summary>
    [HttpGet("{underlying}/history/{date}")]
    public ActionResult<OrderFlowSnapshot> History(string underlying, DateOnly date, [FromQuery] decimal rowSize = 1, [FromQuery] int minTradeLots = 1, [FromQuery] int heatmapColumns = 3000)
    {
        var live = _orderFlow.EngineFor(underlying);
        // Today is the live engine itself - it already holds what was saved earlier today.
        var engine = live?.ExportDayDate() == date ? live : _orderFlow.Recorder.EngineFor(underlying, date);
        if (engine is null) return NotFound(new { error = $"No {underlying.ToUpperInvariant()} order flow was recorded on {date:yyyy-MM-dd}." });
        return engine.Snapshot(Math.Clamp(rowSize, 0, 1000), Math.Max(1, minTradeLots) * (long)engine.LotSize, Math.Clamp(heatmapColumns, 50, 12000));
    }
}

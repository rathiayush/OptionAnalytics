using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Services.OrderFlow;

namespace OptionAnalytics.Server.Controllers;

/// <summary>The Order Flow page's initial load - see OrderFlowEngine. After this the page follows
/// the "orderFlowLive" push on SignalR group "of:{underlying}" (and the DOM "domLive" on
/// "dom:{underlying}"). Also the in-memory days for replay.</summary>
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

    /// <summary>The days that can be replayed, newest first: today (the live engine) and the past days
    /// held in memory (OrderFlowDayStore). Nothing is stored on disk, so a restart starts this list
    /// over - and Dhan has no historical tick or depth data to fill it from.</summary>
    [HttpGet("{underlying}/days")]
    public ActionResult<IReadOnlyList<ReplayableOrderFlowDay>> Days(string underlying)
    {
        var days = new List<ReplayableOrderFlowDay>();
        var live = _orderFlow.EngineFor(underlying);
        if (live?.ExportDayDate() is { } today) days.Add(new ReplayableOrderFlowDay(today, live.ContractSymbol, true));
        days.AddRange(_orderFlow.PastDays.Days(underlying).Where(d => days.All(x => x.Date != d.Date)).Select(d => new ReplayableOrderFlowDay(d.Date, d.ContractSymbol, false)));
        return days.OrderByDescending(d => d.Date).ToList();
    }

    /// <summary>A day in the same shape as the live load, for replay. The heatmap can be asked for in
    /// more columns (up to 12000, i.e. every 2s snapshot) so a replay stays detailed.</summary>
    [HttpGet("{underlying}/history/{date}")]
    public ActionResult<OrderFlowSnapshot> History(string underlying, DateOnly date, [FromQuery] decimal rowSize = 1, [FromQuery] int minTradeLots = 1, [FromQuery] int heatmapColumns = 3000)
    {
        var live = _orderFlow.EngineFor(underlying);
        var engine = live?.ExportDayDate() == date ? live : _orderFlow.PastDays.EngineFor(underlying, date);
        if (engine is null) return NotFound(new { error = $"{underlying.ToUpperInvariant()} order flow for {date:yyyy-MM-dd} is not in memory (only today and the last few days since the server started are kept)." });
        return engine.Snapshot(Math.Clamp(rowSize, 0, 1000), Math.Max(1, minTradeLots) * (long)engine.LotSize, Math.Clamp(heatmapColumns, 50, 12000));
    }
}

/// <summary>Live: today, still being built by the live engine.</summary>
public sealed record ReplayableOrderFlowDay(DateOnly Date, string ContractSymbol, bool Live);

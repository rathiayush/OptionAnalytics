using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Services.OrderFlow;

namespace OptionAnalytics.Server.Controllers;

/// <summary>The Order Flow page's data - see OrderFlowEngine. Live: the snapshot, then the
/// "orderFlowLive" push on SignalR group "of:{underlying}:{expiry}" (and the DOM "domLive" on
/// "dom:{underlying}"). Replay: any day - exact when the server has it, otherwise estimated from
/// Dhan's 1-minute candles (OrderFlowHistory).</summary>
[ApiController]
[Route("api/order-flow")]
public sealed class OrderFlowController : ControllerBase
{
    private readonly OrderFlowService _orderFlow;
    private readonly OrderFlowHistory _history;

    public OrderFlowController(OrderFlowService orderFlow, OrderFlowHistory history)
    {
        _orderFlow = orderFlow;
        _history = history;
    }

    /// <param name="expiry">The futures contract (yyyy-MM-dd); omitted = the nearest. A contract that is
    /// not tracked yet starts being tracked now.</param>
    /// <param name="rowSize">Price points per footprint/heatmap row (0 = the contract's own tick).</param>
    /// <param name="minTradeLots">Smallest print returned, in lots.</param>
    /// <param name="heatmapColumns">At most this many depth snapshots for the heatmap.</param>
    [HttpGet("{underlying}")]
    public async Task<ActionResult<OrderFlowSnapshot>> Get(string underlying, [FromQuery] DateOnly? expiry = null, [FromQuery] decimal rowSize = 1,
        [FromQuery] int minTradeLots = 1, [FromQuery] int heatmapColumns = 900, CancellationToken cancellationToken = default)
    {
        var engine = await _orderFlow.EngineForAsync(underlying, expiry, cancellationToken);
        if (engine is null)
            return NotFound(new { error = $"No {underlying.ToUpperInvariant()} futures contract{(expiry is null ? "" : $" expiring {expiry:dd MMM yyyy}")} is being tracked - the futures list may still be loading, or order flow is turned off." });
        return engine.Snapshot(Math.Clamp(rowSize, 0, 1000), Math.Max(1, minTradeLots) * (long)engine.LotSize, Math.Clamp(heatmapColumns, 50, 3000));
    }

    /// <summary>The listed futures contracts, nearest first.</summary>
    [HttpGet("{underlying}/contracts")]
    public async Task<ActionResult<IReadOnlyList<OrderFlowContract>>> Contracts(string underlying, CancellationToken cancellationToken)
    {
        var contracts = await _orderFlow.ContractsAsync(underlying, cancellationToken);
        return contracts.Select((c, i) => new OrderFlowContract(c.Expiry, c.TradingSymbol, c.SecurityId, i == 0)).ToList();
    }

    /// <summary>The days the server can replay EXACTLY, newest first: today (live engines) and the past
    /// days held in memory. Any other day still loads, estimated from Dhan's 1-minute candles.</summary>
    [HttpGet("{underlying}/days")]
    public ActionResult<IReadOnlyList<ReplayableOrderFlowDay>> Days(string underlying)
    {
        var days = new List<ReplayableOrderFlowDay>();
        var live = _orderFlow.EngineFor(underlying);
        if (live?.ExportDayDate() is { } today) days.Add(new ReplayableOrderFlowDay(today, live.ContractSymbol, live.Expiry, true));
        days.AddRange(_orderFlow.PastDays.Days(underlying)
            .Where(d => !days.Any(x => x.Date == d.Date && x.Expiry == d.Expiry))
            .Select(d => new ReplayableOrderFlowDay(d.Date, d.ContractSymbol, d.Expiry, false)));
        return days.OrderByDescending(d => d.Date).ToList();
    }

    /// <summary>One day for replay, in the live snapshot's shape - Source "live" when the server has the
    /// day, "estimated" when it was rebuilt from Dhan's 1-minute candles. The heatmap can be asked for in
    /// more columns (up to 12000, i.e. every 2s snapshot) so a replay stays detailed.</summary>
    [HttpGet("{underlying}/day/{date}")]
    public async Task<ActionResult<OrderFlowSnapshot>> Day(string underlying, DateOnly date, [FromQuery] DateOnly? expiry = null, [FromQuery] decimal rowSize = 1,
        [FromQuery] int minTradeLots = 1, [FromQuery] int heatmapColumns = 3000, CancellationToken cancellationToken = default)
    {
        var result = await _history.DayAsync(underlying, date, expiry, Math.Clamp(rowSize, 0, 1000), minTradeLots, Math.Clamp(heatmapColumns, 50, 12000), cancellationToken);
        return result.Snapshot is null ? NotFound(new { error = result.Error }) : result.Snapshot;
    }
}

public sealed record OrderFlowContract(DateOnly Expiry, string TradingSymbol, uint SecurityId, bool Nearest);

/// <summary>Live: today, still being built by the live engine.</summary>
public sealed record ReplayableOrderFlowDay(DateOnly Date, string ContractSymbol, DateOnly? Expiry, bool Live);

using System.Collections.Concurrent;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;
using OptionAnalytics.Server.Services.OrderFlow;

namespace OptionAnalytics.Server.Controllers;

/// <summary>The External page's data - and the ONLY data the External account can reach (ExternalAccess blocks every
/// other API for it; on the hub it may join only its page's own feeds). Read-only, today only, NIFTY / BANKNIFTY only:
///  - order-flow: the near futures' live order-flow snapshot (heatmap, prints of at least the big-order threshold, bars) -
///    the same answer as /api/order-flow/{u}, from the live engine's memory (no Dhan call); "orderFlowLive" on
///    "of:{u}:{expiry}" keeps it live;
///  - oi: today's OI Replay band (the same run OI Replay's live view loads), cut to each strike's time and OI;
///    "oiReplayTicks" on "c:{u}:N1" keeps it live.
/// Answers are held a few seconds so a page left open, or many of them, cost the server one build per interval.</summary>
[ApiController]
[Route("api/external")]
[Authorize(Roles = $"{AuthRoles.External},{AuthRoles.Admin}")]
[EnableRateLimiting("external")]
public sealed class ExternalController : ControllerBase
{
    internal static readonly string[] Underlyings = { "NIFTY", "BANKNIFTY" };
    internal static readonly decimal[] RowSizes = { 1, 2, 5, 10, 20, 50 };
    private const int HeatmapColumns = 900;
    private static readonly TimeSpan OrderFlowHold = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan OiHold = TimeSpan.FromSeconds(30);

    private static readonly ConcurrentDictionary<string, (DateTimeOffset At, object Body)> Held = new();

    private readonly OrderFlowService _orderFlow;
    private readonly OiReplayService _oiReplay;

    public ExternalController(OrderFlowService orderFlow, OiReplayService oiReplay)
    {
        _orderFlow = orderFlow;
        _oiReplay = oiReplay;
    }

    /// <param name="rowSize">Points per heatmap row: 1, 2, 5, 10, 20 or 50.</param>
    /// <param name="minTradeLots">The big-order threshold: prints of at least this many lots come with it (the dots).</param>
    [HttpGet("{underlying}/order-flow")]
    public ActionResult<OrderFlowSnapshot> OrderFlow(string underlying, [FromQuery] decimal rowSize = 5, [FromQuery] int minTradeLots = 100)
    {
        if (Pick(underlying) is not { } u) return BadRequest(new { error = "Only NIFTY and BANKNIFTY." });
        if (!RowSizes.Contains(rowSize)) return BadRequest(new { error = "Points per row: 1, 2, 5, 10, 20 or 50." });
        var lots = Math.Clamp(minTradeLots, 1, 100_000);
        var key = $"of|{u}|{rowSize}|{lots}";
        if (Fresh(key, OrderFlowHold) is OrderFlowSnapshot held) return held;

        var engine = _orderFlow.EngineFor(u);
        if (engine is null) return NotFound(new { error = $"{u} futures are not being tracked yet - try again shortly." });
        var snapshot = engine.Snapshot(rowSize, lots * (long)engine.LotSize, HeatmapColumns, rowSize);
        Held[key] = (DateTimeOffset.UtcNow, snapshot);
        return snapshot;
    }

    public sealed record OiPoint(DateTimeOffset Time, decimal Strike, long? OpenInterest);
    /// <summary>Step: the strike step; SpotClose: the index's last 1-minute close (the ATM strike until live spot arrives).</summary>
    public sealed record OiAnswer(bool Success, string Underlying, DateOnly Date, int Step, decimal? SpotClose, IReadOnlyList<OiPoint> CePoints, IReadOnlyList<OiPoint> PePoints);

    [HttpGet("{underlying}/oi")]
    public async Task<ActionResult<OiAnswer>> Oi(string underlying, CancellationToken cancellationToken)
    {
        if (Pick(underlying) is not { } u) return BadRequest(new { error = "Only NIFTY and BANKNIFTY." });
        var key = $"oi|{u}";
        if (Fresh(key, OiHold) is OiAnswer held) return held;

        var today = IstClock.Today();
        // The same request OI Replay's live view makes for today (its nearest WEEK / MONTH series, forceLive).
        var run = await _oiReplay.RunAsync(u, today, 1, u == "BANKNIFTY" ? "MONTH" : "WEEK", cancellationToken, forceLive: true);
        if (!run.Success) return StatusCode(StatusCodes.Status503ServiceUnavailable, new { error = "Today's OI is not available right now." });
        var answer = new OiAnswer(true, u, today, run.Step, run.SpotCandlesOneMinute.Count > 0 ? run.SpotCandlesOneMinute[^1].Close : null, Cut(run.CePoints), Cut(run.PePoints));
        Held[key] = (DateTimeOffset.UtcNow, answer);
        return answer;
    }

    internal static IReadOnlyList<OiPoint> Cut(IReadOnlyList<OiReplayPoint> points) =>
        points.Select(p => new OiPoint(p.Time, p.Strike, p.OpenInterest)).ToList();

    private static string? Pick(string underlying)
    {
        var u = (underlying ?? "").Trim().ToUpperInvariant();
        return Underlyings.Contains(u) ? u : null;
    }

    private static object? Fresh(string key, TimeSpan hold) =>
        Held.TryGetValue(key, out var held) && DateTimeOffset.UtcNow - held.At < hold ? held.Body : null;
}

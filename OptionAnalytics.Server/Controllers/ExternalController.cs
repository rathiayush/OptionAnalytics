using System.Collections.Concurrent;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;
using OptionAnalytics.Server.Services.OrderFlow;

namespace OptionAnalytics.Server.Controllers;

/// <summary>The External page's two views - and the ONLY data the External account can reach (ExternalAccess blocks
/// every other API and the hubs for it). Read-only, today only, NIFTY / BANKNIFTY only, fixed parameters:
///  - heatmap: the near futures' liquidity heatmap from the live order-flow engine's memory (no Dhan call);
///  - oi-net: today's OI Replay band summed per minute - CE, PE and net CE - PE OI change and their running totals
///    (only the totals; no strike, premium or position data).
/// Answers are held a few seconds so a page left open, or many of them, cost the server one build per interval.</summary>
[ApiController]
[Route("api/external")]
[Authorize(Roles = $"{AuthRoles.External},{AuthRoles.Admin}")]
[EnableRateLimiting("external")]
public sealed class ExternalController : ControllerBase
{
    internal static readonly string[] Underlyings = { "NIFTY", "BANKNIFTY" };
    internal static readonly decimal[] RowSizes = { 1, 2, 5, 10, 20, 50 };
    private const int HeatmapColumns = 600;
    private static readonly TimeSpan HeatmapHold = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan OiHold = TimeSpan.FromSeconds(30);

    private static readonly ConcurrentDictionary<string, (DateTimeOffset At, object Body)> Held = new();

    private readonly OrderFlowService _orderFlow;
    private readonly OiReplayService _oiReplay;

    public ExternalController(OrderFlowService orderFlow, OiReplayService oiReplay)
    {
        _orderFlow = orderFlow;
        _oiReplay = oiReplay;
    }

    public sealed record HeatmapAnswer(string Underlying, string Contract, decimal LastPrice, int LotSize, decimal RowSize, DateTimeOffset? Time,
        IReadOnlyList<HeatmapColumn> Heatmap);

    [HttpGet("{underlying}/heatmap")]
    public ActionResult<HeatmapAnswer> Heatmap(string underlying, [FromQuery] decimal rowSize = 5)
    {
        if (Pick(underlying) is not { } u) return BadRequest(new { error = "Only NIFTY and BANKNIFTY." });
        if (!RowSizes.Contains(rowSize)) return BadRequest(new { error = "Points per row: 1, 2, 5, 10, 20 or 50." });
        var key = $"heat|{u}|{rowSize}";
        if (Fresh(key, HeatmapHold) is HeatmapAnswer held) return held;

        var engine = _orderFlow.EngineFor(u);
        if (engine is null) return NotFound(new { error = $"{u} futures are not being tracked yet - try again shortly." });
        var snapshot = engine.Snapshot(rowSize, long.MaxValue, HeatmapColumns, rowSize);
        var answer = new HeatmapAnswer(u, snapshot.Meta.ContractSymbol, snapshot.Meta.LastPrice, snapshot.Meta.LotSize, rowSize,
            snapshot.Heatmap.LastOrDefault()?.Time, snapshot.Heatmap);
        Held[key] = (DateTimeOffset.UtcNow, answer);
        return answer;
    }

    public sealed record OiNetMinute(DateTimeOffset Time, long CeDelta, long PeDelta, long NetDelta, long CeCum, long PeCum, long NetCum);
    public sealed record OiNetAnswer(string Underlying, DateOnly Date, IReadOnlyList<OiNetMinute> Minutes);

    [HttpGet("{underlying}/oi-net")]
    public async Task<ActionResult<OiNetAnswer>> OiNet(string underlying, CancellationToken cancellationToken)
    {
        if (Pick(underlying) is not { } u) return BadRequest(new { error = "Only NIFTY and BANKNIFTY." });
        var key = $"oi|{u}";
        if (Fresh(key, OiHold) is OiNetAnswer held) return held;

        var today = IstClock.Today();
        var run = await _oiReplay.RunAsync(u, today, 1, u == "BANKNIFTY" ? "MONTH" : "WEEK", cancellationToken, forceLive: true);
        if (!run.Success) return StatusCode(StatusCodes.Status503ServiceUnavailable, new { error = "Today's OI is not available right now." });
        var answer = new OiNetAnswer(u, today, NetMinutes(run.CePoints, run.PePoints));
        Held[key] = (DateTimeOffset.UtcNow, answer);
        return answer;
    }

    /// <summary>Per minute, over every strike of the band: the OI change from that strike's previous reading summed
    /// (CE, PE), net = CE - PE, and the running totals since the first minute - OI Replay's OI totals rows.</summary>
    internal static IReadOnlyList<OiNetMinute> NetMinutes(IReadOnlyList<OiReplayPoint> ce, IReadOnlyList<OiReplayPoint> pe)
    {
        static Dictionary<DateTimeOffset, long> ChangeByMinute(IEnumerable<OiReplayPoint> points)
        {
            var byMinute = new Dictionary<DateTimeOffset, long>();
            foreach (var strike in points.Where(p => p.OpenInterest is not null).GroupBy(p => p.Strike))
            {
                long? previous = null;
                foreach (var p in strike.OrderBy(p => p.Time))
                {
                    if (previous is { } before) byMinute[p.Time] = byMinute.GetValueOrDefault(p.Time) + (p.OpenInterest!.Value - before);
                    else byMinute.TryAdd(p.Time, 0);
                    previous = p.OpenInterest;
                }
            }
            return byMinute;
        }
        var ceBy = ChangeByMinute(ce);
        var peBy = ChangeByMinute(pe);
        var minutes = ceBy.Keys.Union(peBy.Keys).OrderBy(t => t).ToList();
        var result = new List<OiNetMinute>(minutes.Count);
        long ceCum = 0, peCum = 0;
        foreach (var t in minutes)
        {
            var c = ceBy.GetValueOrDefault(t);
            var p = peBy.GetValueOrDefault(t);
            ceCum += c;
            peCum += p;
            result.Add(new OiNetMinute(t, c, p, c - p, ceCum, peCum, ceCum - peCum));
        }
        return result;
    }

    private static string? Pick(string underlying)
    {
        var u = (underlying ?? "").Trim().ToUpperInvariant();
        return Underlyings.Contains(u) ? u : null;
    }

    private static object? Fresh(string key, TimeSpan hold) =>
        Held.TryGetValue(key, out var held) && DateTimeOffset.UtcNow - held.At < hold ? held.Body : null;
}

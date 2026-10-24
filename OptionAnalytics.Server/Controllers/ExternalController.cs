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

    private readonly SpotFeedHostedService? _spotFeed;

    public ExternalController(OrderFlowService orderFlow, OiReplayService oiReplay, SpotFeedHostedService? spotFeed = null)
    {
        _orderFlow = orderFlow;
        _oiReplay = oiReplay;
        _spotFeed = spotFeed;
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
    /// <summary>Step: the strike step; SpotClose: the index's last 1-minute close (the ATM strike until live spot arrives).
    /// Date: the day shown - today, or the last trading day (Live false) on a weekend, a holiday or before the open.</summary>
    public sealed record OiAnswer(bool Success, string Underlying, DateOnly Date, int Step, decimal? SpotClose, IReadOnlyList<OiPoint> CePoints, IReadOnlyList<OiPoint> PePoints)
    {
        public bool Live { get; init; } = true;
        /// <summary>The day's index 1-minute candles (the Chart tab - OI Replay's spot chart).</summary>
        public IReadOnlyList<Candle> SpotCandlesOneMinute { get; init; } = Array.Empty<Candle>();
        /// <summary>The day's session VWAP - live, the spot feed's own (as /api/spot/{u}/vwap-series); a closed day, the run's.</summary>
        public IReadOnlyList<ObvPoint> SpotVwap { get; init; } = Array.Empty<ObvPoint>();
    }

    // The last trading day found for each index, kept until the date changes (a closed day never changes; its Dhan data is
    // kept on disk per day too - DhanDataCache - so a restart reads it back without asking Dhan again).
    private static readonly ConcurrentDictionary<string, (DateOnly Today, OiAnswer Answer)> LastDay = new();

    [HttpGet("{underlying}/oi")]
    public async Task<ActionResult<OiAnswer>> Oi(string underlying, CancellationToken cancellationToken)
    {
        if (Pick(underlying) is not { } u) return BadRequest(new { error = "Only NIFTY and BANKNIFTY." });
        var key = $"oi|{u}";
        if (Fresh(key, OiHold) is OiAnswer held) return held;

        var today = IstClock.Today();
        if (LastDay.TryGetValue(u, out var kept) && kept.Today == today && !MarketHours.IsOpen(DateTimeOffset.UtcNow)) return kept.Answer;
        var flag = u == "BANKNIFTY" ? "MONTH" : "WEEK";
        // Today as OI Replay's live view asks it (forceLive); any other day as OI Replay replays it.
        var picked = await PickDayAsync(today, (day, live) => _oiReplay.RunAsync(u, day, 1, flag, cancellationToken, forceLive: live));
        if (picked is not { } p) return StatusCode(StatusCodes.Status503ServiceUnavailable, new { error = "OI is not available right now." });
        var answer = new OiAnswer(true, u, p.Day, p.Run.Step, p.Run.SpotCandlesOneMinute.Count > 0 ? p.Run.SpotCandlesOneMinute[^1].Close : null,
            Cut(p.Run.CePoints), Cut(p.Run.PePoints))
        {
            Live = p.Day == today,
            SpotCandlesOneMinute = p.Run.SpotCandlesOneMinute,
            SpotVwap = p.Day == today && _spotFeed?.States.TryGetValue(u, out var spot) == true
                ? Services.Backtesting.VwapCalculator.ComputeSeries(spot.GetVolumeBars())
                : p.Run.SpotVwap,
        };
        Held[key] = (DateTimeOffset.UtcNow, answer);
        if (!answer.Live) LastDay[u] = (today, answer);
        return answer;
    }

    /// <summary>The day the External page shows: today when it is a weekday and today's run has OI; else (a weekend, a holiday,
    /// before the open, or today's run failing) the last trading day with OI - weekends skipped, a holiday (an empty day)
    /// stepped over, the walk stopped at a failed run (no loop of failing calls).</summary>
    internal static async Task<(DateOnly Day, OiReplayResult Run)?> PickDayAsync(DateOnly today, Func<DateOnly, bool, Task<OiReplayResult>> run)
    {
        static bool HasOi(OiReplayResult r) => r.Success && (r.CePoints.Count > 0 || r.PePoints.Count > 0);
        if (today.DayOfWeek is not (DayOfWeek.Saturday or DayOfWeek.Sunday))
        {
            var todays = await run(today, true);
            if (HasOi(todays)) return (today, todays);
        }
        // At most a week back: weekends are not asked; an empty day (a holiday) is stepped over; a failed run ends it.
        for (var day = today.AddDays(-1); day >= today.AddDays(-7); day = day.AddDays(-1))
        {
            if (day.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) continue;
            var r = await run(day, false);
            if (HasOi(r)) return (day, r);
            if (!r.Success) return null;
        }
        return null;
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

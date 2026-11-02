using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Services.SignalStrategies;

namespace OptionAnalytics.Server.Controllers;

/// <summary>
/// The Signal backtest's SAVED STRATEGIES (SignalStrategyStore - CSV) and their daily LIVE scan. The page (Admin and User
/// accounts - each its own strategies, an admin every account's): list, save, change (name, settings, the Live / Alerts /
/// Daily report switches), remove, and the history the live scan kept (and its CSV files). The live scan
/// (scanner-runner/signal-live.mjs, the server's Runner key only): the strategies on Live with what is sent today, and
/// where it posts the day's entries / exits and its report. The External account never reaches any of it.
/// </summary>
[ApiController]
[Route("api/signal-strategies")]
public sealed class SignalStrategyController : ControllerBase
{
    private const string PageRoles = AuthRoles.Admin + "," + AuthRoles.User;
    private readonly SignalStrategyStore _store;
    private readonly SignalLiveHostedService _live;

    public SignalStrategyController(SignalStrategyStore store, SignalLiveHostedService live)
    {
        _store = store;
        _live = live;
    }

    private string? Scope => User.IsInRole(AuthRoles.Admin) ? null : Owner;
    private string Owner => User.Identity?.Name ?? "";

    /// <summary>GET /api/signal-strategies - the strategies, with the last day reported and today's live events.</summary>
    [HttpGet("")]
    [Authorize(Roles = PageRoles)]
    public object List()
    {
        var today = SignalStrategyStore.TodayIst(DateTimeOffset.UtcNow);
        return new
        {
            today,
            liveScan = _live.State,
            strategies = _store.List(Scope).Select(s =>
            {
                var (last, events) = _store.Glance(s.Id, today);
                return new { s.Id, s.Name, s.Owner, s.Underlying, s.Live, s.Alerts, s.DailyReport, s.CreatedUtc, s.UpdatedUtc, s.Settings, lastDay = last, eventsToday = events };
            }),
        };
    }

    [HttpPost("")]
    [Authorize(Roles = PageRoles)]
    public IActionResult Create([FromBody] SignalStrategyRequest request)
    {
        var (strategy, error) = _store.Create(Owner, request, DateTimeOffset.UtcNow);
        return strategy is null ? BadRequest(new { error }) : Ok(strategy);
    }

    [HttpPut("{id}")]
    [Authorize(Roles = PageRoles)]
    public IActionResult Update(string id, [FromBody] SignalStrategyRequest request)
    {
        var (strategy, error) = _store.Update(id, Scope, request, DateTimeOffset.UtcNow);
        return strategy is not null ? Ok(strategy) : error == "No such strategy." ? NotFound(new { error }) : BadRequest(new { error });
    }

    [HttpDelete("{id}")]
    [Authorize(Roles = PageRoles)]
    public IActionResult Delete(string id) => _store.Delete(id, Scope) ? NoContent() : NotFound(new { error = "No such strategy." });

    /// <summary>GET /api/signal-strategies/{id}/history - the days the live scan reported, their trades, the latest events.</summary>
    [HttpGet("{id}/history")]
    [Authorize(Roles = PageRoles)]
    public IActionResult History(string id) => _store.Get(id, Scope) is null ? NotFound(new { error = "No such strategy." }) : Ok(_store.History(id));

    /// <summary>GET /api/signal-strategies/{id}/history/{days|trades|events}.csv - the file itself.</summary>
    [HttpGet("{id}/history/{kind}.csv")]
    [Authorize(Roles = PageRoles)]
    public IActionResult HistoryCsv(string id, string kind)
    {
        var strategy = _store.Get(id, Scope);
        if (strategy is null || !SignalStrategyStore.HistoryKinds.Contains(kind)) return NotFound(new { error = "No such history." });
        var path = _store.HistoryPath(id, kind);
        var name = $"{string.Concat(strategy.Name.Select(c => char.IsLetterOrDigit(c) ? c : '-'))}-{kind}.csv";
        return System.IO.File.Exists(path) ? PhysicalFile(path, "text/csv", name) : File(System.Text.Encoding.UTF8.GetBytes(string.Join(',', Columns(kind)) + "\n"), "text/csv", name);
    }

    private static string[] Columns(string kind) => kind switch
    {
        "days" => SignalStrategyStore.DayColumns,
        "trades" => SignalStrategyStore.TradeColumns,
        _ => SignalStrategyStore.EventColumns,
    };

    // ---- The live scan (the Runner key only) ----------------------------------------------------------------------------

    /// <summary>GET /api/signal-strategies/live - the strategies on Live, with today's events already kept and whether the
    /// day is reported.</summary>
    [HttpGet("live")]
    [Authorize(Roles = ScannerRunnerKey.Role)]
    public object Live()
    {
        var today = SignalStrategyStore.TodayIst(DateTimeOffset.UtcNow);
        return new
        {
            today,
            strategies = _store.LiveStrategies().Select(s => new { s.Id, s.Name, s.Settings, sent = _store.EventKeys(s.Id, today), reported = _store.Reported(s.Id, today) }),
        };
    }

    public sealed record LiveEventsRequest(string? StrategyId, string? Date, List<SignalLiveEvent>? Events);

    [HttpPost("live/events")]
    [Authorize(Roles = ScannerRunnerKey.Role)]
    public async Task<IActionResult> LiveEvents([FromBody] LiveEventsRequest request)
    {
        if (request?.StrategyId is not { } id || !IsDate(request.Date)) return BadRequest(new { error = "strategyId and date are needed." });
        var added = await _store.RecordEventsAsync(id, request.Date!, (request.Events ?? new()).Take(200).ToList(), DateTimeOffset.UtcNow);
        return Ok(new { added });
    }

    public sealed record LiveDayRequest(string? StrategyId, string? Date, JsonObject? Day, JsonArray? Trades, string? Text);

    [HttpPost("live/day")]
    [Authorize(Roles = ScannerRunnerKey.Role)]
    public async Task<IActionResult> LiveDay([FromBody] LiveDayRequest request)
    {
        if (request?.StrategyId is not { } id || !IsDate(request.Date) || request.Day is null) return BadRequest(new { error = "strategyId, date and day are needed." });
        var first = await _store.RecordDayAsync(id, request.Date!, request.Day, request.Trades, request.Text, DateTimeOffset.UtcNow);
        return Ok(new { first });
    }

    private static bool IsDate(string? s) => DateOnly.TryParseExact(s, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out _);
}

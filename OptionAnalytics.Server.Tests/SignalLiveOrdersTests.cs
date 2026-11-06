using System.Security.Claims;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Controllers;
using OptionAnalytics.Server.Services;
using OptionAnalytics.Server.Services.SignalStrategies;

namespace OptionAnalytics.Server.Tests;

/// <summary>SignalLiveOrders - a saved strategy's LIVE Dhan orders, on a fake Dhan: only for a strategy an admin armed; a
/// fresh entry (the rule's and the mirror's) placed as a super order of the TRADED index's option with the Trade settings'
/// lots and slippage and the strategy's own SL / target in points (the Trade settings' where it has none), 15:10 behind it;
/// a late entry, one already exited, one while another is open, past the day's Max trades or past 15:10 NOT placed (kept,
/// with why, and sent); the strategy's exit closes exactly the entry's orders (legs cancelled, then out) - after a restart
/// and after the switch is turned off too - and a failed exit goes to the server's time-exit retries; each event acts once.</summary>
public sealed class SignalLiveOrdersTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "oa-slo-" + Guid.NewGuid().ToString("n"));
    private const string Date = "2026-10-26";                                                     // a Monday
    private static readonly DateTimeOffset Now = new(2026, 10, 26, 10, 2, 10, TimeSpan.FromHours(5.5));
    private static readonly long EntryMs = new DateTimeOffset(2026, 10, 26, 10, 1, 0, TimeSpan.FromHours(5.5)).ToUnixTimeMilliseconds();

    private sealed class FakeHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "Tests";
        public string ContentRootPath { get; set; } = "";
        public IFileProvider ContentRootFileProvider { get; set; } = null!;
    }

    /// <summary>A fake Dhan behind LiveTradingService's order path: what was asked, and what it answers.</summary>
    private sealed class FakeDhan : ISignalOrderGateway
    {
        public List<ManualOrderRequest> Placed { get; } = new();
        public List<(IReadOnlyList<string> Ids, decimal Slippage, bool OnlyWithWorkingLegs)> Exits { get; } = new();
        public List<(IReadOnlyList<string> Ids, DateTimeOffset At, string Reason)> TimeExits { get; } = new();
        public List<IReadOnlyList<string>> Cleared { get; } = new();
        public Func<ManualOrderRequest, ManualOrderResult>? OnPlace { get; set; }
        public ManualOrderResult ExitResult { get; set; } = new(true, "STOP_LOSS_LEG cancelled · TARGET_LEG cancelled · SELL x3 at LIMIT 101.5 to close this trade", new[] { "x1" }, null);
        private int _next = 100;

        public Task<ManualOrderResult> PlaceAsync(ManualOrderRequest request, CancellationToken cancellationToken)
        {
            Placed.Add(request);
            return Task.FromResult(OnPlace?.Invoke(request)
                ?? new ManualOrderResult(true, $"{request.Direction} {request.Underlying} {request.Strike}{request.Side} at LIMIT 101", new[] { $"o{_next++}" }, null));
        }

        public Task<ManualOrderResult> ExitTradeAsync(IReadOnlyList<string> orderIds, decimal slippagePoints, CancellationToken cancellationToken, bool onlyWithWorkingLegs)
        {
            Exits.Add((orderIds, slippagePoints, onlyWithWorkingLegs));
            return Task.FromResult(ExitResult);
        }

        public DateTimeOffset? SetTimeExit(IReadOnlyList<string> orderIds, DateTimeOffset exitAt, decimal slippagePoints, string reason)
        {
            TimeExits.Add((orderIds, exitAt, reason));
            return exitAt;
        }

        public void ClearTimeExit(IReadOnlyList<string> orderIds) => Cleared.Add(orderIds);
    }

    private SignalStrategyStore Store()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Storage:ScannerRunnerPath"] = Path.Combine(_dir, "runner") }).Build();
        return new SignalStrategyStore(new ScannerRunnerStore(new FakeHostEnvironment { ContentRootPath = _dir }, config), NullLogger<SignalStrategyStore>.Instance)
        {
            NotifyOverride = _ => Task.CompletedTask,
        };
    }

    private TradeSettingsStore TradeSettings()
    {
        var store = new TradeSettingsStore(new FakeHostEnvironment { ContentRootPath = _dir },
            new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Storage:TradeSettingsPath"] = Path.Combine(_dir, "trade-settings.csv") }).Build(),
            NullLogger<TradeSettingsStore>.Instance);
        // SENSEX: 3 lots, 1.5 points slippage, SL 60 / target 90 (its defaults).
        store.Save("SENSEX", TradeSettingsStore.Default("SENSEX") with { Lots = 3, SlippagePoints = 1.5m });
        return store;
    }

    private static SignalLiveOrders Orders(SignalStrategyStore store, TradeSettingsStore settings, FakeDhan dhan, List<string>? telegrams = null, DateTimeOffset? now = null) =>
        new(store, settings, dhan, NullLogger<SignalLiveOrders>.Instance)
        {
            UtcNow = () => now ?? Now,
            NotifyOverride = text => { telegrams?.Add(text); return Task.CompletedTask; },
        };

    /// <summary>A strategy reading NIFTY and trading in SENSEX, at most <paramref name="maxTrades"/> a day - armed by an admin
    /// unless asked not to.</summary>
    private static SignalStrategy Strategy(SignalStrategyStore store, bool armed = true, int maxTrades = 2)
    {
        var settings = new JsonObject
        {
            ["underlying"] = "NIFTY", ["tradeIn"] = "SENSEX", ["maxTradesPerDay"] = maxTrades, ["slPct"] = 30, ["timeframe"] = 5,
            ["rule"] = new JsonObject { ["tree"] = new JsonObject { ["op"] = "or", ["items"] = new JsonArray() }, ["action"] = "buyCE", ["mirror"] = true },
        };
        var s = store.Create("admin@x.com", new SignalStrategyRequest("VWAP cross", settings, Live: true, Alerts: false, DailyReport: false), Now).Strategy!;
        return armed ? store.Update(s.Id, null, new SignalStrategyRequest(LiveOrders: true), Now).Strategy! : s;
    }

    private static SignalLiveTrade Trade(long entryMs = 0, string strategy = "rule", decimal sl = 30.6m, decimal target = 0, string? exitReason = null, string side = "CE") =>
        new($"{Date}|{strategy}|{(entryMs == 0 ? EntryMs : entryMs)}", "SENSEX", "2026-10-29", 82000, side, "BUY", 102, entryMs == 0 ? EntryMs : entryMs, sl, target, strategy, exitReason);

    private static SignalLiveEvent Entry(SignalLiveTrade t) => new($"{t.Key}|entry", "entry", "🟢 entry", t);
    private static SignalLiveEvent Exit(SignalLiveTrade t) => new($"{t.Key}|exit", "exit", "✅ exit", t with { ExitReason = t.ExitReason ?? "Trailing stop" });

    /// <summary>As the controller does it: the store keeps the events, the NEW ones go to the orders.</summary>
    private static async Task Post(SignalStrategyStore store, SignalLiveOrders orders, string id, params SignalLiveEvent[] events)
    {
        var (strategy, fresh) = await store.KeepEventsAsync(id, Date, events, Now);
        if (strategy is not null && fresh.Count > 0) await orders.HandleAsync(strategy, Date, fresh, CancellationToken.None);
    }

    [Fact]
    public async Task An_armed_strategys_fresh_entry_is_a_super_order_and_its_exit_cancels_the_legs_and_closes_it()
    {
        var store = Store();
        var dhan = new FakeDhan();
        var telegrams = new List<string>();
        var orders = Orders(store, TradeSettings(), dhan, telegrams);
        var s = Strategy(store);
        var t = Trade();
        await Post(store, orders, s.Id, Entry(t));
        var placed = Assert.Single(dhan.Placed);
        // The TRADED index's option; lots and slippage from its Trade settings; SL = the strategy's points, target (none on the
        // strategy) = the Trade settings'; the server squares it off at 15:10 IST.
        Assert.Equal(("SENSEX", new DateOnly(2026, 10, 29), 82000m, "CE", "BUY"), (placed.Underlying, placed.Expiry, placed.Strike, placed.Side, placed.Direction));
        Assert.Equal(3, placed.Lots);
        Assert.Equal(1.5m, placed.SlippagePoints);
        Assert.Equal(30.6m, placed.StopLossPoints);
        Assert.Equal(90m, placed.TargetPoints);
        Assert.False(placed.NoStop);                                                                    // a super order: both legs
        Assert.Equal(0m, placed.TrailGapPoints);                                                        // the strategy's own trail drives
        Assert.Equal(new DateTimeOffset(2026, 10, 26, 15, 10, 0, TimeSpan.FromHours(5.5)).ToUnixTimeMilliseconds(), placed.ExitAtMs);
        var row = Assert.Single(store.Orders(s.Id, Date));
        Assert.Equal(("entry", "placed", "SENSEX 82000 CE", 3), (row.Kind, row.Status, row.Option, row.Lots));
        Assert.Equal(new[] { "o100" }, row.OrderIds);
        Assert.Contains("LIVE order placed", Assert.Single(telegrams));

        // The strategy's exit (its trailing stop): the entry's orders - working legs cancelled, then out - at its slippage.
        await Post(store, orders, s.Id, Exit(t));
        var exit = Assert.Single(dhan.Exits);
        Assert.Equal(new[] { "o100" }, exit.Ids);
        Assert.Equal(1.5m, exit.Slippage);
        Assert.True(exit.OnlyWithWorkingLegs);                                                          // closed by Dhan's own leg = nothing to do
        Assert.Equal(new[] { "o100" }, Assert.Single(dhan.Cleared));                                    // its 15:10 time exit dropped
        Assert.Equal("exited", store.Orders(s.Id, Date)[1].Status);
        Assert.Contains("Trailing stop", store.Orders(s.Id, Date)[1].Message);
        Assert.Contains("LIVE exit", telegrams[1]);

        // The same events again (a retry, a restart of the scan): nothing more reaches Dhan.
        await Post(store, orders, s.Id, Entry(t), Exit(t));
        Assert.Single(dhan.Placed);
        Assert.Single(dhan.Exits);
        // Even handed to the orders directly, an exit already done is not done twice.
        await orders.HandleAsync(s, Date, new[] { Exit(t) }, CancellationToken.None);
        Assert.Single(dhan.Exits);
        Assert.StartsWith("timeUtc,date,trade,kind,status,underlying,option,action,lots,orderIds,message", File.ReadAllText(store.HistoryPath(s.Id, "orders")));
        Assert.Equal(2, store.History(s.Id).Orders.Count);
    }

    [Fact]
    public async Task Not_armed_nothing_goes_to_Dhan_and_nothing_is_kept()
    {
        var store = Store();
        var dhan = new FakeDhan();
        var telegrams = new List<string>();
        var orders = Orders(store, TradeSettings(), dhan, telegrams);
        var s = Strategy(store, armed: false);
        Assert.False(s.LiveOrders);
        var t = Trade();
        await Post(store, orders, s.Id, Entry(t));
        await Post(store, orders, s.Id, Exit(t));
        Assert.Empty(dhan.Placed);
        Assert.Empty(dhan.Exits);
        Assert.Empty(store.Orders(s.Id, Date));
        Assert.Empty(telegrams);
    }

    [Fact]
    public async Task The_mirrors_entries_go_live_too()
    {
        var store = Store();
        var dhan = new FakeDhan();
        var orders = Orders(store, TradeSettings(), dhan);
        var s = Strategy(store);
        var t = Trade(strategy: "mirror", side: "PE");
        await Post(store, orders, s.Id, Entry(t));
        Assert.Equal("PE", Assert.Single(dhan.Placed).Side);
        await Post(store, orders, s.Id, Exit(t));
        Assert.Single(dhan.Exits);
    }

    [Fact]
    public async Task Late_already_exited_past_1510_or_while_another_is_open_is_not_placed_but_kept_and_sent()
    {
        var store = Store();
        var dhan = new FakeDhan();
        var telegrams = new List<string>();
        var s = Strategy(store, maxTrades: 5);
        var orders = Orders(store, TradeSettings(), dhan, telegrams);
        // Seen 10 minutes after its signal minute (a restart): skipped.
        var late = Trade(entryMs: EntryMs - 9 * 60_000);
        await Post(store, orders, s.Id, Entry(late));
        // Its entry and exit in one batch: it had ended before it was seen.
        var gone = Trade(strategy: "mirror");
        await Post(store, orders, s.Id, Entry(gone), Exit(gone));
        Assert.Empty(dhan.Placed);
        Assert.Empty(dhan.Exits);                                                                      // no live order to close
        var rows = store.Orders(s.Id, Date);
        Assert.Equal(new[] { "skipped", "skipped" }, rows.Select(r => r.Status));
        Assert.Contains("seen late", rows[0].Message);
        Assert.Contains("already exited", rows[1].Message);
        Assert.Equal(2, telegrams.Count);
        Assert.All(telegrams, x => Assert.Contains("NOT placed", x));
        // One open: the next entry waits for its exit (the engine trades one at a time).
        var first = Trade();
        await Post(store, orders, s.Id, Entry(first));
        var second = Trade(entryMs: EntryMs + 60_000);
        var lateOrders = Orders(store, TradeSettings(), dhan, telegrams, Now.AddMinutes(1));
        await Post(store, lateOrders, s.Id, Entry(second));
        Assert.Single(dhan.Placed);
        Assert.Contains("has no exit yet", store.Orders(s.Id, Date).Last().Message);
        // Past 15:10: nothing new.
        var evening = Orders(store, TradeSettings(), dhan, telegrams, new DateTimeOffset(2026, 10, 26, 15, 11, 0, TimeSpan.FromHours(5.5)));
        await Post(store, evening, s.Id, Exit(first));
        var after = Trade(entryMs: new DateTimeOffset(2026, 10, 26, 15, 10, 0, TimeSpan.FromHours(5.5)).ToUnixTimeMilliseconds());
        await Post(store, evening, s.Id, Entry(after));
        Assert.Single(dhan.Placed);
        Assert.Contains("past 15:10", store.Orders(s.Id, Date).Last().Message);
    }

    [Fact]
    public async Task No_more_than_the_strategys_max_trades_a_day()
    {
        var store = Store();
        var dhan = new FakeDhan();
        var s = Strategy(store, maxTrades: 1);
        var a = Trade();
        await Post(store, Orders(store, TradeSettings(), dhan), s.Id, Entry(a));
        await Post(store, Orders(store, TradeSettings(), dhan), s.Id, Exit(a));                            // closed - none open
        var b = Trade(entryMs: EntryMs + 60_000);
        await Post(store, Orders(store, TradeSettings(), dhan, now: Now.AddMinutes(1)), s.Id, Entry(b));
        Assert.Single(dhan.Placed);
        Assert.Contains("1 live trade placed today already", store.Orders(s.Id, Date).Last().Message);
    }

    [Fact]
    public async Task A_refused_order_is_kept_with_why_and_its_exit_does_nothing()
    {
        var store = Store();
        var dhan = new FakeDhan { OnPlace = _ => ManualOrderResult.Fail("Blocked: the day's loss limit was reached (kill switch).") };
        var telegrams = new List<string>();
        var orders = Orders(store, TradeSettings(), dhan, telegrams);
        var s = Strategy(store);
        var t = Trade();
        await Post(store, orders, s.Id, Entry(t));
        var row = Assert.Single(store.Orders(s.Id, Date));
        Assert.Equal("not placed", row.Status);
        Assert.Contains("kill switch", row.Message);
        Assert.Contains("NOT PLACED", telegrams[0]);
        await Post(store, orders, s.Id, Exit(t));
        Assert.Empty(dhan.Exits);
        // And it does not count as open: the next fresh entry is placed.
        dhan.OnPlace = null;
        var next = Trade(entryMs: EntryMs + 60_000);
        await Post(store, Orders(store, TradeSettings(), dhan, now: Now.AddMinutes(1)), s.Id, Entry(next));
        Assert.Equal(2, dhan.Placed.Count);
        Assert.Equal("placed", store.Orders(s.Id, Date).Last().Status);
    }

    [Fact]
    public async Task A_failed_exit_is_handed_to_the_servers_time_exit_retries()
    {
        var store = Store();
        var dhan = new FakeDhan { ExitResult = ManualOrderResult.Fail("not logged in to Dhan right now") };
        var telegrams = new List<string>();
        var orders = Orders(store, TradeSettings(), dhan, telegrams);
        var s = Strategy(store);
        var t = Trade();
        await Post(store, orders, s.Id, Entry(t));
        await Post(store, orders, s.Id, Exit(t));
        var retry = Assert.Single(dhan.TimeExits);
        Assert.Equal(new[] { "o100" }, retry.Ids);
        Assert.Equal(Now.AddSeconds(2), retry.At);
        Assert.Empty(dhan.Cleared);
        Assert.Equal("exit failed", store.Orders(s.Id, Date).Last().Status);
        Assert.Contains("LIVE exit FAILED", telegrams.Last());
    }

    [Fact]
    public async Task The_exit_still_closes_the_order_after_a_restart_and_after_live_orders_are_turned_off()
    {
        var store = Store();
        var dhan = new FakeDhan();
        var s = Strategy(store);
        var t = Trade();
        await Post(store, Orders(store, TradeSettings(), dhan), s.Id, Entry(t));
        // Turned off, then the server restarts: the open trade's exit still closes its orders (kept in the CSV).
        store.Update(s.Id, null, new SignalStrategyRequest(LiveOrders: false), Now);
        var restarted = Store();
        await Post(restarted, Orders(restarted, TradeSettings(), dhan), s.Id, Exit(t));
        Assert.Equal(new[] { "o100" }, Assert.Single(dhan.Exits).Ids);
        // But no new entry while it is off.
        await Post(restarted, Orders(restarted, TradeSettings(), dhan, now: Now.AddMinutes(1)), s.Id, Entry(Trade(entryMs: EntryMs + 60_000)));
        Assert.Single(dhan.Placed);
    }

    [Fact]
    public async Task Only_an_admin_switches_live_orders_and_another_accounts_new_settings_turn_them_off()
    {
        var store = Store();
        var mine = store.Create("user@x.com", new SignalStrategyRequest("Mine", Strategy(store, armed: false).Settings, Live: true, LiveOrders: true), Now).Strategy!;
        Assert.False(mine.LiveOrders);                                                                  // never saved armed
        Assert.Contains("Only an admin", store.Update(mine.Id, "user@x.com", new SignalStrategyRequest(LiveOrders: true), Now).Error);
        var armed = store.Update(mine.Id, null, new SignalStrategyRequest(LiveOrders: true), Now).Strategy!;
        Assert.True(armed.LiveOrders);
        // Its owner's switches leave it armed; its owner's new settings disarm it; an admin's keep it.
        Assert.True(store.Update(mine.Id, "user@x.com", new SignalStrategyRequest(Alerts: false), Now).Strategy!.LiveOrders);
        Assert.False(store.Update(mine.Id, "user@x.com", new SignalStrategyRequest(Settings: armed.Settings), Now).Strategy!.LiveOrders);
        store.Update(mine.Id, null, new SignalStrategyRequest(LiveOrders: true), Now);
        Assert.True(store.Update(mine.Id, null, new SignalStrategyRequest(Settings: armed.Settings), Now).Strategy!.LiveOrders);
        // Kept in the CSV and read back; a file written before the column reads as off.
        Assert.True(Store().Get(mine.Id, null)!.LiveOrders);
        var path = Path.Combine(_dir, "runner", "signal-strategies", "strategies.csv");
        var lines = File.ReadAllLines(path);
        File.WriteAllLines(path, lines.Select(l => l[..l.LastIndexOf(',')]));
        Assert.False(Store().Get(mine.Id, null)!.LiveOrders);

        // Through the controller: a User account gets 403 for the switch; the list says whether each is armed.
        var controller = Controller(store, new FakeDhan(), AuthRoles.User);
        var refused = Assert.IsType<ObjectResult>(controller.Update(mine.Id, new SignalStrategyRequest(LiveOrders: true)));
        Assert.Equal(StatusCodes.Status403Forbidden, refused.StatusCode);
        Assert.IsType<OkObjectResult>(Controller(store, new FakeDhan(), AuthRoles.Admin).Update(mine.Id, new SignalStrategyRequest(LiveOrders: true)));
        Assert.True(store.Get(mine.Id, null)!.LiveOrders);
    }

    [Fact]
    public async Task The_runners_events_through_the_controller_place_once()
    {
        var store = Store();
        var dhan = new FakeDhan();
        var s = Strategy(store);
        var controller = Controller(store, dhan, ScannerRunnerKey.Role);
        var t = Trade(entryMs: DateTimeOffset.UtcNow.AddSeconds(-70).ToUnixTimeMilliseconds() / 60_000 * 60_000);
        var request = new SignalStrategyController.LiveEventsRequest(s.Id, SignalStrategyStore.TodayIst(DateTimeOffset.UtcNow), new List<SignalLiveEvent> { Entry(t) with { Trade = t } });
        await controller.LiveEvents(request);
        await controller.LiveEvents(request);
        // The controller's clock is the real one: the order goes unless it is past 15:10 IST right now.
        var expected = IstClock.MinutesOfDay(DateTimeOffset.UtcNow) < LiveTradingService.TimeExitCutoffMinute ? 1 : 0;
        Assert.Equal(expected, dhan.Placed.Count);
        Assert.Single(store.Orders(s.Id, request.Date!));                                               // placed or skipped - once
    }

    private SignalStrategyController Controller(SignalStrategyStore store, FakeDhan dhan, string role)
    {
        var orders = new SignalLiveOrders(store, TradeSettings(), dhan, NullLogger<SignalLiveOrders>.Instance) { NotifyOverride = _ => Task.CompletedTask };
        return new SignalStrategyController(store, null!, orders, NullLogger<SignalStrategyController>.Instance)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim(ClaimTypes.Name, "who@x.com"), new Claim(ClaimTypes.Role, role) }, "Test")),
                },
            },
        };
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { /* best effort */ }
    }
}

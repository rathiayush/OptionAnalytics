using System.Diagnostics;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// EVERY LIVE ORDER SCENARIO (asked for - "add tests for all scenarios, it is very critical"): LiveTradingService against the fake Dhan
/// (LiveTradingPartialExitTests' FakeDhan - this is the same class, split in two files). Entries (buy / sell, rejected, chased, blocked),
/// exits (legs cancelled first, a refused cancel read again, a short bought back, the chase stopping once filled), the order gate (an exit /
/// a stop-loss move first) and Dhan's rate limits. The panel's own orders (no OrderChase) are held to behave as before.
/// </summary>
public sealed partial class LiveTradingPartialExitTests
{
    private static DateOnly Expiry => DateOnly.FromDateTime(DateTime.Today.AddDays(20));
    private static OrderChase Chase(int attempts = 5, int rejects = 4, int intervalMs = 40, int retryMs = 10) =>
        new(TimeSpan.FromMilliseconds(intervalMs), attempts, 3, rejects, TimeSpan.FromMilliseconds(retryMs));
    private static ManualOrderRequest Buy(OrderChase? chase = null, string direction = "BUY") =>
        new("NIFTY", Expiry, 26000, "CE", direction, 1, 1m, 20m, 40m, Chase: chase);
    private static IEnumerable<JsonObject> EntryModifies(FakeDhan dhan)
    {
        lock (dhan.SuperModifies) return dhan.SuperModifies.Where(m => m["legName"]!.GetValue<string>() == "ENTRY_LEG").ToList();
    }

    // ---- ENTRIES -----------------------------------------------------------------------------------------------------------

    [Fact]
    public async Task Entry_buy_is_a_super_order_at_the_ask_plus_slippage_its_legs_from_the_ask()
    {
        var (service, dhan, _) = await CreateAsync();                                   // bid 120, ask 120.50
        var result = await service.PlaceAsync(Buy(Chase()), CancellationToken.None);
        Assert.True(result.Success, result.Message);
        var sent = Assert.Single(dhan.SuperPlaces);
        Assert.Equal((121.5m, 160.5m, 100.5m, "BUY"), sent);                          // limit ask + 1, target ask + 40, stop ask - 20
        Assert.Single(result.OrderIds);
    }

    [Fact]
    public async Task Entry_sell_is_priced_off_the_bid_minus_slippage_its_target_below_and_stop_above()
    {
        var (service, dhan, _) = await CreateAsync();
        var result = await service.PlaceAsync(Buy(Chase(), "SELL"), CancellationToken.None);
        Assert.True(result.Success, result.Message);
        Assert.Equal((119m, 80m, 140m, "SELL"), Assert.Single(dhan.SuperPlaces));      // limit bid - 1, target bid - 40, stop bid + 20
    }

    [Fact]
    public async Task Entry_rejected_every_time_is_sent_5_times_in_all_its_slippage_2x_then_3x_never_more()
    {
        var (service, dhan, _) = await CreateAsync();
        dhan.RejectNextPlaces = 99;
        var result = await service.PlaceAsync(Buy(Chase()), CancellationToken.None);
        Assert.False(result.Success);
        Assert.Contains("rejected", result.Message);
        Assert.Equal(new[] { 121.5m, 122.5m, 123.5m, 123.5m, 123.5m }, dhan.SuperPlaces.Select(p => p.Price));
        Assert.Empty(result.OrderIds);
    }

    [Fact]
    public async Task Entry_from_the_panel_with_no_chase_is_sent_once_and_never_repriced()
    {
        var (service, dhan, feed) = await CreateAsync();
        dhan.RejectNextPlaces = 1;
        Assert.False((await service.PlaceAsync(Buy(), CancellationToken.None)).Success);
        Assert.Single(dhan.SuperPlaces);                                                // rejected = reported, not retried

        var placed = await service.PlaceAsync(Buy(), CancellationToken.None);
        Assert.True(placed.Success, placed.Message);
        feed.SetLastTickForTesting(Tick(bid: 130m, ask: 130.5m, last: 130m));          // the market runs away
        await Task.Delay(300);
        Assert.Empty(EntryModifies(dhan));                                              // the panel's entry is left as placed
    }

    [Fact]
    public async Task Entry_blocked_by_the_kill_switch_never_reaches_Dhan_and_is_not_retried()
    {
        var (service, dhan, _) = await CreateAsync();
        service.NewOrderBlock = () => "daily loss limit reached";
        var result = await service.PlaceAsync(Buy(Chase()), CancellationToken.None);
        Assert.False(result.Success);
        Assert.Contains("daily loss limit", result.Message);
        Assert.Empty(dhan.SuperPlaces);
        Assert.DoesNotContain(dhan.Requests, r => r.StartsWith("POST"));
    }

    [Fact]
    public async Task Entry_unfilled_is_repriced_5_times_a_second_apart_its_legs_keep_their_distance()
    {
        var (service, dhan, feed) = await CreateAsync();
        var result = await service.PlaceAsync(Buy(Chase(attempts: 5, intervalMs: 40)), CancellationToken.None);
        Assert.True(result.Success, result.Message);
        // The ask keeps rising - every look has a new price to go to.
        using var stop = new CancellationTokenSource();
        var rising = Task.Run(async () =>
        {
            for (var ask = 121m; !stop.IsCancellationRequested; ask += 0.5m)
            {
                feed.SetLastTickForTesting(Tick(bid: ask - 0.5m, ask: ask, last: ask));
                await Task.Delay(5);
            }
        });
        await Task.Delay(600);
        stop.Cancel();
        await rising;
        var moves = EntryModifies(dhan).ToList();
        Assert.Equal(5, moves.Count);                                                   // 5 re-prices, then left resting
        foreach (var m in moves)
        {
            var price = m["price"]!.GetValue<decimal>();
            Assert.Equal(40m - 1m, m["targetPrice"]!.GetValue<decimal>() - price);      // the target stays 39 over the LIMIT (40 over the ask it was priced at)
            Assert.Equal(-21m, m["stopLossPrice"]!.GetValue<decimal>() - price);       // the stop 21 under it
            Assert.Equal((Lot, "LIMIT"), (m["quantity"]!.GetValue<int>(), m["orderType"]!.GetValue<string>()));
        }
    }

    [Fact]
    public async Task Entry_chase_never_goes_past_3x_the_slippage()
    {
        var (service, dhan, feed) = await CreateAsync();
        Assert.True((await service.PlaceAsync(Buy(Chase(attempts: 5, intervalMs: 30)), CancellationToken.None)).Success);
        feed.SetLastTickForTesting(Tick(bid: 124.5m, ask: 125m, last: 125m));          // one jump, then still
        await Task.Delay(400);
        var prices = EntryModifies(dhan).Select(m => m["price"]!.GetValue<decimal>()).ToList();
        Assert.NotEmpty(prices);
        Assert.Equal(128m, prices[^1]);                                                 // 125 + 1 x 3 - the cap
        Assert.All(prices, p => Assert.True(p <= 128m, $"{p} past 3x"));
    }

    [Theory]
    [InlineData("TRADED")]
    [InlineData("CANCELLED")]
    [InlineData("REJECTED")]
    public async Task Entry_chase_stops_once_the_entry_is_no_longer_pending(string status)
    {
        var (service, dhan, feed) = await CreateAsync();
        var result = await service.PlaceAsync(Buy(Chase(attempts: 5, intervalMs: 60)), CancellationToken.None);
        lock (dhan.SuperOrders) dhan.SuperOrders.Single(o => o["orderId"]!.GetValue<string>() == result.OrderIds[0])["orderStatus"] = status;
        feed.SetLastTickForTesting(Tick(bid: 130m, ask: 130.5m, last: 130m));
        await Task.Delay(400);
        Assert.Empty(EntryModifies(dhan));
    }

    [Fact]
    public async Task Entry_retrying_a_rejection_gives_way_to_an_exit_that_is_waiting()
    {
        var (service, dhan, _) = await CreateAsync();
        dhan.RejectNextPlaces = 99;
        dhan.RejectEntriesOnly = true;
        var entry = service.PlaceAsync(Buy(Chase(retryMs: 300)), CancellationToken.None);   // 5 sends would take > 1 s
        await WaitFor(() => dhan.SuperPlaces.Count >= 1);
        var clock = Stopwatch.StartNew();
        var exit = service.ExitTradeAsync(new[] { "S1" }, 1m, CancellationToken.None, onlyWithWorkingLegs: true, Chase());
        var entryResult = await entry;
        var exitResult = await exit;
        Assert.False(entryResult.Success);
        Assert.True(dhan.SuperPlaces.Count < 5, $"the entry stopped retrying ({dhan.SuperPlaces.Count} sends)");
        Assert.True(exitResult.Success, exitResult.Message);
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(1), "the exit did not wait out the entry's retries");
        Assert.Contains(dhan.Orders.Values, o => o.Tag.StartsWith("OIRX-"));
    }

    // ---- EXITS -------------------------------------------------------------------------------------------------------------

    [Fact]
    public async Task Exit_cancels_both_legs_before_the_exit_order_goes()
    {
        var (service, dhan, _) = await CreateAsync();
        var result = await service.ExitTradeAsync(new[] { "S1" }, 1m, CancellationToken.None, onlyWithWorkingLegs: true, Chase());
        Assert.True(result.Success, result.Message);
        var post = dhan.Requests.IndexOf("POST /orders");
        Assert.True(post > 0);
        Assert.InRange(dhan.Requests.IndexOf("DELETE /super/orders/S1/TARGET_LEG"), 0, post - 1);
        Assert.InRange(dhan.Requests.IndexOf("DELETE /super/orders/S1/STOP_LOSS_LEG"), 0, post - 1);
        var exit = Assert.Single(dhan.Orders.Values, o => o.Tag.StartsWith("OIRX-"));
        Assert.Equal(("SELL", 4 * Lot, 119m), (exit.Side, exit.Quantity, exit.Price)); // bid 120 - 1, the trade's whole quantity
    }

    [Fact]
    public async Task Exit_after_a_refused_cancel_whose_leg_is_gone_after_all_goes_out()
    {
        var (service, dhan, _) = await CreateAsync();
        var s1 = dhan.SuperOrders.Single(o => o["orderId"]!.GetValue<string>() == "S1");
        dhan.RefuseCancel.Add("S1/STOP_LOSS_LEG");
        dhan.OnRefusedCancel = () => s1["legDetails"]![1]!["orderStatus"] = "CANCELLED";   // Dhan refused, yet the leg is gone
        var result = await service.ExitTradeAsync(new[] { "S1" }, 1m, CancellationToken.None, onlyWithWorkingLegs: true, Chase());
        Assert.True(result.Success, result.Message);
        Assert.Single(dhan.Orders.Values, o => o.Tag.StartsWith("OIRX-"));
    }

    [Fact]
    public async Task Exit_of_a_short_buys_it_back_at_the_ask_plus_slippage()
    {
        var (service, dhan, _) = await CreateAsync();
        dhan.Positions[0]["positionType"] = "SHORT";
        dhan.Positions[0]["netQty"] = -Lot;
        var sold = TradedSuperOrder("S7", Lot, 110m);
        sold["transactionType"] = "SELL";
        foreach (var leg in sold["legDetails"]!.AsArray()) leg!["transactionType"] = "BUY";
        dhan.SuperOrders.Clear();
        dhan.SuperOrders.Add(sold);
        var result = await service.ExitTradeAsync(new[] { "S7" }, 1m, CancellationToken.None, onlyWithWorkingLegs: true, Chase());
        Assert.True(result.Success, result.Message);
        var exit = Assert.Single(dhan.Orders.Values, o => o.Tag.StartsWith("OIRX-"));
        Assert.Equal(("BUY", Lot, 121.5m), (exit.Side, exit.Quantity, exit.Price));     // ask 120.50 + 1
    }

    [Fact]
    public async Task Exit_chase_stops_once_the_exit_has_filled()
    {
        var (service, dhan, feed) = await CreateAsync();
        Assert.True((await service.ExitTradeAsync(new[] { "S1" }, 1m, CancellationToken.None, onlyWithWorkingLegs: true, Chase(intervalMs: 150))).Success);
        dhan.Fill(Assert.Single(dhan.Orders.Values, o => o.Tag.StartsWith("OIRX-")).Id);
        feed.SetLastTickForTesting(Tick(bid: 100m, ask: 100.5m, last: 100m));          // would re-price, were it still working
        await Task.Delay(600);
        Assert.DoesNotContain(dhan.Requests, r => r.StartsWith("PUT /orders/"));
    }

    [Fact]
    public async Task Exit_of_a_trade_Dhans_own_stop_loss_already_closed_sends_nothing()
    {
        var (service, dhan, _) = await CreateAsync();
        dhan.SuperOrders.Add(TradedSuperOrder("S3", Lot, 112m, stop: "TRADED", target: "CANCELLED"));
        var result = await service.ExitTradeAsync(new[] { "S3" }, 1m, CancellationToken.None, onlyWithWorkingLegs: true, Chase());
        Assert.True(result.Success, result.Message);
        Assert.Equal("stop-loss", result.ClosedBy);
        Assert.DoesNotContain(dhan.Requests, r => r.StartsWith("POST") || r.StartsWith("DELETE"));
    }

    // ---- THE ORDER GATE: exits and stop-loss moves first -----------------------------------------------------------------

    [Fact]
    public async Task Exit_goes_before_an_entry_that_was_waiting_ahead_of_it()
    {
        var (service, dhan, _) = await CreateAsync();
        var hold = new TaskCompletionSource();
        dhan.HoldPlaces = hold;
        var first = service.PlaceAsync(Buy(), CancellationToken.None);                  // in flight, holding the gate
        await dhan.PlaceArrived.Task;
        var second = service.PlaceAsync(Buy(), CancellationToken.None);                 // an entry waiting
        await Task.Delay(50);
        var exit = service.ExitTradeAsync(new[] { "S1" }, 1m, CancellationToken.None, onlyWithWorkingLegs: true);   // the exit arrives later
        await Task.Delay(50);
        dhan.HoldPlaces = null;
        hold.SetResult();
        await Task.WhenAll(first, second, exit);
        var exitCancel = dhan.Requests.IndexOf("DELETE /super/orders/S1/STOP_LOSS_LEG");
        var secondEntry = dhan.Requests.LastIndexOf("POST /super/orders");
        Assert.True(exitCancel >= 0 && exitCancel < secondEntry, "the exit went before the entry queued ahead of it");
    }

    [Fact]
    public async Task A_trailing_stop_move_waits_for_a_busy_gate_instead_of_being_skipped()
    {
        var (service, dhan, _) = await CreateAsync();
        await service.RefreshAsync(CancellationToken.None);
        service.SetTrail(new[] { "S1" }, 10m, 8m);                                       // S1 bought at 110, stop 80
        var hold = new TaskCompletionSource();
        dhan.HoldPlaces = hold;
        var entry = service.PlaceAsync(Buy(), CancellationToken.None);                  // holds the gate
        await dhan.PlaceArrived.Task;
        var t = DateTimeOffset.UtcNow;
        service.OnTick(new SpotTick(SecurityId, 110m, 0, 0, 0, 0, 0, 109.9m, 110m, 0, t));
        service.OnTick(new SpotTick(SecurityId, 125m, 0, 0, 0, 0, 0, 124.9m, 125m, 0, t));   // +15: the stop should go to 117
        await Task.Delay(150);
        Assert.DoesNotContain(dhan.SuperModifies, m => m["legName"]!.GetValue<string>() == "STOP_LOSS_LEG");   // waiting, not sent yet
        dhan.HoldPlaces = null;
        hold.SetResult();
        await entry;
        // No further tick needed: the move that waited goes out as soon as the gate is free (it used to be dropped).
        await WaitFor(() => dhan.SuperModifies.Any(m => m["legName"]!.GetValue<string>() == "STOP_LOSS_LEG"));
        Assert.Equal(117m, Assert.Single(dhan.SuperModifies, m => m["legName"]!.GetValue<string>() == "STOP_LOSS_LEG")["stopLossPrice"]!.GetValue<decimal>());
    }

    [Fact]
    public async Task A_trailing_stop_move_that_waited_is_dropped_when_the_trade_was_exited_meanwhile()
    {
        var (service, dhan, _) = await CreateAsync();
        await service.RefreshAsync(CancellationToken.None);
        service.SetTrail(new[] { "S1" }, 10m, 8m);
        var hold = new TaskCompletionSource();
        dhan.HoldPlaces = hold;
        var entry = service.PlaceAsync(Buy(), CancellationToken.None);
        await dhan.PlaceArrived.Task;
        var t = DateTimeOffset.UtcNow;
        service.OnTick(new SpotTick(SecurityId, 110m, 0, 0, 0, 0, 0, 109.9m, 110m, 0, t));
        service.OnTick(new SpotTick(SecurityId, 125m, 0, 0, 0, 0, 0, 124.9m, 125m, 0, t));
        var exit = service.ExitTradeAsync(new[] { "S1" }, 1m, CancellationToken.None, onlyWithWorkingLegs: true);   // the SL exit queues too
        await Task.Delay(50);
        dhan.HoldPlaces = null;
        hold.SetResult();
        await Task.WhenAll(entry, exit);
        await service.RefreshAsync(CancellationToken.None);
        await Task.Delay(200);
        // Whichever went first, the stop is never moved on a trade whose legs the exit cancelled.
        var cancelAt = dhan.Requests.IndexOf("DELETE /super/orders/S1/STOP_LOSS_LEG");
        var moveAt = dhan.Requests.FindIndex(r => r == "PUT /super/orders/S1");
        Assert.True(moveAt < 0 || moveAt < cancelAt, "no stop-loss move after the legs were cancelled");
    }

    // ---- DHAN'S RATE LIMITS --------------------------------------------------------------------------------------------------

    [Fact]
    public async Task After_Dhan_says_too_many_requests_orders_wait_1_second_and_nothing_else_waits_for_them()
    {
        var limiter = DhanRestRateLimiter.Standalone(Options.Create(new DhanOptions()));
        limiter.NoteRateLimited(DhanApiCategory.Order);
        var other = Stopwatch.StartNew();
        Assert.True((await limiter.AcquireAsync(DhanApiCategory.NonTrading, true, CancellationToken.None)).IsAcquired);
        Assert.True(other.Elapsed < TimeSpan.FromMilliseconds(200), "a positions / order-book read is not held by the orders' pause");
        var order = Stopwatch.StartNew();
        Assert.True((await limiter.AcquireAsync(DhanApiCategory.Order, true, CancellationToken.None)).IsAcquired);
        Assert.InRange(order.Elapsed, TimeSpan.FromMilliseconds(900), TimeSpan.FromMilliseconds(1400));   // Dhan: "retry after 1 second"
    }

    [Fact]
    public async Task A_burst_of_orders_is_spaced_to_Dhan_s_10_a_second_never_refused()
    {
        var limiter = DhanRestRateLimiter.Standalone(Options.Create(new DhanOptions()));
        var clock = Stopwatch.StartNew();
        var leases = await Task.WhenAll(Enumerable.Range(0, 27).Select(_ => limiter.AcquireAsync(DhanApiCategory.Order, true, CancellationToken.None).AsTask()));
        Assert.All(leases, l => Assert.True(l.IsAcquired));                            // none refused - no minute / hour cap any more
        Assert.InRange(clock.Elapsed, TimeSpan.FromSeconds(1.9), TimeSpan.FromSeconds(4)); // 27 at 9 a second: about 2 - 3 s
        Assert.Equal(27, limiter.Sent(DhanApiCategory.Order));
    }
}

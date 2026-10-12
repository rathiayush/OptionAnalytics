using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// LiveTradingService's live order handling, run against an in-memory fake of Dhan's REST API. A
/// partial exit is ONE priced LIMIT exit and nothing else - the super order and its legs stay as they
/// are (no extra orders); the panel flags that the legs now cover more than is held, and a later Close
/// cancels the legs before exiting the rest.
/// </summary>
public sealed class LiveTradingPartialExitTests
{
    private const uint SecurityId = 40944;
    private const int Lot = 65;

    [Fact]
    public async Task PartialExit_SendsOnlyTheExit_AndLeavesTheSuperOrderAsItIs()
    {
        var (service, dhan, _) = await CreateAsync();

        var result = await service.PartialExitAsync(SecurityId.ToString(), lots: 1, slippagePoints: 1m, CancellationToken.None);

        Assert.True(result.Success, result.Message);
        // One lot out at the bid minus the slippage - the only order placed.
        var exit = Assert.Single(dhan.Orders.Values);
        Assert.Equal(("SELL", "LIMIT", Lot, 119.00m), (exit.Side, exit.Type, exit.Quantity, exit.Price));
        Assert.StartsWith("OIRX-", exit.Tag);
        // The super order is untouched.
        Assert.DoesNotContain(dhan.Requests, r => r.StartsWith("DELETE /super/orders"));
        Assert.Contains("still cover", result.Message);

        // Once it fills, the panel shows the legs still cover the original 4 lots: one more than is held.
        dhan.Fill(exit.Id);
        await service.RefreshAsync(CancellationToken.None);
        var row = Assert.Single(service.Snapshot().Positions, p => p.IsOpen);
        Assert.Equal(("super", 150m, 80m, 3 * Lot, Lot), (row.Protection, row.TargetPrice, row.StopLossPrice, row.NetQty, row.LegExcessQty));
    }

    [Fact]
    public async Task Close_AfterAPartialExit_CancelsTheLegsFirst_AndExitsEverythingLeft()
    {
        var (service, dhan, _) = await CreateAsync();
        await service.PartialExitAsync(SecurityId.ToString(), lots: 1, slippagePoints: 1m, CancellationToken.None);
        dhan.Fill(dhan.Orders.Values.Single(o => o.Tag.StartsWith("OIRX-")).Id); // the partial exit fills: 3 lots left

        var result = await service.CloseAsync(SecurityId.ToString(), 1m, CancellationToken.None);

        Assert.True(result.Success, result.Message);
        var legsCancelled = dhan.Requests.IndexOf("DELETE /super/orders/S1/STOP_LOSS_LEG");
        Assert.True(legsCancelled >= 0 && dhan.Requests.IndexOf("DELETE /super/orders/S1/TARGET_LEG") >= 0);
        var finalExit = Assert.Single(dhan.Orders.Values, o => o.Tag.StartsWith("OIRX-") && o.Status == "PENDING");
        Assert.Equal(3 * Lot, finalExit.Quantity);
        Assert.True(legsCancelled < dhan.Requests.LastIndexOf("POST /orders"), "the legs must be cancelled before the exit goes out");
    }

    [Fact]
    public async Task ALeftoverProtectionOrder_ReachingItsTarget_BecomesALimitExit()
    {
        var (service, dhan, feed) = await CreateAsync();
        // A stop-loss an earlier version of partial exit left behind, tagged with its target (150).
        dhan.Orders["L1"] = new FakeDhan.PlainOrder
        {
            Id = "L1", Side = "SELL", Tag = "OIRP-T15000-101500-1", Segment = "NSE_FNO", Product = "INTRADAY",
            Type = "STOP_LOSS", Quantity = 3 * Lot, Price = 78m, Trigger = 80m,
        };
        await service.RefreshAsync(CancellationToken.None);

        var atTarget = Tick(bid: 150.50m, ask: 151m, last: 151m);
        feed.SetLastTickForTesting(atTarget);
        service.OnTick(atTarget);

        var order = dhan.Orders["L1"];
        for (var i = 0; i < 50 && order.Type != "LIMIT"; i++) await Task.Delay(100);
        Assert.Equal(("LIMIT", 150.50m, 3 * Lot), (order.Type, order.Price, order.Quantity));
    }

    [Fact]
    public async Task ExitingAllTheLots_IsAPlainClose()
    {
        var (service, dhan, _) = await CreateAsync();

        var result = await service.PartialExitAsync(SecurityId.ToString(), lots: 4, slippagePoints: 1m, CancellationToken.None);

        Assert.True(result.Success, result.Message);
        Assert.Contains("DELETE /super/orders/S1/STOP_LOSS_LEG", dhan.Requests);
        Assert.Equal(4 * Lot, Assert.Single(dhan.Orders.Values, o => o.Tag.StartsWith("OIRX-")).Quantity);
    }

    [Fact]
    public void ProtectionTags_CarryTheTarget()
    {
        Assert.Equal(150m, LiveTradingService.TargetFromTag("OIRP-T15000-101500-1"));
        Assert.Equal(23.45m, LiveTradingService.TargetFromTag("OIRP-T2345-101500-2"));
        Assert.Null(LiveTradingService.TargetFromTag("OIRX-20261004-1"));
        Assert.True(LiveTradingService.TargetReached(true, 150m, 150m));
        Assert.False(LiveTradingService.TargetReached(true, 150m, 149.95m));
        Assert.True(LiveTradingService.TargetReached(false, 50m, 49.5m));
    }

    [Fact]
    public async Task ATargetLegFillOnTheSocket_ClosesThePositionInMemory_WithoutAnyRestCall()
    {
        var (service, dhan, _) = await CreateAsync();
        await service.RefreshAsync(CancellationToken.None);
        var requestsBefore = dhan.Requests.Count;

        service.ApplyOrderUpdate(Update("S1", "SELL", 4 * Lot, 4 * Lot, avg: 150m, status: "TRADED", legNo: 3, super: true));

        Assert.Equal(requestsBefore, dhan.Requests.Count); // nothing read from REST
        var row = Assert.Single(service.Snapshot().Positions);
        Assert.False(row.IsOpen);
        Assert.Equal(4 * Lot * (150m - 110m), row.RealizedPnl);
        Assert.Empty(service.Snapshot().PendingOrders);
    }

    [Fact]
    public async Task ATargetLegFill_IsOneTargetHitEvent_TaggedFromItsSuperOrder()
    {
        var (service, _, _) = await CreateAsync();
        await service.RefreshAsync(CancellationToken.None);

        // The leg's own message carries no tag - it is the super order's (OIR-test-1).
        service.ApplyOrderUpdate(Update("S1", "SELL", 4 * Lot, 4 * Lot, avg: 150m, status: "TRADED", legNo: 3, super: true));
        service.ApplyOrderUpdate(Update("S1", "SELL", 4 * Lot, 4 * Lot, avg: 150m, status: "TRADED", legNo: 3, super: true));

        var e = Assert.Single(service.Snapshot().Events);
        Assert.Equal("target", e.Kind);
        Assert.Equal("Target hit", e.Title);
        Assert.Contains("@ 150", e.Text);
    }

    [Fact]
    public async Task PartialFillsOnTheSocket_MoveThePositionByExactlyEachNewFill()
    {
        var (service, dhan, _) = await CreateAsync();
        await service.RefreshAsync(CancellationToken.None);
        var requestsBefore = dhan.Requests.Count;

        // An exit order placed elsewhere: reported pending, then 1 lot at 120, then the 2nd lot at 122 (average 121).
        service.ApplyOrderUpdate(Update("X1", "SELL", 2 * Lot, 0, avg: 0, status: "PENDING", tag: "OIRX-1-1"));
        Assert.Contains(service.Snapshot().PendingOrders, o => o.OrderId == "X1" && o.Kind == "Exit");
        service.ApplyOrderUpdate(Update("X1", "SELL", 2 * Lot, Lot, avg: 120m, status: "PENDING", tag: "OIRX-1-1"));
        service.ApplyOrderUpdate(Update("X1", "SELL", 2 * Lot, 2 * Lot, avg: 121m, status: "TRADED", tag: "OIRX-1-1"));
        // A repeated message changes nothing.
        service.ApplyOrderUpdate(Update("X1", "SELL", 2 * Lot, 2 * Lot, avg: 121m, status: "TRADED", tag: "OIRX-1-1"));

        Assert.Equal(requestsBefore, dhan.Requests.Count);
        var row = Assert.Single(service.Snapshot().Positions);
        Assert.Equal(2 * Lot, row.NetQty);
        Assert.Equal(Lot * (120m - 110m) + Lot * (122m - 110m), row.RealizedPnl);
        Assert.DoesNotContain(service.Snapshot().PendingOrders, o => o.OrderId == "X1");
    }

    [Fact]
    public async Task AFillInANewContract_OpensAPositionFromTheSocketAlone()
    {
        var (service, dhan, _) = await CreateAsync();
        dhan.Positions.Clear();
        dhan.SuperOrders.Clear();
        await service.RefreshAsync(CancellationToken.None);

        service.ApplyOrderUpdate(Update("P7", "BUY", Lot, Lot, avg: 95.5m, status: "TRADED"));

        var row = Assert.Single(service.Snapshot().Positions);
        Assert.Equal((true, Lot, 95.5m, "LONG"), (row.IsOpen, row.NetQty, row.AvgPrice, row.PositionType));
        Assert.Equal("NIFTY-Test-26000-CE", row.TradingSymbol);
    }

    [Fact]
    public async Task ExitAll_CancelsEveryPendingOrder_NotOnlyThePanelsOwn()
    {
        var (service, dhan, _) = await CreateAsync();
        dhan.SuperOrders.Add(PendingSuperOrder("S2", "STRAT-7"));
        await service.RefreshAsync(CancellationToken.None);
        var resting = await PlacePlainAsync(dhan, "MANUAL-1");

        var result = await service.ExitAllAsync(1m, CancellationToken.None);

        Assert.True(result.Success, result.Message);
        Assert.Contains("DELETE /super/orders/S2/ENTRY_LEG", dhan.Requests);
        Assert.Equal("CANCELLED", dhan.Orders[resting].Status);
        Assert.Equal(4 * Lot, Assert.Single(dhan.Orders.Values, o => o.Tag.StartsWith("OIRX-")).Quantity);
    }

    [Fact]
    public async Task ClosingAPosition_CancelsItsPendingSuperOrders()
    {
        var (service, dhan, _) = await CreateAsync();
        dhan.SuperOrders.Add(PendingSuperOrder("S2", "OIR-test-2"));

        var result = await service.CloseAsync(SecurityId.ToString(), 1m, CancellationToken.None);

        Assert.True(result.Success, result.Message);
        var cancelAt = dhan.Requests.IndexOf("DELETE /super/orders/S2/ENTRY_LEG");
        Assert.True(cancelAt >= 0 && cancelAt < dhan.Requests.LastIndexOf("POST /orders"), "the pending super order goes before the exit");
        Assert.Contains("DELETE /super/orders/S1/TARGET_LEG", dhan.Requests);
        Assert.Contains("DELETE /super/orders/S1/STOP_LOSS_LEG", dhan.Requests);
    }

    [Theory]
    [InlineData("TRIGGERED")]
    [InlineData("TRANSIT")]
    [InlineData("PART_TRADED")]
    public async Task ClosingAPosition_CancelsAWorkingLegThatIsNotPlainPending(string legStatus)
    {
        // A stop-loss leg already triggered (or in transit / part-filled) is still working: left alone, it
        // would fire after the exit and reverse the position - Close cancels it BEFORE exiting.
        var (service, dhan, _) = await CreateAsync();
        var s1 = dhan.SuperOrders.Single(o => o["orderId"]!.GetValue<string>() == "S1");
        s1["legDetails"]![1]!["orderStatus"] = legStatus;

        var result = await service.CloseAsync(SecurityId.ToString(), 1m, CancellationToken.None);

        Assert.True(result.Success, result.Message);
        var cancelAt = dhan.Requests.IndexOf("DELETE /super/orders/S1/STOP_LOSS_LEG");
        Assert.True(cancelAt >= 0 && cancelAt < dhan.Requests.LastIndexOf("POST /orders"), $"the {legStatus} stop-loss leg is cancelled before the exit");
    }

    [Fact]
    public async Task CancellingAPartFilledEntry_SaysTheFilledPartIsLeftUnprotected()
    {
        var (service, dhan, _) = await CreateAsync();
        var partial = PendingSuperOrder("S9", "OIR-test-9");
        partial["orderStatus"] = "PART_TRADED";
        partial["filledQty"] = Lot;
        dhan.SuperOrders.Add(partial);
        await service.RefreshAsync(CancellationToken.None);

        var result = await service.CancelAsync("S9", false, CancellationToken.None);

        Assert.True(result.Success, result.Message);
        Assert.Contains("DELETE /super/orders/S9/ENTRY_LEG", dhan.Requests);
        Assert.Contains($"{Lot} qty of it had already filled and stays OPEN without a stop-loss or target", result.Message);
    }

    [Fact]
    public async Task ExitingATradeWhoseEntryIsStillFilling_ExitsWhatItFilledUntilTheCancelLanded()
    {
        var (service, dhan, _) = await CreateAsync();
        var partial = PendingSuperOrder("S9", "OIR-test-9");
        partial["orderStatus"] = "PART_TRADED";
        partial["filledQty"] = Lot;
        dhan.SuperOrders.Add(partial);
        dhan.FillsBeforeCancel["S9"] = Lot; // one more lot fills while the cancel is on its way

        var result = await service.ExitTradeAsync(new[] { "S9" }, 1m, CancellationToken.None);

        Assert.True(result.Success, result.Message);
        Assert.Contains("DELETE /super/orders/S9/ENTRY_LEG", dhan.Requests);
        Assert.Contains($"x{2 * Lot} at LIMIT", result.Message);
    }

    [Theory]
    // BUY at 110: 10 pts in profit at 125 -> stop 8 behind the best = 117.
    [InlineData(false, 110, 125, 10, 8, 117.0)]
    // Not 10 in profit yet: no trailing.
    [InlineData(false, 110, 118, 10, 8, null)]
    // SELL at 110: best 95 -> stop 103.
    [InlineData(true, 110, 95, 10, 8, 103.0)]
    // Gap 0 = off.
    [InlineData(false, 110, 140, 10, 0, null)]
    public void TrailStop_FollowsTheBestPremiumOnceInProfit(bool sell, double entry, double best, double start, double gap, double? expected)
    {
        var stop = LiveTradingService.TrailStop(sell, (decimal)entry, (decimal)best, (decimal)start, (decimal)gap, 0.05m);
        Assert.Equal(expected is null ? null : (decimal?)expected, stop);
    }

    [Fact]
    public async Task ATrailedTrade_MovesItsStopLossLegUpWithThePremium_NeverDown()
    {
        var (service, dhan, _) = await CreateAsync();
        await service.RefreshAsync(CancellationToken.None);
        // S1: BUY filled at 110, stop-loss leg at 80. Trail: after +10, 8 behind the best.
        service.SetTrail(new[] { "S1" }, 10m, 8m);
        var t = DateTimeOffset.UtcNow;
        service.OnTick(new SpotTick(SecurityId, 110m, 0, 0, 0, 0, 0, 109.9m, 110m, 0, t));
        service.OnTick(new SpotTick(SecurityId, 118m, 0, 0, 0, 0, 0, 117.9m, 118m, 0, t)); // +8: not yet
        Assert.DoesNotContain(dhan.SuperModifies, m => m["legName"]!.GetValue<string>() == "STOP_LOSS_LEG");
        service.OnTick(new SpotTick(SecurityId, 125m, 0, 0, 0, 0, 0, 124.9m, 125m, 0, t)); // +15: trail to 117
        await WaitFor(() => dhan.SuperModifies.Any(m => m["legName"]!.GetValue<string>() == "STOP_LOSS_LEG"));
        var moved = Assert.Single(dhan.SuperModifies, m => m["legName"]!.GetValue<string>() == "STOP_LOSS_LEG");
        Assert.Equal(117m, moved["stopLossPrice"]!.GetValue<decimal>());

        // The premium falls back: the stop never moves down.
        await Task.Delay(50);
        service.OnTick(new SpotTick(SecurityId, 119m, 0, 0, 0, 0, 0, 118.9m, 119m, 0, t));
        Assert.Single(dhan.SuperModifies, m => m["legName"]!.GetValue<string>() == "STOP_LOSS_LEG");

        // A new (wider) Max SL does not loosen the trailed stop either.
        await service.UpdateTradeLevelsAsync(new[] { "S1" }, stopLossPoints: 25m, targetPoints: 0m, CancellationToken.None);
        Assert.Single(dhan.SuperModifies, m => m["legName"]!.GetValue<string>() == "STOP_LOSS_LEG");
    }

    private static async Task WaitFor(Func<bool> condition)
    {
        for (var i = 0; i < 100 && !condition(); i++) await Task.Delay(20);
    }

    [Fact]
    public async Task EveryOpenOrderIsListed_AndOneLegCanBeCancelled()
    {
        var (service, dhan, _) = await CreateAsync();
        var manual = await PlacePlainAsync(dhan, "MANUAL-1");
        await service.PartialExitAsync(SecurityId.ToString(), lots: 1, slippagePoints: 1m, CancellationToken.None);
        await service.RefreshAsync(CancellationToken.None);

        var pending = service.Snapshot().PendingOrders;
        Assert.Contains(pending, o => o.OrderId == "S1" && o.Kind == "Target leg" && o.Leg == "TARGET_LEG" && o.TargetPrice == 150m && o.Quantity == 4 * Lot);
        Assert.Contains(pending, o => o.OrderId == "S1" && o.Kind == "Stop-loss leg" && o.Leg == "STOP_LOSS_LEG" && o.StopLossPrice == 80m);
        Assert.Contains(pending, o => o.OrderId == manual && o.Kind == "Order" && o.Leg == null);
        Assert.Contains(pending, o => o.Kind == "Exit"); // the partial exit itself

        var result = await service.CancelAsync("S1", false, CancellationToken.None, "TARGET_LEG");

        Assert.True(result.Success, result.Message);
        Assert.Contains("DELETE /super/orders/S1/TARGET_LEG", dhan.Requests);
        Assert.DoesNotContain("DELETE /super/orders/S1/STOP_LOSS_LEG", dhan.Requests);
        await service.RefreshAsync(CancellationToken.None);
        Assert.DoesNotContain(service.Snapshot().PendingOrders, o => o.Leg == "TARGET_LEG");
        Assert.Contains(service.Snapshot().PendingOrders, o => o.Leg == "STOP_LOSS_LEG");
    }

    [Fact]
    public async Task CancelAll_CancelsEveryOrderAndLeg_ButClosesNothing()
    {
        var (service, dhan, _) = await CreateAsync();
        dhan.SuperOrders.Add(PendingSuperOrder("S2", "STRAT-7"));
        var manual = await PlacePlainAsync(dhan, "MANUAL-1");

        var result = await service.CancelAllOrdersAsync(CancellationToken.None);

        Assert.True(result.Success, result.Message);
        Assert.Contains("DELETE /super/orders/S2/ENTRY_LEG", dhan.Requests);
        Assert.Contains("DELETE /super/orders/S1/TARGET_LEG", dhan.Requests);
        Assert.Contains("DELETE /super/orders/S1/STOP_LOSS_LEG", dhan.Requests);
        Assert.Equal("CANCELLED", dhan.Orders[manual].Status);
        Assert.DoesNotContain(dhan.Orders.Values, o => o.Tag.StartsWith("OIRX-")); // no exit placed
    }

    // ---- one strategy trade (its super orders), not the whole position ------------------------------

    private static JsonObject TradedSuperOrder(string id, int quantity, decimal price, string target = "PENDING", string stop = "PENDING") => new()
    {
        ["orderId"] = id, ["orderStatus"] = "TRADED", ["transactionType"] = "BUY", ["exchangeSegment"] = "NSE_FNO",
        ["securityId"] = SecurityId.ToString(), ["quantity"] = quantity, ["filledQty"] = quantity, ["price"] = price,
        ["targetPrice"] = price + 30, ["stopLossPrice"] = price - 20, ["correlationId"] = $"OIR-{id}",
        ["legDetails"] = new JsonArray(
            new JsonObject { ["legName"] = "TARGET_LEG", ["orderStatus"] = target, ["transactionType"] = "SELL", ["price"] = price + 30 },
            new JsonObject { ["legName"] = "STOP_LOSS_LEG", ["orderStatus"] = stop, ["transactionType"] = "SELL", ["price"] = price - 20 }),
    };

    [Fact]
    public async Task ExitTrade_CancelsThatTradesLegs_AndExitsOnlyItsQuantity()
    {
        var (service, dhan, _) = await CreateAsync();
        // A second trade in the same contract: 1 lot (S3) on top of S1's 4 - Dhan nets them to 5.
        dhan.SuperOrders.Add(TradedSuperOrder("S3", Lot, 112m));
        dhan.Positions[0]["netQty"] = 5 * Lot;

        var result = await service.ExitTradeAsync(new[] { "S3" }, 1m, CancellationToken.None);

        Assert.True(result.Success, result.Message);
        Assert.Contains("DELETE /super/orders/S3/TARGET_LEG", dhan.Requests);
        Assert.Contains("DELETE /super/orders/S3/STOP_LOSS_LEG", dhan.Requests);
        Assert.DoesNotContain(dhan.Requests, r => r.StartsWith("DELETE /super/orders/S1"));
        var exit = Assert.Single(dhan.Orders.Values);
        Assert.Equal(("SELL", Lot), (exit.Side, exit.Quantity));
        Assert.True(dhan.Requests.IndexOf("DELETE /super/orders/S3/STOP_LOSS_LEG") < dhan.Requests.LastIndexOf("POST /orders"), "legs go before the exit");
    }

    [Fact]
    public async Task ExitTrade_ForAnUnfilledEntry_CancelsTheSuperOrder_AndPlacesNothing()
    {
        var (service, dhan, _) = await CreateAsync();
        dhan.SuperOrders.Add(PendingSuperOrder("S2", "OIR-S2"));

        var result = await service.ExitTradeAsync(new[] { "S2" }, 1m, CancellationToken.None);

        Assert.True(result.Success, result.Message);
        Assert.Contains("DELETE /super/orders/S2/ENTRY_LEG", dhan.Requests);
        Assert.Empty(dhan.Orders);
    }

    // ---- the server's own time exit (the scanner's time stop / 15:10) ---------------------------------

    private static readonly DateTimeOffset Ist1030 = IstClock.AtIstTime(IstClock.Today(), 10 * 60 + 30);

    [Fact]
    public async Task ATimeExit_IsCappedAt1510Ist_AndNotSetForAPastTimeOrNoOrders()
    {
        var (service, _, _) = await CreateAsync();
        service.UtcNow = () => Ist1030;

        Assert.Equal(IstClock.AtIstTime(IstClock.Today(), 15 * 60 + 10), service.SetTimeExit(new[] { "S1" }, IstClock.AtIstTime(IstClock.Today(), 15 * 60 + 25), 1m, "time stop"));
        Assert.Equal(Ist1030.AddMinutes(45), service.SetTimeExit(new[] { "S1" }, Ist1030.AddMinutes(45), 1m, "time stop"));
        Assert.Single(service.TimeExits()); // replaced, not added
        Assert.Null(service.SetTimeExit(new[] { "S2" }, Ist1030.AddMinutes(-1), 1m, "time stop"));
        Assert.Null(service.SetTimeExit(Array.Empty<string>(), Ist1030.AddMinutes(5), 1m, "time stop"));
    }

    [Fact]
    public async Task ADueTimeExit_CancelsThatTradesLegs_AndExitsOnlyItsQuantity_WithNoBrowser()
    {
        var (service, dhan, _) = await CreateAsync();
        service.UtcNow = () => Ist1030;
        dhan.SuperOrders.Add(TradedSuperOrder("S3", Lot, 112m));
        dhan.Positions[0]["netQty"] = 5 * Lot;
        var exitAt = service.SetTimeExit(new[] { "S3" }, Ist1030.AddMinutes(30), 1m, "time stop")!.Value;

        await service.RunDueTimeExitsAsync(exitAt.AddSeconds(-1), CancellationToken.None);
        Assert.DoesNotContain(dhan.Requests, r => r.StartsWith("DELETE /super/orders/S3"));

        await service.RunDueTimeExitsAsync(exitAt.AddSeconds(1), CancellationToken.None);
        Assert.Contains("DELETE /super/orders/S3/TARGET_LEG", dhan.Requests);
        Assert.Contains("DELETE /super/orders/S3/STOP_LOSS_LEG", dhan.Requests);
        Assert.DoesNotContain(dhan.Requests, r => r.StartsWith("DELETE /super/orders/S1"));
        var exit = Assert.Single(dhan.Orders.Values);
        Assert.Equal(("SELL", Lot), (exit.Side, exit.Quantity));
        Assert.Empty(service.TimeExits());
    }

    [Fact]
    public async Task ATimeExit_ForATradeAlreadyClosedByHand_PlacesNothing_EvenWithANewerPositionOpen()
    {
        var (service, dhan, _) = await CreateAsync();
        service.UtcNow = () => Ist1030;
        // S3's legs were cancelled when it was closed by hand; the contract's position (S1, 4 lots) is someone else's.
        dhan.SuperOrders.Add(TradedSuperOrder("S3", Lot, 112m, target: "CANCELLED", stop: "CANCELLED"));
        var exitAt = service.SetTimeExit(new[] { "S3" }, Ist1030.AddMinutes(30), 1m, "time stop")!.Value;

        await service.RunDueTimeExitsAsync(exitAt.AddSeconds(1), CancellationToken.None);

        Assert.Empty(dhan.Orders);
        Assert.Empty(service.TimeExits());
    }

    [Fact]
    public async Task AFailedTimeExit_IsRetried_NotSoonerThanTheRetryInterval()
    {
        var (service, dhan, _) = await CreateAsync();
        service.UtcNow = () => Ist1030;
        dhan.SuperOrders.Add(TradedSuperOrder("S3", Lot, 112m));
        dhan.Positions[0]["netQty"] = 5 * Lot;
        dhan.RefuseCancel.Add("S3/TARGET_LEG");
        var exitAt = service.SetTimeExit(new[] { "S3" }, Ist1030.AddMinutes(30), 1m, "time stop")!.Value;

        await service.RunDueTimeExitsAsync(exitAt.AddSeconds(1), CancellationToken.None);
        var pending = Assert.Single(service.TimeExits());
        Assert.Equal(1, pending.Attempts);
        var tries = dhan.Requests.Count(r => r == "DELETE /super/orders/S3/TARGET_LEG");

        await service.RunDueTimeExitsAsync(exitAt.AddSeconds(5), CancellationToken.None);
        Assert.Equal(tries, dhan.Requests.Count(r => r == "DELETE /super/orders/S3/TARGET_LEG")); // too soon

        dhan.RefuseCancel.Clear();
        await service.RunDueTimeExitsAsync(exitAt.AddSeconds(1) + LiveTradingService.TimeExitRetryInterval, CancellationToken.None);
        Assert.Empty(service.TimeExits());
        Assert.Contains("DELETE /super/orders/S3/TARGET_LEG", dhan.Requests);
    }

    [Fact]
    public async Task TimeExits_SurviveARestart()
    {
        var dir = Path.Combine(Path.GetTempPath(), "oa-time-exits-" + Guid.NewGuid().ToString("n"));
        try
        {
            LiveTimeExitStore Store() => new(new TimeExitHost { ContentRootPath = dir },
                new Microsoft.Extensions.Configuration.ConfigurationBuilder().Build(), NullLogger<LiveTimeExitStore>.Instance);
            var (first, _, _) = await CreateAsync(Store());
            first.UtcNow = () => Ist1030;
            var exitAt = first.SetTimeExit(new[] { "S3" }, Ist1030.AddMinutes(30), 1.5m, "time stop");

            var (second, _, _) = await CreateAsync(Store());

            var loaded = Assert.Single(second.TimeExits());
            Assert.Equal(new[] { "S3" }, loaded.OrderIds);
            Assert.Equal((exitAt, 1.5m), ((DateTimeOffset?)loaded.ExitAt, loaded.SlippagePoints));
        }
        finally
        {
            try { Directory.Delete(dir, recursive: true); } catch { /* best effort */ }
        }
    }

    [Fact]
    public void ThePagesOrderJson_CarriesTheExitTime()
    {
        const string body = "{\"underlying\":\"NIFTY\",\"expiry\":\"2026-10-06\",\"strike\":22650,\"side\":\"PE\",\"direction\":\"SELL\",\"lots\":1,"
            + "\"slippagePoints\":2,\"stopLossPoints\":20,\"targetPoints\":30,\"trailStartPoints\":0,\"trailGapPoints\":0,\"exitAtMs\":1791180000000,\"exitReason\":\"time stop of #15 IB breakout\"}";
        var request = System.Text.Json.JsonSerializer.Deserialize<ManualOrderRequest>(body, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web))!;
        Assert.Equal((1791180000000L, "time stop of #15 IB breakout"), (request.ExitAtMs, request.ExitReason));
    }

    private sealed class TimeExitHost : Microsoft.Extensions.Hosting.IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "Tests";
        public string ContentRootPath { get; set; } = "";
        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } = null!;
    }

    [Fact]
    public async Task ExitTrade_AlreadyClosedByItsTarget_DoesNothing()
    {
        var (service, dhan, _) = await CreateAsync();
        dhan.SuperOrders.Add(TradedSuperOrder("S3", Lot, 112m, target: "TRADED", stop: "CANCELLED"));

        var result = await service.ExitTradeAsync(new[] { "S3" }, 1m, CancellationToken.None);

        Assert.True(result.Success, result.Message);
        Assert.Contains("already closed on Dhan by its target", result.Message);
        Assert.DoesNotContain(dhan.Requests, r => r.StartsWith("DELETE"));
        Assert.Empty(dhan.Orders);
    }

    [Fact]
    public async Task TradeLevels_MoveTheLegsFromTheEntryPrice()
    {
        var (service, dhan, _) = await CreateAsync();

        var result = await service.UpdateTradeLevelsAsync(new[] { "S1" }, stopLossPoints: 25m, targetPoints: 35m, CancellationToken.None);

        Assert.True(result.Success, result.Message);
        // S1 bought at 110: target 145, stop-loss 85.
        Assert.Contains(dhan.SuperModifies, m => m["legName"]!.GetValue<string>() == "TARGET_LEG" && m["targetPrice"]!.GetValue<decimal>() == 145m);
        Assert.Contains(dhan.SuperModifies, m => m["legName"]!.GetValue<string>() == "STOP_LOSS_LEG" && m["stopLossPrice"]!.GetValue<decimal>() == 85m);
    }

    [Theory]
    [InlineData("PENDING", true)]
    [InlineData("TRIGGERED", true)]   // a status Dhan may add later still counts as open
    [InlineData("part_traded", true)]
    [InlineData("TRADED", false)]
    [InlineData("CANCELLED", false)]
    [InlineData("REJECTED", false)]
    [InlineData("", false)]
    public void OpenStatus(string status, bool open) => Assert.Equal(open, LiveTradingService.IsOpenStatus(status));

    [Fact]
    public void FillPrice_IsTheNewPartOfTheAverage()
    {
        Assert.Equal(122m, LiveTradingService.FillPrice(65, 120m, Update("X", "SELL", 130, 130, avg: 121m, status: "TRADED")));
        Assert.Equal(121m, LiveTradingService.FillPrice(0, null, Update("X", "SELL", 130, 130, avg: 121m, status: "TRADED")));
        Assert.Null(LiveTradingService.FillPrice(130, 121m, Update("X", "SELL", 130, 130, avg: 121m, status: "TRADED")));
    }

    // ---- fixture ---------------------------------------------------------------------------------

    private static DhanOrderUpdate Update(string orderNo, string side, int quantity, int traded, decimal avg, string status,
        int legNo = 1, bool super = false, string? tag = null) =>
        new(orderNo, SecurityId.ToString(), "NSE_FNO", "INTRADAY", side, "LIMIT", quantity, traded, quantity - traded,
            avg, 0, avg, avg, status, tag, legNo, super, null, null);

    private static JsonObject PendingSuperOrder(string id, string tag) => new()
    {
        ["orderId"] = id, ["orderStatus"] = "PENDING", ["transactionType"] = "BUY", ["exchangeSegment"] = "NSE_FNO",
        ["securityId"] = SecurityId.ToString(), ["quantity"] = Lot, ["price"] = 100m, ["targetPrice"] = 130m, ["stopLossPrice"] = 90m,
        ["correlationId"] = tag, ["legDetails"] = new JsonArray(),
    };

    private static async Task<string> PlacePlainAsync(FakeDhan dhan, string tag)
    {
        using var http = new HttpClient(dhan);
        var body = new JsonObject
        {
            ["transactionType"] = "BUY", ["correlationId"] = tag, ["exchangeSegment"] = "NSE_FNO", ["productType"] = "INTRADAY",
            ["orderType"] = "LIMIT", ["quantity"] = Lot, ["price"] = 90m,
        };
        var response = await http.PostAsync("https://dhan.test/orders", new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"));
        return JsonNode.Parse(await response.Content.ReadAsStringAsync())!["orderId"]!.GetValue<string>();
    }

    private static async Task WaitFor(Func<bool> done, int ms = 5000)
    {
        for (var waited = 0; waited < ms && !done(); waited += 20) await Task.Delay(20);
        Assert.True(done(), "timed out");
    }

    private static DateOnly Expiry => DateOnly.FromDateTime(DateTime.Today.AddDays(20));

    private static JsonObject EntryMove(FakeDhan dhan, int i) { lock (dhan.SuperModifies) return dhan.SuperModifies[i]; }

    [Fact]
    public async Task AServerScannerEntry_TheMarketRanAwayFrom_IsRePricedToTheLatestAsk_WithItsLegs_UntilItFills()
    {
        var (service, dhan, feed) = await CreateAsync();
        service.EntryChaseInterval = TimeSpan.FromMilliseconds(30);
        service.EntryChaseFor = TimeSpan.FromSeconds(3); // not left polling after the test
        var r = await service.PlaceAsync(new ManualOrderRequest("NIFTY", Expiry, 26000, "CE", "BUY", 1, 1m, 20m, 40m, ChaseEntry: true), CancellationToken.None);
        Assert.True(r.Success, r.Message);
        var id = Assert.Single(r.OrderIds);
        var order = dhan.SuperOrders.Single(o => o["orderId"]!.GetValue<string>() == id);
        // At the ask 120.50 + 1: limit 121.50, target 160.50, SL 100.50.
        Assert.Equal((121.50m, 160.50m, 100.50m), (order["price"]!.GetValue<decimal>(), order["targetPrice"]!.GetValue<decimal>(), order["stopLossPrice"]!.GetValue<decimal>()));
        // Still at the market: nothing moves.
        await Task.Delay(200);
        Assert.Empty(dhan.SuperModifies);

        // A sudden move: the ask jumps to 125 - re-priced to the latest ask + the slippage, its legs moved along (+4.50).
        feed.SetLastTickForTesting(Tick(bid: 124.50m, ask: 125m, last: 125m));
        await WaitFor(() => dhan.SuperModifies.Count >= 1);
        var first = EntryMove(dhan, 0);
        Assert.Equal(("ENTRY_LEG", "LIMIT", 126m, 165m, 105m), (first["legName"]!.GetValue<string>(), first["orderType"]!.GetValue<string>(),
            first["price"]!.GetValue<decimal>(), first["targetPrice"]!.GetValue<decimal>(), first["stopLossPrice"]!.GetValue<decimal>()));
        // Again, faster than the order: the slippage widens (2x) - 128 + 2 = 130, legs +4.
        feed.SetLastTickForTesting(Tick(bid: 127.50m, ask: 128m, last: 128m));
        await WaitFor(() => dhan.SuperModifies.Count >= 2);
        var second = EntryMove(dhan, 1);
        Assert.Equal((130m, 169m, 109m), (second["price"]!.GetValue<decimal>(), second["targetPrice"]!.GetValue<decimal>(), second["stopLossPrice"]!.GetValue<decimal>()));

        // Filled: never moved again.
        order["orderStatus"] = "TRADED";
        feed.SetLastTickForTesting(Tick(bid: 131.50m, ask: 132m, last: 132m));
        await Task.Delay(300);
        Assert.Equal(2, dhan.SuperModifies.Count);
    }

    [Fact]
    public async Task AnEntry_IsNeverChasedPastItsSlDistance_AndOnlyWhenAskedTo()
    {
        var (service, dhan, feed) = await CreateAsync();
        service.EntryChaseInterval = TimeSpan.FromMilliseconds(30);
        service.EntryChaseFor = TimeSpan.FromSeconds(3); // not left polling after the test
        // A manual order (no ChaseEntry): it rests at its price whatever the market does.
        await service.PlaceAsync(new ManualOrderRequest("NIFTY", Expiry, 26000, "CE", "BUY", 1, 1m, 20m, 40m), CancellationToken.None);
        feed.SetLastTickForTesting(Tick(bid: 124.50m, ask: 125m, last: 125m));
        await Task.Delay(200);
        Assert.Empty(dhan.SuperModifies);

        // A chased one at 126 (ask 125 + 1), SL 20: the option runs to 150 - 25 pts, past its SL distance: not chased.
        var r = await service.PlaceAsync(new ManualOrderRequest("NIFTY", Expiry, 26000, "CE", "BUY", 1, 1m, 20m, 40m, ChaseEntry: true), CancellationToken.None);
        Assert.True(r.Success, r.Message);
        feed.SetLastTickForTesting(Tick(bid: 149.50m, ask: 150m, last: 150m));
        await Task.Delay(300);
        Assert.Empty(dhan.SuperModifies);
        // Back within it (140 + 1 = 15 pts from 126): chased.
        feed.SetLastTickForTesting(Tick(bid: 139.50m, ask: 140m, last: 140m));
        await WaitFor(() => dhan.SuperModifies.Count >= 1);
        Assert.Equal((r.OrderIds.Single(), 141m), (EntryMove(dhan, 0)["orderId"]!.GetValue<string>(), EntryMove(dhan, 0)["price"]!.GetValue<decimal>()));
    }

    [Fact]
    public async Task AnExit_KeepsFollowingTheLatestBid_PastItsFirstTries_UntilItFills()
    {
        var (service, dhan, feed) = await CreateAsync();
        service.ExitCheckInterval = TimeSpan.FromMilliseconds(20);
        await service.PartialExitAsync(SecurityId.ToString(), lots: 1, slippagePoints: 1m, CancellationToken.None);
        var exit = dhan.Orders.Values.Single(o => o.Tag.StartsWith("OIRX-"));
        Assert.Equal(119m, exit.Price); // bid 120 - 1
        // Unfilled: re-priced each try, the slippage widened up to 6x - 120 - 6 = 114.
        await WaitFor(() => exit.Price == 114m);
        // Well past the first six tries, a sudden fall: still followed, to the latest bid.
        await Task.Delay(400);
        feed.SetLastTickForTesting(Tick(bid: 100m, ask: 100.50m, last: 100.25m));
        await WaitFor(() => exit.Price == 94m);
        // Filled: left alone (a try already under way when it filled is let finish first).
        dhan.Fill(exit.Id);
        await Task.Delay(100);
        int Puts() { lock (dhan.Requests) return dhan.Requests.Count(x => x == $"PUT /orders/{exit.Id}"); }
        var puts = Puts();
        feed.SetLastTickForTesting(Tick(bid: 90m, ask: 90.50m, last: 90.25m));
        await Task.Delay(200);
        Assert.Equal(puts, Puts());
    }

    [Fact]
    public async Task ARejectedExit_IsPlacedAgainAtTheLatestPrice_ForWhatIsStillOpen_AFewTimes()
    {
        var (service, dhan, feed) = await CreateAsync();
        service.ExitCheckInterval = TimeSpan.FromMilliseconds(20);
        await service.PartialExitAsync(SecurityId.ToString(), lots: 1, slippagePoints: 1m, CancellationToken.None);
        var first = dhan.Orders.Values.Single(o => o.Tag.StartsWith("OIRX-"));
        feed.SetLastTickForTesting(Tick(bid: 110m, ask: 110.50m, last: 110.25m));
        first.Status = "REJECTED";
        // Placed again: the same lot, at the latest bid - 1 (then chased like the first).
        await WaitFor(() => dhan.Orders.Values.Any(o => o.Tag.StartsWith("OIRX-R1-")));
        var again = dhan.Orders.Values.Single(o => o.Tag.StartsWith("OIRX-R1-"));
        Assert.Equal(("SELL", Lot, 109m), (again.Side, again.Quantity, again.PlacedPrice));
        // Rejected every time: placed again up to three times, then left to the trader (never endlessly).
        again.Status = "REJECTED";
        await WaitFor(() => dhan.Orders.Values.Any(o => o.Tag.StartsWith("OIRX-R2-")));
        dhan.Orders.Values.Single(o => o.Tag.StartsWith("OIRX-R2-")).Status = "REJECTED";
        await WaitFor(() => dhan.Orders.Values.Any(o => o.Tag.StartsWith("OIRX-R3-")));
        dhan.Orders.Values.Single(o => o.Tag.StartsWith("OIRX-R3-")).Status = "REJECTED";
        await Task.Delay(300);
        Assert.Equal(4, dhan.Orders.Count);
    }

    private static SpotTick Tick(decimal bid, decimal ask, decimal last) =>
        new(SecurityId, last, 0, 0, 0, 0, 1000, bid, ask, 0, DateTimeOffset.UtcNow);

    private static async Task<(LiveTradingService Service, FakeDhan Dhan, DhanMarketFeedClient Feed)> CreateAsync(LiveTimeExitStore? timeExitStore = null)
    {
        var expiry = DateTime.Today.AddDays(20).ToString("yyyy-MM-dd");
        var scrip = "SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_EXPIRY_CODE,SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_STRIKE_PRICE,SEM_OPTION_TYPE,SEM_TICK_SIZE,SEM_EXPIRY_FLAG,SEM_EXCH_INSTRUMENT_TYPE,SEM_SERIES,SM_SYMBOL_NAME\n" +
                    $"NSE,D,{SecurityId},OPTIDX,0,NIFTY-Test-26000-CE,{Lot}.0,NIFTY 26000 CALL,{expiry} 14:30:00,26000.00000,CE,5.0000,W,OP,,\n";
        var dhan = new FakeDhan(scrip);
        dhan.Positions.Add(new JsonObject
        {
            ["securityId"] = SecurityId.ToString(), ["tradingSymbol"] = "NIFTY-Test-26000-CE", ["exchangeSegment"] = "NSE_FNO",
            ["productType"] = "INTRADAY", ["positionType"] = "LONG", ["netQty"] = 4 * Lot, ["buyAvg"] = 110m, ["buyQty"] = 4 * Lot,
        });
        dhan.SuperOrders.Add(new JsonObject
        {
            ["orderId"] = "S1", ["orderStatus"] = "TRADED", ["transactionType"] = "BUY", ["exchangeSegment"] = "NSE_FNO",
            ["securityId"] = SecurityId.ToString(), ["quantity"] = 4 * Lot, ["price"] = 110m, ["targetPrice"] = 150m, ["stopLossPrice"] = 80m,
            ["correlationId"] = "OIR-test-1",
            ["legDetails"] = new JsonArray(
                new JsonObject { ["legName"] = "TARGET_LEG", ["orderStatus"] = "PENDING", ["transactionType"] = "SELL", ["price"] = 150m },
                new JsonObject { ["legName"] = "STOP_LOSS_LEG", ["orderStatus"] = "PENDING", ["transactionType"] = "SELL", ["price"] = 80m }),
        });

        var options = Options.Create(new DhanOptions { RestBaseUrl = "https://dhan.test", ScripMasterUrl = "https://dhan.test/scrip.csv", AccessToken = "t", ClientId = "c" });
        var session = new DhanSession(options);
        var http = new HttpClient(dhan);
        var api = new DhanApiClient(http, options, session, NullLogger<DhanApiClient>.Instance);
        var chain = new DhanOptionChainMaster(http, options, NullLogger<DhanOptionChainMaster>.Instance);
        await chain.EnsureLoadedAsync(CancellationToken.None);
        var feed = new DhanMarketFeedClient(options, session, NullLogger<DhanMarketFeedClient>.Instance);
        feed.SetLastTickForTesting(Tick(bid: 120m, ask: 120.50m, last: 120.25m));
        var service = new LiveTradingService(
            new DhanPositionsClient(api, NullLogger<DhanPositionsClient>.Instance),
            new DhanSuperOrderClient(api, NullLogger<DhanSuperOrderClient>.Instance),
            new DhanOrderClient(api, NullLogger<DhanOrderClient>.Instance),
            chain, feed, session, new DhanOrderUpdateFeed(options, session, NullLogger<DhanOrderUpdateFeed>.Instance),
            new LiveBroadcastBatcher(null, NullLogger<LiveBroadcastBatcher>.Instance), NullLogger<LiveTradingService>.Instance, timeExitStore: timeExitStore);
        return (service, dhan, feed);
    }

    /// <summary>Just enough of Dhan's REST API: positions, super orders (with leg cancel) and plain
    /// orders (place, modify, cancel), in memory. Requests are recorded as "METHOD /path".</summary>
    private sealed class FakeDhan(string scripMaster) : HttpMessageHandler
    {
        public List<JsonObject> Positions { get; } = new();
        public List<JsonObject> SuperOrders { get; } = new();
        public Dictionary<string, int> FillsBeforeCancel { get; } = new();
        public List<JsonObject> SuperModifies { get; } = new();
        public ConcurrentDictionary<string, PlainOrder> Orders { get; } = new();
        public List<string> Requests { get; } = new();
        /// <summary>Super order leg cancels Dhan refuses ("S3/TARGET_LEG").</summary>
        public HashSet<string> RefuseCancel { get; } = new();
        private int _next;

        public sealed class PlainOrder
        {
            public required string Id, Side, Tag, Segment, Product;
            public string Type = "LIMIT", Status = "PENDING";
            public int Quantity, Filled;
            public decimal Price;
            /// <summary>The price it was placed at (Price moves as it is chased).</summary>
            public decimal PlacedPrice;
            public decimal? Trigger;
        }

        /// <summary>A plain order fills completely and the position shrinks by it.</summary>
        public void Fill(string orderId)
        {
            var order = Orders[orderId];
            order.Status = "TRADED";
            order.Filled = order.Quantity;
            var position = Positions.Single();
            var net = position["netQty"]!.GetValue<int>();
            position["netQty"] = order.Side == "SELL" ? net - order.Quantity : net + order.Quantity;
        }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            lock (Requests) Requests.Add($"{request.Method} {path}");
            var body = request.Content is null ? null : JsonNode.Parse(await request.Content.ReadAsStringAsync(cancellationToken))?.AsObject();

            if (path == "/scrip.csv") return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(scripMaster) };
            if (request.Method == HttpMethod.Get && path == "/positions") return Json(new JsonArray(Positions.Select(p => (JsonNode)p.DeepClone()).ToArray()));
            if (request.Method == HttpMethod.Get && path == "/super/orders") return Json(new JsonArray(SuperOrders.Select(p => (JsonNode)p.DeepClone()).ToArray()));
            if (request.Method == HttpMethod.Delete && path.StartsWith("/super/orders/"))
            {
                var parts = path.Split('/');
                if (RefuseCancel.Contains($"{parts[3]}/{parts[4]}"))
                    return new HttpResponseMessage(HttpStatusCode.BadRequest) { Content = new StringContent("{\"errorMessage\":\"refused\"}") };
                var order = SuperOrders.Single(o => o["orderId"]!.GetValue<string>() == parts[3]);
                // An entry still filling can fill more before its cancel lands.
                if (parts[4] == "ENTRY_LEG" && FillsBeforeCancel.TryGetValue(parts[3], out var extra))
                    order["filledQty"] = (order["filledQty"]?.GetValue<int>() ?? 0) + extra;
                // Cancelling the entry leg cancels the whole super order, legs included.
                if (parts[4] == "ENTRY_LEG") order["orderStatus"] = "CANCELLED";
                foreach (var leg in order["legDetails"]!.AsArray())
                    if (parts[4] == "ENTRY_LEG" || leg!["legName"]!.GetValue<string>() == parts[4]) leg!["orderStatus"] = "CANCELLED";
                return Json(new JsonObject { ["orderId"] = parts[3], ["orderStatus"] = "CANCELLED" });
            }
            if (request.Method == HttpMethod.Put && path.StartsWith("/super/orders/"))
            {
                lock (SuperModifies) SuperModifies.Add(body!);
                // A pending entry's price and legs move with it.
                var modified = SuperOrders.FirstOrDefault(o => o["orderId"]!.GetValue<string>() == path.Split('/')[3]);
                if (modified is not null && body!["legName"]?.GetValue<string>() == "ENTRY_LEG")
                    foreach (var field in new[] { "price", "targetPrice", "stopLossPrice" })
                        if (body[field] is { } value) modified[field] = value.GetValue<decimal>();
                return Json(new JsonObject { ["orderId"] = path.Split('/')[3], ["orderStatus"] = "PENDING" });
            }
            if (request.Method == HttpMethod.Post && path == "/super/orders")
            {
                var id = $"N{Interlocked.Increment(ref _next)}";
                SuperOrders.Add(new JsonObject
                {
                    ["orderId"] = id, ["orderStatus"] = "PENDING", ["transactionType"] = body!["transactionType"]!.GetValue<string>(),
                    ["exchangeSegment"] = body["exchangeSegment"]!.GetValue<string>(), ["securityId"] = body["securityId"]!.GetValue<string>(),
                    ["quantity"] = body["quantity"]!.GetValue<int>(), ["price"] = body["price"]!.GetValue<decimal>(),
                    ["targetPrice"] = body["targetPrice"]!.GetValue<decimal>(), ["stopLossPrice"] = body["stopLossPrice"]!.GetValue<decimal>(),
                    ["correlationId"] = body["correlationId"]!.GetValue<string>(),
                    ["legDetails"] = new JsonArray(
                        new JsonObject { ["legName"] = "TARGET_LEG", ["orderStatus"] = "PENDING", ["transactionType"] = "SELL", ["price"] = body["targetPrice"]!.GetValue<decimal>() },
                        new JsonObject { ["legName"] = "STOP_LOSS_LEG", ["orderStatus"] = "PENDING", ["transactionType"] = "SELL", ["price"] = body["stopLossPrice"]!.GetValue<decimal>() }),
                });
                return Json(new JsonObject { ["orderId"] = id, ["orderStatus"] = "PENDING" });
            }
            if (request.Method == HttpMethod.Get && path == "/orders")
                return Json(new JsonArray(Orders.Values.Select(o => (JsonNode)new JsonObject
                {
                    ["orderId"] = o.Id, ["orderStatus"] = o.Status, ["securityId"] = SecurityId.ToString(), ["transactionType"] = o.Side,
                    ["quantity"] = o.Quantity, ["filledQty"] = o.Filled, ["price"] = o.Price, ["correlationId"] = o.Tag,
                    ["orderType"] = o.Type, ["triggerPrice"] = o.Trigger ?? 0,
                }).ToArray()));
            if (request.Method == HttpMethod.Post && path == "/orders")
            {
                var id = $"P{Interlocked.Increment(ref _next)}";
                Orders[id] = new PlainOrder
                {
                    Id = id, Side = body!["transactionType"]!.GetValue<string>(), Tag = body["correlationId"]!.GetValue<string>(),
                    Segment = body["exchangeSegment"]!.GetValue<string>(), Product = body["productType"]!.GetValue<string>(),
                    Type = body["orderType"]!.GetValue<string>(), Quantity = body["quantity"]!.GetValue<int>(), Price = body["price"]!.GetValue<decimal>(),
                    PlacedPrice = body["price"]!.GetValue<decimal>(),
                    Trigger = body["triggerPrice"]?.GetValue<decimal>(),
                };
                return Json(new JsonObject { ["orderId"] = id, ["orderStatus"] = "PENDING" });
            }
            if (request.Method == HttpMethod.Put && path.StartsWith("/orders/"))
            {
                var order = Orders[path.Split('/')[2]];
                order.Type = body!["orderType"]!.GetValue<string>();
                if (body["price"] is { } price) order.Price = price.GetValue<decimal>();
                if (body["quantity"] is { } quantity) order.Quantity = order.Filled + quantity.GetValue<int>();
                return Json(new JsonObject { ["orderId"] = order.Id, ["orderStatus"] = order.Status });
            }
            if (request.Method == HttpMethod.Delete && path.StartsWith("/orders/"))
            {
                var order = Orders[path.Split('/')[2]];
                order.Status = "CANCELLED";
                return Json(new JsonObject { ["orderId"] = order.Id, ["orderStatus"] = "CANCELLED" });
            }
            return new HttpResponseMessage(HttpStatusCode.NotFound) { Content = new StringContent("{}") };
        }

        private static HttpResponseMessage Json(JsonNode node) =>
            new(HttpStatusCode.OK) { Content = new StringContent(node.ToJsonString(), Encoding.UTF8, "application/json") };
    }
}

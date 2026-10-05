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

    private static SpotTick Tick(decimal bid, decimal ask, decimal last) =>
        new(SecurityId, last, 0, 0, 0, 0, 1000, bid, ask, 0, DateTimeOffset.UtcNow);

    private static async Task<(LiveTradingService Service, FakeDhan Dhan, DhanMarketFeedClient Feed)> CreateAsync()
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
            new LiveBroadcastBatcher(null, NullLogger<LiveBroadcastBatcher>.Instance), NullLogger<LiveTradingService>.Instance);
        return (service, dhan, feed);
    }

    /// <summary>Just enough of Dhan's REST API: positions, super orders (with leg cancel) and plain
    /// orders (place, modify, cancel), in memory. Requests are recorded as "METHOD /path".</summary>
    private sealed class FakeDhan(string scripMaster) : HttpMessageHandler
    {
        public List<JsonObject> Positions { get; } = new();
        public List<JsonObject> SuperOrders { get; } = new();
        public List<JsonObject> SuperModifies { get; } = new();
        public ConcurrentDictionary<string, PlainOrder> Orders { get; } = new();
        public List<string> Requests { get; } = new();
        private int _next;

        public sealed class PlainOrder
        {
            public required string Id, Side, Tag, Segment, Product;
            public string Type = "LIMIT", Status = "PENDING";
            public int Quantity, Filled;
            public decimal Price;
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
                var order = SuperOrders.Single(o => o["orderId"]!.GetValue<string>() == parts[3]);
                // Cancelling the entry leg cancels the whole super order, legs included.
                if (parts[4] == "ENTRY_LEG") order["orderStatus"] = "CANCELLED";
                foreach (var leg in order["legDetails"]!.AsArray())
                    if (parts[4] == "ENTRY_LEG" || leg!["legName"]!.GetValue<string>() == parts[4]) leg!["orderStatus"] = "CANCELLED";
                return Json(new JsonObject { ["orderId"] = parts[3], ["orderStatus"] = "CANCELLED" });
            }
            if (request.Method == HttpMethod.Put && path.StartsWith("/super/orders/"))
            {
                lock (SuperModifies) SuperModifies.Add(body!);
                return Json(new JsonObject { ["orderId"] = path.Split('/')[3], ["orderStatus"] = "PENDING" });
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

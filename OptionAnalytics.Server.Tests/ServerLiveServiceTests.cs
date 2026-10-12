using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Live trading by the server scanner (ServerLiveService): Live is for today only, and an alert becomes a real
/// order only within every limit - checked by the server, never trusted to the scanner.</summary>
public sealed class ServerLiveServiceTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "oa-server-live-" + Guid.NewGuid().ToString("n"));
    private static readonly DateOnly Expiry = new(2026, 10, 13);
    // 10:00 IST on 12 Oct 2026.
    private static readonly DateTimeOffset At10 = new(2026, 10, 12, 10, 0, 0, TimeSpan.FromHours(5.5));

    public void Dispose() { try { Directory.Delete(_dir, true); } catch { /* temp */ } }

    private sealed class FakeHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "Tests";
        public string ContentRootPath { get; set; } = "";
        public IFileProvider ContentRootFileProvider { get; set; } = null!;
    }

    private sealed class FakeOrders : IServerLiveOrders
    {
        public List<ManualOrderRequest> Placed { get; } = new();
        public List<(IReadOnlyList<string> Ids, bool OnlyWorking)> Exits { get; } = new();
        public bool Fail { get; set; }
        public Task<ManualOrderResult> PlaceAsync(ManualOrderRequest request, CancellationToken cancellationToken)
        {
            if (Fail) return Task.FromResult(ManualOrderResult.Fail("Blocked: the daily loss limit was reached today."));
            Placed.Add(request);
            return Task.FromResult(new ManualOrderResult(true, "placed", new[] { $"o{Placed.Count}" }, new ManualOrderPrices(100, 101, 131, 81)) { LotSize = 75 });
        }
        public Task<ManualOrderResult> ExitTradeAsync(IReadOnlyList<string> orderIds, decimal slippagePoints, CancellationToken cancellationToken, bool onlyWithWorkingLegs)
        {
            Exits.Add((orderIds, onlyWithWorkingLegs));
            return Task.FromResult(new ManualOrderResult(true, "exited", orderIds, null));
        }
    }

    /// <summary>The trade settings these tests are written against - set here, not the app's defaults (those are the
    /// trader's and can change): 1 lot, SL 20 / target 30 on NIFTY (50 / 75, 60 / 90) for a manual trade and as the max.
    /// Set once per test folder, so a test's own change made through another store instance is kept.</summary>
    private TradeSettingsStore Trade()
    {
        var path = Path.Combine(_dir, "trade-settings.csv");
        var fresh = !File.Exists(path);
        var store = new TradeSettingsStore(new FakeHostEnvironment { ContentRootPath = _dir },
            new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Storage:TradeSettingsPath"] = path }).Build(),
            NullLogger<TradeSettingsStore>.Instance);
        if (fresh)
            foreach (var (u, sl, target) in new[] { ("NIFTY", 20m, 30m), ("BANKNIFTY", 50m, 75m), ("SENSEX", 60m, 90m) })
                store.Save(u, store.Get(u) with { Lots = 1, SlPoints = sl, TargetPoints = target, MaxSlPoints = sl, MaxTargetPoints = target });
        return store;
    }

    private ServerLiveService Live(FakeOrders orders, TradeSettingsStore? trade = null) =>
        new(trade ?? Trade(), orders, Path.Combine(_dir, "server-live.json"), NullLogger<ServerLiveService>.Instance);

    private static ServerLiveOrderRequest Order(string key = "s1-1-sell", decimal? sl = null, decimal? target = null) =>
        new(key, "#1 test", Expiry, 25000, "PE", "SELL", sl, target, 0, null);

    [Fact]
    public async Task AStrategyNotOnTheIndexsLiveList_StaysOnPaper()
    {
        var orders = new FakeOrders();
        var live = new ServerLiveService(Trade(), orders, Path.Combine(_dir, "server-live.json"), NullLogger<ServerLiveService>.Instance, null,
            (u, id) => u == "NIFTY" && id == "proven" ? null : $"#{id} is not on {u}'s live list");
        live.Set("NIFTY", true, null, null, "admin", At10);
        var r = await live.PlaceAsync("NIFTY", Order("trial-1-sell"), At10, default);
        Assert.False(r.Placed);
        Assert.Contains("not on NIFTY's live list", r.Message);
        Assert.Empty(orders.Placed);
        Assert.True((await live.PlaceAsync("NIFTY", Order("proven-2-sell"), At10, default)).Placed); // the id from the key
        Assert.Single(orders.Placed);
    }

    [Fact]
    public async Task TheServersOwnIndexStopCheck_ExitsALiveTrade_EvenWithoutTheScanner()
    {
        var orders = new FakeOrders();
        var live = Live(orders);
        live.Set("NIFTY", true, null, null, "admin", At10);
        live.Set("BANKNIFTY", true, null, null, "admin", At10);
        // A LONG on NIFTY (index stop 24980) and a SHORT on BANKNIFTY (index stop 51200).
        await live.PlaceAsync("NIFTY", new ServerLiveOrderRequest("long-1-sell", null, Expiry, 25000, "PE", "SELL", IndexStop: 24980, IndexSide: "LONG"), At10, default);
        await live.PlaceAsync("BANKNIFTY", new ServerLiveOrderRequest("short-1-sell", null, Expiry, 51000, "CE", "SELL", IndexStop: 51200, IndexSide: "SHORT"), At10, default);
        decimal? nifty = 24995, bank = 51150;
        decimal? PriceOf(string u) => u == "NIFTY" ? nifty : u == "BANKNIFTY" ? bank : null;

        Assert.Equal(0, await live.CheckIndexStopsAsync(PriceOf, At10.AddMinutes(1), default)); // both on the right side
        Assert.Empty(orders.Exits);
        // The trail tightens NIFTY's stop to 24990; a late report of the old one does not loosen it.
        Assert.True(live.MoveIndexStop("NIFTY", "long-1-sell", 24990));
        Assert.True(live.MoveIndexStop("NIFTY", "long-1-sell", 24970));
        nifty = 24989;
        Assert.Equal(1, await live.CheckIndexStopsAsync(PriceOf, At10.AddMinutes(2), default));
        Assert.Equal(new[] { "o1" }, orders.Exits.Single().Ids);
        var n = live.Status(At10).Single(x => x.Underlying == "NIFTY").Trades.Single();
        Assert.NotNull(n.ExitedUtc);
        Assert.Contains("index SL 24990", n.ExitReason);
        // Closed: never exited again.
        Assert.Equal(0, await live.CheckIndexStopsAsync(PriceOf, At10.AddMinutes(3), default));
        // The SHORT: a price at its stop exits it; no fresh price (null) - nothing done.
        bank = null;
        Assert.Equal(0, await live.CheckIndexStopsAsync(PriceOf, At10.AddMinutes(3), default));
        bank = 51200;
        Assert.Equal(1, await live.CheckIndexStopsAsync(PriceOf, At10.AddMinutes(4), default));
        Assert.Equal(2, orders.Exits.Count);
        Assert.False(live.MoveIndexStop("BANKNIFTY", "short-1-sell", 51100)); // no longer open
    }

    [Fact]
    public async Task ALiveTradeTheOrderFlowPagePlaced_IsWatchedByTheServer_ItsIndexStopAndTargetExitIt_WithThePageClosed()
    {
        var orders = new FakeOrders();
        var live = Live(orders);
        // The page placed two live trades (its own Dhan super orders) and hands them to the server to watch.
        Assert.Null(live.WatchPageTrade(new PageLiveWatchRequest("NIFTY", "vwap-1-sell", new[] { "p1" }, 24980, "LONG", 25040, "#27 VWAP", "SELL 25000 PE"), At10));
        Assert.Null(live.WatchPageTrade(new PageLiveWatchRequest("NIFTY", "wall-2-sell", new[] { "p2" }, 25060, "SHORT", 24990, "#2 Wall", "SELL 25000 CE"), At10));
        // Bad requests are refused, never guessed.
        Assert.NotNull(live.WatchPageTrade(new PageLiveWatchRequest("NIFTY", "x", Array.Empty<string>(), 24980, "LONG"), At10));
        Assert.NotNull(live.WatchPageTrade(new PageLiveWatchRequest("NIFTY", "x", new[] { "p9" }, 24980, "UP"), At10));
        Assert.NotNull(live.WatchPageTrade(new PageLiveWatchRequest("NIFTY", "x", new[] { "p9" }, 24980, "LONG", 24970), At10)); // target below a LONG's stop
        // They are not the server scanner's trades: its limits (one open at a time) do not see them.
        live.Set("NIFTY", true, null, null, "admin", At10);
        var status = live.Status(At10).Single(x => x.Underlying == "NIFTY");
        Assert.Equal((0, 0, 2), (status.TradesToday, status.OpenToday, status.Trades.Count));
        Assert.True((await live.PlaceAsync("NIFTY", Order("server-1-sell"), At10, default)).Placed);
        orders.Placed.Clear();

        decimal? nifty = 25010;
        decimal? PriceOf(string u) => u == "NIFTY" ? nifty : null;
        Assert.Equal(0, await live.CheckIndexStopsAsync(PriceOf, At10.AddMinutes(1), default));
        // The page's trailing stop tightens the LONG's stop; a looser one is ignored.
        Assert.True(live.MovePageIndexStop("NIFTY", "vwap-1-sell", 25000));
        Assert.True(live.MovePageIndexStop("NIFTY", "vwap-1-sell", 24950));
        nifty = 24999; // through the LONG's trailed stop (25000), not the SHORT's target (24990)
        Assert.Equal(1, await live.CheckIndexStopsAsync(PriceOf, At10.AddMinutes(2), default));
        Assert.Equal(new[] { "p1" }, orders.Exits.Single().Ids);
        Assert.True(orders.Exits.Single().OnlyWorking, "only while its legs still work on Dhan");
        var trades = live.Status(At10).Single(x => x.Underlying == "NIFTY").Trades;
        Assert.Contains("index SL 25000", trades.Single(t => t.Key == "page:vwap-1-sell").ExitReason);
        // The SHORT's INDEX TARGET (24990): exited there too.
        nifty = 24985;
        Assert.Equal(1, await live.CheckIndexStopsAsync(PriceOf, At10.AddMinutes(3), default));
        Assert.Equal(new[] { "p2" }, orders.Exits.Last().Ids);
        Assert.Contains("index target 24990", live.Status(At10).Single(x => x.Underlying == "NIFTY").Trades.Single(t => t.Key == "page:wall-2-sell").ExitReason);
        Assert.Empty(orders.Placed); // the page's trades never place anything here
    }

    [Fact]
    public async Task AStrategysOwnLotSize_GoesOnItsLiveOrder_ElseTheIndexsLots()
    {
        var orders = new FakeOrders();
        var trade = Trade();
        var live = Live(orders, trade);
        live.Set("NIFTY", true, 20, null, "admin", At10);
        // Its own 4 lots (applied with it on the Trades page).
        await live.PlaceAsync("NIFTY", new ServerLiveOrderRequest("a-1-sell", null, Expiry, 25000, "PE", "SELL", Lots: 4), At10, default);
        live.ExitAsync("NIFTY", "a-1-sell", "done", 0, At10.AddMinutes(1), default).Wait();
        // None of its own: the index's (Trade settings).
        await live.PlaceAsync("NIFTY", new ServerLiveOrderRequest("b-2-sell", null, Expiry, 25000, "PE", "SELL"), At10.AddMinutes(2), default);
        live.ExitAsync("NIFTY", "b-2-sell", "done", 0, At10.AddMinutes(3), default).Wait();
        // Out of Trade settings' own range: the index's.
        await live.PlaceAsync("NIFTY", new ServerLiveOrderRequest("c-3-sell", null, Expiry, 25000, "PE", "SELL", Lots: 9000), At10.AddMinutes(4), default);
        Assert.Equal(new[] { 4, trade.Get("NIFTY").Lots, trade.Get("NIFTY").Lots }, orders.Placed.Select(o => o.Lots));
    }

    [Fact]
    public async Task APageTradeExitedFromThePage_IsNoLongerWatched()
    {
        var orders = new FakeOrders();
        var live = Live(orders);
        Assert.Null(live.WatchPageTrade(new PageLiveWatchRequest("BANKNIFTY", "k-1-buy", new[] { "a", "b" }, 51000, "LONG"), At10));
        Assert.Equal(1, live.ClosedByOrders(new[] { "b" }, "exited from the page", At10.AddMinutes(1)));
        Assert.Equal(0, await live.CheckIndexStopsAsync(_ => 50000, At10.AddMinutes(2), default)); // far through the stop: already closed
        Assert.Empty(orders.Exits);
        Assert.Equal(0, live.ClosedByOrders(new[] { "b" }, "again", At10.AddMinutes(3)));
    }

    [Fact]
    public async Task TheServerScannersOwnTrade_ExitsAtItsIndexTarget_Too()
    {
        var orders = new FakeOrders();
        var live = Live(orders);
        live.Set("NIFTY", true, null, null, "admin", At10);
        await live.PlaceAsync("NIFTY", new ServerLiveOrderRequest("long-1-sell", null, Expiry, 25000, "PE", "SELL", IndexStop: 24980, IndexSide: "LONG", IndexTarget: 25040), At10, default);
        Assert.Equal(0, await live.CheckIndexStopsAsync(_ => 25039, At10.AddMinutes(1), default));
        Assert.Equal(1, await live.CheckIndexStopsAsync(_ => 25040, At10.AddMinutes(2), default));
        Assert.Contains("index target 25040", live.Status(At10).Single(x => x.Underlying == "NIFTY").Trades.Single().ExitReason);
    }

    [Fact]
    public async Task ASpotStrategysTrade_IsWatchedOnTheSpotPrice_NeverOnTheFutures()
    {
        var orders = new FakeOrders();
        var live = Live(orders);
        live.Set("NIFTY", true, null, null, "admin", At10);
        // A spot + options strategy's levels are SPOT prices: stop 24980 / target 25040 on the spot (futures ~60 above).
        await live.PlaceAsync("NIFTY", new ServerLiveOrderRequest("spotWallBreak-1-sell", "#101 Spot", Expiry, 25000, "PE", "SELL", IndexStop: 24980, IndexSide: "LONG", IndexTarget: 25040, PriceBasis: "spot"), At10, default);
        var trade = live.Status(At10).Single(x => x.Underlying == "NIFTY").Trades.Single();
        Assert.Equal("spot", trade.PriceBasis);
        // The futures are through its target (25060) - not its basis: nothing happens; the futures-only check never touches it.
        decimal? Prices(string u, string basis) => basis == "spot" ? 25010 : 25060;
        Assert.Equal(0, await live.CheckIndexStopsAsync(Prices, At10.AddMinutes(1), default));
        Assert.Equal(0, await live.CheckIndexStopsAsync(_ => 24900, At10.AddMinutes(1), default));
        // The trail moves its spot stop up; the SPOT going through it exits it.
        Assert.True(live.MoveIndexStop("NIFTY", "spotWallBreak-1-sell", 25000));
        Assert.Equal(1, await live.CheckIndexStopsAsync((u, basis) => basis == "spot" ? 24999 : 25060, At10.AddMinutes(2), default));
        var closed = live.Status(At10).Single(x => x.Underlying == "NIFTY").Trades.Single();
        Assert.Contains("index SL 25000", closed.ExitReason);
        Assert.Contains("spot 24999", closed.ExitReason);
        Assert.Single(orders.Exits);
        // A futures strategy's trade (no basis sent) keeps the futures price.
        Assert.Null(ServerLiveService.NormaliseBasis(null));
        Assert.Null(ServerLiveService.NormaliseBasis("futures"));
        Assert.Equal("spot", ServerLiveService.NormaliseBasis(" SPOT "));
    }

    [Fact]
    public async Task TheOiReplayPagesSpotTrade_IsWatchedOnTheSpotPrice()
    {
        var orders = new FakeOrders();
        var live = Live(orders);
        // Placed by the OI Replay page's spot + options scanner: its index levels are spot prices.
        Assert.Null(live.WatchPageTrade(new PageLiveWatchRequest("NIFTY", "spotLadder-1-sell", new[] { "p1" }, 24980, "LONG", 25040, "#107 Spot ladder", "SELL 25000 PE", PriceBasis: "spot"), At10));
        var t = live.Status(At10).Single(x => x.Underlying == "NIFTY").Trades.Single();
        Assert.Equal("spot", t.PriceBasis);
        Assert.True(t.IsPageTrade);
        Assert.Equal(0, await live.CheckIndexStopsAsync((u, basis) => basis == "spot" ? 25039 : 24900, At10.AddMinutes(1), default)); // the futures are not its price
        Assert.Equal(1, await live.CheckIndexStopsAsync((u, basis) => basis == "spot" ? 25041 : 24900, At10.AddMinutes(2), default));
        Assert.Contains("index target 25040", live.Status(At10).Single(x => x.Underlying == "NIFTY").Trades.Single().ExitReason);
        Assert.Single(orders.Exits);
    }

    [Fact]
    public async Task OnPaper_NothingIsEverSent()
    {
        var orders = new FakeOrders();
        var r = await Live(orders).PlaceAsync("NIFTY", Order(), At10, default);
        Assert.False(r.Placed);
        Assert.Contains("paper", r.Message);
        Assert.Empty(orders.Placed);
    }

    [Fact]
    public async Task LiveIsForTodayOnly_TheNextDayItIsPaperAgain()
    {
        var orders = new FakeOrders();
        var live = Live(orders);
        Assert.Null(live.Set("NIFTY", true, null, null, "admin", At10));
        Assert.True(live.IsLive("NIFTY", At10));
        Assert.False(live.IsLive("BANKNIFTY", At10)); // per index
        Assert.False(live.IsLive("NIFTY", At10.AddDays(1)));
        Assert.False((await live.PlaceAsync("NIFTY", Order(), At10.AddDays(1), default)).Placed);
        // Kept across a restart (the file), still for today only.
        Assert.True(Live(orders).IsLive("NIFTY", At10));
        Assert.Null(live.Set("NIFTY", false, null, null, "admin", At10));
        Assert.False(live.IsLive("NIFTY", At10));
    }

    [Fact]
    public async Task ALiveOrder_UsesTheIndexTradeSettings_AndTheScannersOptionLevels()
    {
        var trade = Trade();
        trade.Save("NIFTY", trade.Get("NIFTY") with { Lots = 3, SlippagePoints = 1.5m, TrailStart = 5, TrailGap = 4 });
        var orders = new FakeOrders();
        var live = Live(orders, trade);
        live.Set("NIFTY", true, null, null, "admin", At10);
        var r = await live.PlaceAsync("NIFTY", Order(sl: 18, target: 27), At10, default);
        Assert.True(r.Placed, r.Message);
        var o = Assert.Single(orders.Placed);
        Assert.Equal((3, 1.5m, 18m, 27m, 5m, 4m, "SELL", "PE", 25000m), (o.Lots, o.SlippagePoints, o.StopLossPoints, o.TargetPoints, o.TrailStartPoints, o.TrailGapPoints, o.Direction, o.Side, o.Strike));
        // No levels from the scanner: the index's own.
        live.Set("NIFTY", true, 5, null, "admin", At10);
        await live.ExitAsync("NIFTY", "s1-1-sell", "target", 500, At10, default);
        await live.PlaceAsync("NIFTY", Order("s2-1-sell"), At10.AddMinutes(5), default);
        Assert.Equal((20m, 30m), (orders.Placed[1].StopLossPoints, orders.Placed[1].TargetPoints));
    }

    [Fact]
    public async Task AStrategyWithItsOwnOptionExit_TradesItsOwnTrailingStop_NotTheIndexs()
    {
        var trade = Trade();
        trade.Save("NIFTY", trade.Get("NIFTY") with { TrailStart = 5, TrailGap = 4 });
        var orders = new FakeOrders();
        var live = Live(orders, trade);
        live.Set("NIFTY", true, 5, null, "admin", At10);

        // Its own exit has no trailing stop: none, though the index trails at 4 pts.
        await live.PlaceAsync("NIFTY", Order("own-1-sell", 18, 27) with { TrailStartPoints = 0, TrailGapPoints = 0 }, At10, default);
        Assert.Equal((0m, 0m), (orders.Placed[0].TrailStartPoints, orders.Placed[0].TrailGapPoints));
        await live.ExitAsync("NIFTY", "own-1-sell", "target", 500, At10, default);

        // A trail of its own is used as sent.
        await live.PlaceAsync("NIFTY", Order("own-2-sell", 18, 27) with { TrailStartPoints = 6, TrailGapPoints = 3 }, At10.AddMinutes(2), default);
        Assert.Equal((6m, 3m), (orders.Placed[1].TrailStartPoints, orders.Placed[1].TrailGapPoints));
        await live.ExitAsync("NIFTY", "own-2-sell", "target", 500, At10, default);

        // Nothing sent: the index's (Trade settings).
        await live.PlaceAsync("NIFTY", Order("plain-3-sell", 18, 27), At10.AddMinutes(4), default);
        Assert.Equal((5m, 4m), (orders.Placed[2].TrailStartPoints, orders.Placed[2].TrailGapPoints));
    }

    [Fact]
    public async Task ALiveOrder_IsHeldToTheIndexsMaxRules()
    {
        var trade = Trade();
        trade.Save("NIFTY", trade.Get("NIFTY") with { SlPoints = 5, TargetPoints = 5, MaxSlPoints = 30, MaxTargetPoints = 45 });
        var orders = new FakeOrders();
        var live = Live(orders, trade);
        live.Set("NIFTY", true, 5, null, "admin", At10);
        // The strategy's own legs, wider than the max: held to it.
        await live.PlaceAsync("NIFTY", Order("a-1-sell", 50, 90), At10, default);
        Assert.Equal((30m, 45m), (orders.Placed[0].StopLossPoints, orders.Placed[0].TargetPoints));
        await live.ExitAsync("NIFTY", "a-1-sell", "target", 500, At10, default);
        // Tighter than the max: its own - never the manual SL / target (5 / 5).
        await live.PlaceAsync("NIFTY", Order("b-2-sell", 12, 20), At10.AddMinutes(2), default);
        Assert.Equal((12m, 20m), (orders.Placed[1].StopLossPoints, orders.Placed[1].TargetPoints));
        Assert.Equal(12m, ServerLiveService.Capped(12, 0));
        Assert.Equal(30m, ServerLiveService.Capped(null, 30));
        Assert.Equal(0m, ServerLiveService.Capped(null, 0));
    }

    [Fact]
    public async Task OneOpenTradeAtATime_AndTheSameSignalNeverTwice()
    {
        var orders = new FakeOrders();
        var live = Live(orders);
        live.Set("NIFTY", true, null, null, "admin", At10);
        Assert.True((await live.PlaceAsync("NIFTY", Order("a"), At10, default)).Placed);
        var second = await live.PlaceAsync("NIFTY", Order("b"), At10.AddMinutes(1), default);
        Assert.False(second.Placed);
        Assert.Contains("still open", second.Message);
        await live.ExitAsync("NIFTY", "a", "stop", -300, At10.AddMinutes(2), default);
        Assert.Equal(new[] { "o1" }, orders.Exits.Single().Ids);
        Assert.True(orders.Exits.Single().OnlyWorking, "never closes a later position in the same contract");
        Assert.False((await live.PlaceAsync("NIFTY", Order("a"), At10.AddMinutes(3), default)).Placed); // the same signal again
        Assert.True((await live.PlaceAsync("NIFTY", Order("b"), At10.AddMinutes(3), default)).Placed);
        // Another index is not held up by NIFTY's open trade - but it must be Live itself.
        live.Set("BANKNIFTY", true, null, null, "admin", At10);
        Assert.True((await live.PlaceAsync("BANKNIFTY", Order("c"), At10.AddMinutes(3), default)).Placed);
    }

    [Fact]
    public void EachIndex_StartsOnPaper_WithTheDefaultLimits_AndKeepsWhatIsSet()
    {
        var live = Live(new FakeOrders());
        // Before anything is set: paper, 5 live trades a day, a max loss of 15,000 (10,000 on SENSEX).
        Assert.Equal(new[] { ("NIFTY", false, 5, 15_000m), ("BANKNIFTY", false, 5, 15_000m), ("SENSEX", false, 5, 10_000m) },
            live.Status(At10).Select(x => (x.Underlying, x.Live, x.MaxTrades, x.MaxLoss)));
        // Switching an index to Live without new limits keeps its defaults; set limits are kept.
        live.Set("BANKNIFTY", true, null, null, "admin", At10);
        live.Set("SENSEX", false, 3, 8_000, "admin", At10);
        var after = live.Status(At10).ToDictionary(x => x.Underlying);
        Assert.Equal((true, 5, 15_000m), (after["BANKNIFTY"].Live, after["BANKNIFTY"].MaxTrades, after["BANKNIFTY"].MaxLoss));
        Assert.Equal((3, 8_000m), (after["SENSEX"].MaxTrades, after["SENSEX"].MaxLoss));
    }

    [Fact]
    public async Task TheMaxTradesAndMaxLossOfTheDay_StopNewOrders()
    {
        var orders = new FakeOrders();
        var live = Live(orders);
        live.Set("NIFTY", true, 2, 1000, "admin", At10);
        await live.PlaceAsync("NIFTY", Order("a"), At10, default);
        await live.ExitAsync("NIFTY", "a", "target", 200, At10, default);
        await live.PlaceAsync("NIFTY", Order("b"), At10.AddMinutes(1), default);
        await live.ExitAsync("NIFTY", "b", "target", 100, At10.AddMinutes(1), default);
        var third = await live.PlaceAsync("NIFTY", Order("c"), At10.AddMinutes(2), default);
        Assert.False(third.Placed);
        Assert.Contains("limit of 2", third.Message);

        live.Set("NIFTY", true, 10, 1000, "admin", At10);
        await live.PlaceAsync("NIFTY", Order("d"), At10.AddMinutes(3), default);
        await live.ExitAsync("NIFTY", "d", "stop", -1400, At10.AddMinutes(4), default); // day: +300 - 1400 = -1100
        var afterLoss = await live.PlaceAsync("NIFTY", Order("e"), At10.AddMinutes(5), default);
        Assert.False(afterLoss.Placed);
        Assert.Contains("loss", afterLoss.Message);
        var s = live.Status(At10).Single(x => x.Underlying == "NIFTY");
        Assert.Equal((3, 0, -1100m), (s.TradesToday, s.OpenToday, s.PnlToday));
    }

    [Fact]
    public async Task ATradeNeverReportedClosed_StopsCountingAsOpenAtItsTimeExit()
    {
        var orders = new FakeOrders();
        var live = Live(orders);
        live.Set("NIFTY", true, null, null, "admin", At10);
        var exitAt = At10.AddMinutes(30).ToUnixTimeMilliseconds();
        await live.PlaceAsync("NIFTY", new ServerLiveOrderRequest("a", null, Expiry, 25000, "PE", "SELL", null, null, exitAt), At10, default);
        Assert.False((await live.PlaceAsync("NIFTY", Order("b"), At10.AddMinutes(10), default)).Placed);
        Assert.True((await live.PlaceAsync("NIFTY", Order("b"), At10.AddMinutes(31), default)).Placed);
    }

    [Fact]
    public async Task NoNewLiveEntry_Before0915OrAfter1445()
    {
        var orders = new FakeOrders();
        var live = Live(orders);
        live.Set("NIFTY", true, null, null, "admin", At10);
        var late = new DateTimeOffset(2026, 10, 12, 14, 46, 0, TimeSpan.FromHours(5.5));
        var early = new DateTimeOffset(2026, 10, 12, 9, 14, 0, TimeSpan.FromHours(5.5));
        Assert.False((await live.PlaceAsync("NIFTY", Order("a"), late, default)).Placed);
        Assert.False((await live.PlaceAsync("NIFTY", Order("b"), early, default)).Placed);
        Assert.Empty(orders.Placed);
    }

    [Fact]
    public async Task ARejectedOrder_IsNotRecorded_AndBadOrdersNeverGoOut()
    {
        var orders = new FakeOrders { Fail = true };
        var live = Live(orders);
        live.Set("NIFTY", true, null, null, "admin", At10);
        var r = await live.PlaceAsync("NIFTY", Order("a"), At10, default);
        Assert.False(r.Placed);
        Assert.Contains("loss limit", r.Message); // the account kill switch's own answer
        Assert.Equal(0, live.Status(At10).Single(x => x.Underlying == "NIFTY").TradesToday);
        orders.Fail = false;
        Assert.False((await live.PlaceAsync("NIFTY", new ServerLiveOrderRequest("x", null, Expiry, 25000, "XX", "SELL"), At10, default)).Placed);
        Assert.Empty(orders.Placed);
        Assert.NotNull(live.Set("NIFTY", true, 0, null, "admin", At10)); // limits validated
    }
}

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Controllers;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services;
using OptionAnalytics.Server.Services.OrderFlow;

namespace OptionAnalytics.Server.Tests;

/// <summary>Order flow in real time: a trade judged against the book as it had ARRIVED by its tick (not a book update
/// that came later but was applied first), no giant false print after a feed reconnect, Dhan's running volume never
/// counted twice when a packet comes a little behind, nothing booked outside the session - and the service's one inbox
/// (ticks and depth in arrival order, the depth sockets never waiting on an engine), shown in the feed health.</summary>
public sealed class OrderFlowRealtimeTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 5, 4, 0, 0, TimeSpan.Zero); // 09:30 IST

    private static OrderFlowEngine NewEngine() => new("NIFTY", 35001, "NIFTY-Oct2026-FUT", "NSE_FNO", 0.05m, 75);

    private static SpotTick Tick(decimal price, long volume, decimal bid, decimal ask, int session = 0, DateTimeOffset? receivedAt = null) =>
        new(35001, price, 0, 0, 0, 0, volume, bid, ask, 0, T0)
        {
            Bids = new[] { new DepthLevel(bid, 750, 5) },
            Asks = new[] { new DepthLevel(ask, 750, 5) },
            FeedSession = session,
            ReceivedAt = receivedAt,
        };

    private static OrderFlowBar OnlyBar(OrderFlowEngine engine) => Assert.Single(engine.Snapshot(rowSize: 0, minTradeQty: 1, heatmapColumns: 10).Bars);

    [Fact]
    public void ABookUpdateThatArrivedAfterTheTrade_IsNotTheBookItTradedAgainst()
    {
        var engine = NewEngine();
        engine.OnTick(Tick(100.00m, 1000, 99.95m, 100.00m), T0);
        // The depth socket's packet came off its socket at +600 ms - the book after a buyer took the 100.00 offer and a new
        // bid joined there - but was applied before the tick that came off the market feed at +500 ms with that trade.
        engine.OnDepth(new DepthSidePacket(35001, 2, true, new[] { new DepthLevel(100.00m, 750, 5) }, 200), T0.AddMilliseconds(600));
        engine.OnTick(Tick(100.00m, 1150, 100.00m, 100.05m), T0.AddMilliseconds(500));

        // As of +500 ms the book was 99.95 / 100.00: a buyer lifted the offer. Judged against the later book (bid 100.00)
        // it read as a seller hitting the bid.
        var bar = OnlyBar(engine);
        Assert.Equal(150, bar.Buy);
        Assert.Equal(0, bar.Sell);
        // Just before the tick, the book on record is still 99.95 / 100.00 - the later packet is left out.
        var asOf = engine.QuotesAsOf(T0.AddMilliseconds(499));
        Assert.Equal((99.95m, 100.00m), (asOf.Bid, asOf.Ask));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void TheSameTrade_IsTheSameSide_WhicheverSocketArrivesFirst(bool bookFirst)
    {
        // A seller takes the 100.00 bid and the rest of the order rests there as the new offer. The side used to turn on
        // which socket delivered first: the book first read as a buyer at the ask.
        var seller = NewEngine();
        seller.OnTick(Tick(100.05m, 1000, 100.00m, 100.05m), T0);
        void SellerBook()
        {
            seller.OnDepth(new DepthSidePacket(35001, 2, true, new[] { new DepthLevel(99.95m, 750, 5) }, 200), T0.AddMilliseconds(300));
            seller.OnDepth(new DepthSidePacket(35001, 2, false, new[] { new DepthLevel(100.00m, 750, 5) }, 200), T0.AddMilliseconds(300));
        }
        if (bookFirst) SellerBook();
        seller.OnTick(Tick(100.00m, 1150, 99.95m, 100.00m), T0.AddMilliseconds(bookFirst ? 400 : 250));
        if (!bookFirst) SellerBook();
        Assert.Equal((0L, 150L), (OnlyBar(seller).Buy, OnlyBar(seller).Sell));

        // The mirror: a buyer takes the 100.05 offer and the rest rests there as the new bid.
        var buyer = NewEngine();
        buyer.OnTick(Tick(100.00m, 1000, 100.00m, 100.05m), T0);
        void BuyerBook()
        {
            buyer.OnDepth(new DepthSidePacket(35001, 2, true, new[] { new DepthLevel(100.05m, 750, 5) }, 200), T0.AddMilliseconds(300));
            buyer.OnDepth(new DepthSidePacket(35001, 2, false, new[] { new DepthLevel(100.10m, 750, 5) }, 200), T0.AddMilliseconds(300));
        }
        if (bookFirst) BuyerBook();
        buyer.OnTick(Tick(100.05m, 1150, 100.05m, 100.10m), T0.AddMilliseconds(bookFirst ? 400 : 250));
        if (!bookFirst) BuyerBook();
        Assert.Equal((150L, 0L), (OnlyBar(buyer).Buy, OnlyBar(buyer).Sell));
    }

    [Fact]
    public void AMarketFeedQuote_BeatsADepthSocketThatWentQuiet()
    {
        // The depth book is 4 s old - still "fresh" for the book held - while the market feed shows the market 5 points lower.
        var engine = NewEngine();
        engine.OnDepth(new DepthSidePacket(35001, 2, true, new[] { new DepthLevel(100.00m, 750, 5) }, 200), T0);
        engine.OnDepth(new DepthSidePacket(35001, 2, false, new[] { new DepthLevel(100.05m, 750, 5) }, 200), T0);
        engine.OnTick(Tick(100.00m, 1000, 100.00m, 100.05m), T0);
        engine.OnTick(Tick(95.05m, 1000, 95.00m, 95.05m), T0.AddMilliseconds(3900));
        engine.OnTick(Tick(95.05m, 1150, 95.00m, 95.05m), T0.AddMilliseconds(4000));   // a buyer lifts the 95.05 offer

        Assert.Equal((150L, 0L), (OnlyBar(engine).Buy, OnlyBar(engine).Sell));
    }

    [Fact]
    public void WithNoRecentMarketFeedQuote_TheDepthSocketsDecide()
    {
        var engine = NewEngine();
        engine.OnTick(Tick(100.00m, 1000, 100.00m, 100.05m), T0);
        // A quiet market feed: its quote is 5 s old, the depth sockets have the book at 99.00 / 99.05.
        engine.OnDepth(new DepthSidePacket(35001, 2, true, new[] { new DepthLevel(99.00m, 750, 5) }, 200), T0.AddSeconds(4));
        engine.OnDepth(new DepthSidePacket(35001, 2, false, new[] { new DepthLevel(99.05m, 750, 5) }, 200), T0.AddSeconds(4));
        engine.OnTick(Tick(99.05m, 1150, 99.00m, 99.05m), T0.AddSeconds(5));

        Assert.Equal((150L, 0L), (OnlyBar(engine).Buy, OnlyBar(engine).Sell));
    }

    [Fact]
    public void APacketBehindTheLast_IsNotThePriceTheTickRuleReads()
    {
        var engine = NewEngine();
        engine.OnTick(Tick(100.20m, 1000, 100.05m, 100.15m), T0);
        engine.OnTick(Tick(100.10m, 1100, 100.05m, 100.15m), T0.AddMilliseconds(100));   // at the mid, down: a seller
        engine.OnTick(Tick(100.00m, 1050, 100.05m, 100.15m), T0.AddMilliseconds(200));   // an older packet, out of order
        engine.OnTick(Tick(100.10m, 1150, 100.05m, 100.15m), T0.AddMilliseconds(300));   // at the mid, unchanged: the same side

        Assert.Equal((0L, 150L), (OnlyBar(engine).Buy, OnlyBar(engine).Sell));
    }

    [Fact]
    public void ATradeGoesInTheExchangesMinute_NotTheMinuteItArrived()
    {
        var engine = NewEngine();
        var traded = T0.AddSeconds(59);
        engine.OnTick(Tick(100.00m, 1000, 100.00m, 100.05m) with { ExchangeTimestamp = traded }, traded);
        engine.OnTick(Tick(100.05m, 1150, 100.00m, 100.05m) with { ExchangeTimestamp = traded }, traded.AddSeconds(1.3));   // reached us at 09:31:00.3

        Assert.Equal(T0, OnlyBar(engine).Time);
    }

    [Fact]
    public void AnExchangeTimeFarFromArrival_IsNotBelieved_TheBarIsByArrival()
    {
        var engine = NewEngine();
        engine.OnTick(Tick(100.00m, 1000, 100.00m, 100.05m), T0);
        // The stale last trade time a first packet can carry: the bar is the minute it came, not a minute long gone.
        engine.OnTick(Tick(100.05m, 1150, 100.00m, 100.05m) with { ExchangeTimestamp = T0.AddMinutes(-20) }, T0.AddSeconds(30));

        Assert.Equal(T0, OnlyBar(engine).Time);
    }

    [Fact]
    public void EveryCandidateRule_IsTalliedOnItsOwn_CandleByCandle_AndKeptWithTheDay()
    {
        var engine = NewEngine();
        engine.OnTick(Tick(100.05m, 1000, 100.00m, 100.05m), T0);
        // A seller at the 100.00 bid, the new book first. The bars' rule: a sell. The depth sockets' and the trade's own
        // packet's quotes: at the ask, a buy. The tick rule: down, a sell.
        engine.OnDepth(new DepthSidePacket(35001, 2, true, new[] { new DepthLevel(99.95m, 750, 5) }, 200), T0.AddMilliseconds(300));
        engine.OnDepth(new DepthSidePacket(35001, 2, false, new[] { new DepthLevel(100.00m, 750, 5) }, 200), T0.AddMilliseconds(300));
        engine.OnTick(Tick(100.00m, 1150, 99.95m, 100.00m), T0.AddMilliseconds(400));
        // The next minute, the same candle at 3 minutes: a buyer at the offer, every rule agrees.
        var next = T0.AddMinutes(1);
        engine.OnTick(Tick(100.00m, 1300, 99.95m, 100.00m), next);

        var row = Assert.Single(engine.DeltaRules(3));
        Assert.Equal(T0, row.Time);
        Assert.Equal((300L, 0L), (row.Volume, row.Delta));                                 // -150, +150
        Assert.Equal((300L, 300L), (row.DepthBook, row.OwnPacket));                        // +150, +150
        Assert.Equal(-300L, row.TickRule);                                                 // down, then unchanged: the same side
        Assert.Equal(2, engine.DeltaRules(1).Count);

        // Through the day's copy (a deploy, a past day's replay).
        var restored = OrderFlowEngine.FromDay(engine.ExportDay()!);
        Assert.Equal(engine.DeltaRules(3), restored.DeltaRules(3));
    }

    [Fact]
    public void ADaySavedBeforeTheRulesWereKept_ShowsNoComparison_NotZero()
    {
        var engine = NewEngine();
        engine.OnTick(Tick(100.00m, 1000, 100.00m, 100.05m), T0);
        engine.OnTick(Tick(100.05m, 1150, 100.00m, 100.05m), T0.AddMilliseconds(100));
        var day = engine.ExportDay()!;
        var old = new OrderFlowDay
        {
            Underlying = day.Underlying, SecurityId = day.SecurityId, ContractSymbol = day.ContractSymbol, ExchangeSegment = day.ExchangeSegment,
            TickSize = day.TickSize, LotSize = day.LotSize, Day = day.Day, Bars = day.Bars.Select(b => b with { Rules = null }).ToList(),
        };

        var row = Assert.Single(OrderFlowEngine.FromDay(old).DeltaRules(3));
        Assert.Equal(150, row.Delta);
        Assert.Null(row.TickRule);
    }

    [Fact]
    public void TheFirstTickAfterAReconnect_IsNotBookedAsOneGiantPrint()
    {
        var engine = NewEngine();
        engine.OnTick(Tick(100.00m, 10_000, 99.95m, 100.00m, session: 1), T0);
        engine.OnTick(Tick(100.00m, 10_150, 99.95m, 100.00m, session: 1), T0.AddSeconds(1));          // 150 traded
        // The feed was away for a minute: the new connection's first tick carries everything traded meanwhile.
        engine.OnTick(Tick(101.00m, 60_150, 100.95m, 101.00m, session: 2), T0.AddSeconds(61));
        engine.OnTick(Tick(101.00m, 60_225, 100.95m, 101.00m, session: 2), T0.AddSeconds(62));        // 75 traded

        var snapshot = engine.Snapshot(0, 1, 10);
        Assert.Equal(225, snapshot.Bars.Sum(b => b.Buy + b.Sell));
        Assert.DoesNotContain(snapshot.Trades, t => t.Quantity > 150);
        Assert.Equal(50_000, snapshot.Meta.UnbookedVolume);
        Assert.Equal(50_000, engine.ExportDay()!.UnbookedVolume);
        // A tick on the SAME connection after a quiet spell is booked as usual (a quiet market is not a gap).
        engine.OnTick(Tick(101.00m, 60_300, 100.95m, 101.00m, session: 2), T0.AddMinutes(5));
        Assert.Equal(300, engine.Snapshot(0, 1, 10).Bars.Sum(b => b.Buy + b.Sell));
    }

    [Fact]
    public void APacketALittleBehindTheLast_DoesNotCountItsStepTwice()
    {
        var engine = NewEngine();
        engine.OnTick(Tick(100m, 1000, 99.95m, 100m), T0);
        engine.OnTick(Tick(100m, 1100, 99.95m, 100m), T0.AddSeconds(1));   // 100
        engine.OnTick(Tick(100m, 1090, 99.95m, 100m), T0.AddSeconds(2));   // out of order: 10 behind - ignored
        engine.OnTick(Tick(100m, 1120, 99.95m, 100m), T0.AddSeconds(3));   // 20 more, not 30
        var bar = OnlyBar(engine);
        Assert.Equal(120, bar.Buy + bar.Sell);
    }

    [Fact]
    public void VolumeOutsideTheSession_OnlyMovesTheBaseline()
    {
        var engine = NewEngine();
        var preOpen = new DateTimeOffset(2026, 10, 5, 9, 0, 0, TimeSpan.FromHours(5.5));
        engine.OnTick(Tick(100m, 0, 99.95m, 100m), preOpen);
        engine.OnTick(Tick(100m, 40_000, 99.95m, 100m), preOpen.AddMinutes(8));   // a pre-open match: no aggressor
        engine.OnTick(Tick(100m, 40_150, 99.95m, 100m), preOpen.AddMinutes(15).AddSeconds(5));
        var bar = OnlyBar(engine);
        Assert.Equal(150, bar.Buy + bar.Sell);
        Assert.Equal(new DateTimeOffset(2026, 10, 5, 9, 15, 0, TimeSpan.FromHours(5.5)), bar.Time);
        // A special Saturday session (Budget day) is booked like any other: ticks only come when there is a session.
        var saturday = NewEngine();
        var budgetDay = new DateTimeOffset(2026, 10, 3, 10, 0, 0, TimeSpan.FromHours(5.5));
        saturday.OnTick(Tick(100m, 1000, 99.95m, 100m), budgetDay);
        saturday.OnTick(Tick(100m, 1075, 99.95m, 100m), budgetDay.AddSeconds(1));
        Assert.Equal(75, OnlyBar(saturday).Buy + OnlyBar(saturday).Sell);
    }

    [Fact]
    public void AFullDaysSnapshot_IsTheSameBuiltOutsideTheLock_AndItsRowsAddUp()
    {
        var engine = NewEngine();
        long volume = 1000;
        engine.OnTick(Tick(100m, volume, 99.95m, 100m), T0);
        var price = 100m;
        for (var i = 1; i <= 600; i++)
        {
            price += i % 7 == 0 ? 0.05m : i % 5 == 0 ? -0.05m : 0;
            volume += 75 * (1 + i % 3);
            engine.OnTick(Tick(price, volume, price - 0.05m, price), T0.AddSeconds(i));
        }
        var native = engine.Snapshot(0, 1, 100);
        var rows = engine.Snapshot(1, 1, 100);
        Assert.Equal(native.Bars.Count, rows.Bars.Count);
        for (var b = 0; b < native.Bars.Count; b++)
        {
            Assert.Equal(native.Bars[b].Buy, rows.Bars[b].Buy);
            Assert.Equal(native.Bars[b].Buy, rows.Bars[b].Levels.Sum(l => l.Buy));
            Assert.Equal(native.Bars[b].Sell, rows.Bars[b].Levels.Sum(l => l.Sell));
            Assert.True(rows.Bars[b].Levels.Zip(rows.Bars[b].Levels.Skip(1)).All(p => p.First.Price > p.Second.Price), "rows high to low, one each");
        }
        Assert.Equal(volume - 1000, native.Bars.Sum(b => b.Buy + b.Sell));
        // A trade into the forming bar after a snapshot shows in the next one (its frozen levels are dropped).
        engine.OnTick(Tick(price, volume + 75, price - 0.05m, price), T0.AddSeconds(601));
        Assert.Equal(volume + 75 - 1000, engine.Snapshot(0, 1, 100).Bars.Sum(b => b.Buy + b.Sell));
    }

    [Fact]
    public void TheService_AppliesTicksAndDepthFromOneInbox_InArrivalOrder_AndTheDepthSocketOnlyEnqueues()
    {
        var service = CreateService();
        var engine = NewEngine();
        service.TrackForTests(engine);

        service.OnTick(Tick(100.00m, 1000, 99.95m, 100.00m, receivedAt: T0));
        service.OnDepth(new DepthSidePacket(35001, 2, true, new[] { new DepthLevel(100.00m, 750, 5) }, 20));
        // Nothing reaches the engine on the caller's thread (a socket's receive loop) - only the inbox's worker applies it.
        Assert.Null(engine.ExportDayDate());
        service.DrainInbox();
        Assert.NotNull(engine.ExportDayDate());
        Assert.Equal(2, service.InboxStats().Processed);
        Assert.Equal("Order flow", service.InboxStats().Name);
    }

    [Fact]
    public void TheFeedHealth_ListsTheOrderFlowInboxAfterTheMarketFeedsConsumers()
    {
        var consumers = new[] { new TickConsumerStats("Spot", 0, 10, 0, 0.1, 0.2) };
        var orderFlow = new TickConsumerStats("Order flow", 3, 99, 0, 0.3, 1.5);
        Assert.Equal(new[] { "Spot", "Order flow" }, SystemController.FeedStats(consumers, orderFlow).Select(c => c.Name));
        Assert.Equal(new[] { "Spot" }, SystemController.FeedStats(consumers, null).Select(c => c.Name));
    }

    [Fact]
    public void AGenericLiveQueue_StartsItsWorkerOnce()
    {
        var seen = 0;
        using var queue = new LiveEventQueue<int>("ints", _ => Interlocked.Increment(ref seen), NullLogger.Instance, capacity: 10, startWorker: false);
        for (var i = 0; i < 3; i++) queue.Enqueue(i);
        Assert.Equal(0, Volatile.Read(ref seen));
        queue.Start();
        queue.Start();
        for (var waited = 0; Volatile.Read(ref seen) < 3 && waited < 5_000; waited += 10) Thread.Sleep(10);
        Assert.Equal(3, Volatile.Read(ref seen));
    }

    [Fact]
    public void TheDeltaPush_CarriesTheLatestMinutesBuyAndSell_ToItsGroupOnly()
    {
        var batcher = new LiveBroadcastBatcher(null, NullLogger<LiveBroadcastBatcher>.Instance);
        var service = CreateService(batcher);
        var engine = NewEngine();
        service.TrackForTests(engine);
        batcher.Join("oi-replay-page", OrderFlowService.DeltaGroup("NIFTY"));
        service.OnTick(Tick(100.00m, 1000, 99.95m, 100.00m, receivedAt: T0));
        service.OnTick(Tick(100.00m, 1150, 99.95m, 100.00m, receivedAt: T0.AddSeconds(1)));     // 150 bought at the offer
        service.OnTick(Tick(99.95m, 1225, 99.95m, 100.00m, receivedAt: T0.AddSeconds(61)));    // the next minute: 75 sold at the bid
        service.DrainInbox();

        var (connection, batch) = Assert.Single(batcher.Flush(T0.AddSeconds(62)));
        Assert.Equal("oi-replay-page", connection);
        var item = Assert.Single(batch.Items);   // only the delta - the page is in no full order flow group
        Assert.Equal("orderFlowDelta", item.E);
        var delta = Assert.IsType<OrderFlowDeltaLive>(item.D);
        Assert.Equal(new[] { (150L, 0L), (0L, 75L) }, delta.Minutes.Select(m => (m.Buy, m.Sell)));
        Assert.Equal((new DateOnly(2026, 10, 5), 35001u), (delta.Day!.Value, delta.SecurityId));
        Assert.Equal("ofd:NIFTY", OrderFlowService.DeltaGroup("nifty"));
    }

    [Fact]
    public void AnEstimatedMinutesBuySellSplit_UsesNothingAfterIt()
    {
        static OptionAnalytics.Server.Models.CandleWithVolume Candle(int minute, decimal close, decimal previous, long volume) =>
            new(T0.AddMinutes(minute), previous, Math.Max(previous, close) + 0.5m, Math.Min(previous, close) - 0.5m, close, volume);
        // A quiet morning, then a wild afternoon.
        var closes = Enumerable.Range(0, 60).Select(i => 100m + (i % 4 == 0 ? 1.5m : i % 3 == 0 ? -1m : 0.4m) * (i < 30 ? 1 : 6)).ToList();
        var candles = closes.Select((c, i) => Candle(i, c, i == 0 ? 100m : closes[i - 1], 3000)).ToList();
        OrderFlowSnapshot Build(int minutes) => OrderFlowEstimator.Build("NIFTY", 35001, "NIFTY-FUT", "NSE_FNO", 0.05m, 75, null, new DateOnly(2026, 10, 5), candles.Take(minutes).ToList(), 1m, 75);
        var morning = Build(30);
        var wholeDay = Build(60);
        // The morning's split is the same whether or not the afternoon is in the day - it used to divide by the whole day's
        // typical move, so the afternoon's volatility changed the morning's delta (look-ahead, and a live day's estimated
        // morning shifted at every load).
        Assert.Equal(morning.Bars.Select(b => (b.Buy, b.Sell)), wholeDay.Bars.Take(30).Select(b => (b.Buy, b.Sell)));
        // Each minute's typical move is the root mean square of the changes up to it; a tick while there has been none.
        var sigmas = OrderFlowEstimator.TypicalChanges(new[] { 0.0, 2.0, -1.0 }, 0.05);
        Assert.Equal(0.05, sigmas[0]);
        Assert.Equal(Math.Sqrt(2.0), sigmas[1], 9);          // (0 + 4) / 2
        Assert.Equal(Math.Sqrt(5.0 / 3), sigmas[2], 9);      // (0 + 4 + 1) / 3
    }

    private static OrderFlowService CreateService(LiveBroadcastBatcher? batcher = null)
    {
        var options = Options.Create(new DhanOptions { RestBaseUrl = "https://dhan.test", ClientId = "c" });
        var session = new DhanSession(options);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["OrderFlow:DepthMode"] = "20" }).Build();
        return new OrderFlowService(
            new DhanFuturesInstrumentMaster(new HttpClient(), options, NullLogger<DhanFuturesInstrumentMaster>.Instance),
            new DhanMarketFeedClient(options, session, NullLogger<DhanMarketFeedClient>.Instance),
            new DhanDepthFeedClient(options, session, NullLogger<DhanDepthFeedClient>.Instance, config),
            new DhanTwoHundredDepthClient(options, session, NullLogger<DhanTwoHundredDepthClient>.Instance, config),
            batcher ?? new LiveBroadcastBatcher(null, NullLogger<LiveBroadcastBatcher>.Instance),
            new OrderFlowDayStore(), NullLogger<OrderFlowService>.Instance, config);
    }
}

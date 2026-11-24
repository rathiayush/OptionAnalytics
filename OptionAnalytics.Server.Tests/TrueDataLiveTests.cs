using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.TrueData;

namespace OptionAnalytics.Server.Tests;

/// <summary>TrueData's real-time feed (TrueData:Live) behind the Tick Flow page: the messages as the spec shows them, and a
/// trade going through the engine as a trade with its own quantity, classified against the quote before it. No network.</summary>
public sealed class TrueDataLiveTests
{
    private const string Trade = "{\"trade\":[\"100000995\",\"2020-12-16T14:02:32\",\"1472.8\",\"635\",\"1475.83\",\"680949\",\"1475.05\",\"1484\",\"1463\",\"1468.35\",\"0\",\"0\",\"1004964962.67\",\"\",\"4775\",\"1472.8\",\"429\",\"1473.3\",\"34\"]}";

    [Fact]
    public void ParsesATradeWithItsOwnQuantityBidAskAndSequence()
    {
        var f = TrueDataLiveParser.Parse(Trade);

        Assert.Equal("trade", f.Kind);
        var t = f.Trade!;
        Assert.Equal("100000995", t.SymbolId);
        Assert.Equal(1472.8m, t.Price);
        Assert.Equal(635, t.Quantity);
        Assert.Equal(680949, t.TotalVolume);
        Assert.Equal(4775, t.Sequence);
        Assert.Equal((1472.8m, 429L, 1473.3m, 34L), (t.Bid, t.BidQty, t.Ask, t.AskQty));
        Assert.Equal(new DateTimeOffset(2020, 12, 16, 14, 2, 32, TimeSpan.FromMinutes(330)), t.Time);
    }

    [Fact]
    public void ParsesABidAskTheTouchlineSymbolsAndTheOtherMessages()
    {
        var q = TrueDataLiveParser.Parse("{\"bidask\":[\"950000606\",\"2/18/2020 3:43:45 PM\",\"3698\",\"34\",\"3700\",\"54\"]}");
        Assert.Equal("bidask", q.Kind);
        Assert.Equal((3698m, 34L, 3700m, 54L), (q.Quote!.Bid, q.Quote.BidQty, q.Quote.Ask, q.Quote.AskQty));
        Assert.Equal(new DateTimeOffset(2020, 2, 18, 15, 43, 45, TimeSpan.FromMinutes(330)), q.Quote.Time);

        var s = TrueDataLiveParser.Parse("{\"success\":true,\"message\":\"symbols added\",\"symbolsadded\":2,\"symbollist\":[[\"NIFTY-I\",\"900000596\",\"2020-12-17T09:17:52\",\"13701.8\"],[\"NIFTY BANK\",\"200000004\"]],\"totalsymbolsubscribed\":2}");
        Assert.Equal("symbols", s.Kind);
        Assert.Equal(new[] { ("NIFTY-I", "900000596"), ("NIFTY BANK", "200000004") }, s.Symbols!.Select(x => (x.Name, x.SymbolId)));

        Assert.Equal("heartbeat", TrueDataLiveParser.Parse("{\"success\":true,\"message\":\"HeartBeat\",\"timestamp\":\"2026-11-24T10:00:00.000\"}").Kind);
        Assert.Equal("login", TrueDataLiveParser.Parse("{\"success\":true,\"message\":\"TrueData Real Time Data Service\",\"segments\":[\"nsefo\"],\"maxsymbols\":50,\"subscription\":\"tick\",\"validity\":\"2026-12-01T23:30:00\"}").Kind);
        var refused = TrueDataLiveParser.Parse("{\"success\":false,\"message\":\"User Already Connected\",\"segments\":null,\"maxsymbols\":0}");
        Assert.Equal("error", refused.Kind);
        Assert.Equal("User Already Connected", refused.Message);
        Assert.Equal("other", TrueDataLiveParser.Parse("not json").Kind);
        Assert.Equal("other", TrueDataLiveParser.Parse("{\"trade\":[\"1\",\"2\"]}").Kind);
    }

    private static TrueDataLiveFeed Feed()
    {
        var options = new TrueDataOptions { Enabled = true, UserId = "u", Password = "p", Live = new TrueDataLiveOptions { Enabled = true } };
        var feed = new TrueDataLiveFeed(Options.Create(options), NullLogger<TrueDataLiveFeed>.Instance);
        feed.Register(new[] { new TrueDataSymbol("NIFTY-I", "1"), new TrueDataSymbol("BANKNIFTY-I", "2") });
        return feed;
    }

    private static readonly DateTimeOffset T0 = new(2026, 11, 24, 10, 0, 0, TimeSpan.FromMinutes(330));
    private static TickBook Book() => new("NIFTY", "NIFTY-I", 65, 0.05m);

    [Fact]
    public void ATradeIsSidedByTheQuoteBeforeIt_NotTheQuoteInItsOwnPacket()
    {
        var b = Book();
        b.OnQuote(T0, 24999m, 100, 25000m, 100);
        // The packet shows the book AFTER the trade (ask moved up to 25000.5); the trade at 25000 hit the ask of the quote before it.
        b.OnTrade(T0.AddSeconds(1), 1, 25000m, 65, 25000m, 100, 25000.5m, 80);
        // Now the quote is 25000 x 25000.5: a trade at 25000 is a sell at the bid.
        b.OnTrade(T0.AddSeconds(2), 2, 25000m, 130, 25000m, 50, 25000.5m, 80);

        var bar = b.Snapshot(1, 1, 100).Bars.Single();
        Assert.Equal(65, bar.Buy);
        Assert.Equal(130, bar.Sell);
        Assert.Equal(195, bar.Buy + bar.Sell);
    }

    [Theory]
    [InlineData(25000.5, 25000.0, 25000.5, true)]    // at the ask
    [InlineData(25001.0, 25000.0, 25000.5, true)]    // through the ask
    [InlineData(25000.0, 25000.0, 25000.5, false)]   // at the bid
    [InlineData(24999.0, 25000.0, 25000.5, false)]   // through the bid
    [InlineData(25000.3, 25000.0, 25001.0, false)]   // inside, nearer the bid
    [InlineData(25000.8, 25000.0, 25001.0, true)]    // inside, nearer the ask
    public void TheSideFollowsTheQuote(double price, double bid, double ask, bool buy) =>
        Assert.Equal(buy, TickBook.Side((decimal)price, (decimal)bid, (decimal)ask, 0, !buy));

    [Fact]
    public void AtTheMiddleOrWithNoQuoteTheTickRuleThenTheLastSideDecide()
    {
        Assert.True(TickBook.Side(25000.5m, 25000m, 25001m, 25000m, false));   // middle, up from the last trade
        Assert.False(TickBook.Side(25000.5m, 25000m, 25001m, 25001m, true));   // middle, down
        Assert.False(TickBook.Side(25000.5m, 25000m, 25001m, 25000.5m, false)); // middle, unchanged: the last side
        Assert.True(TickBook.Side(100m, 0, 0, 99m, false));                    // no quote: up-tick
        Assert.False(TickBook.Side(100m, 101m, 100m, 101m, true));             // crossed quote never decides: down-tick
    }

    [Fact]
    public void PrintsAtOnePriceAndSideWithinASecondAreOneBubble_AndABigOrderIsABigBubble()
    {
        var b = Book();
        b.OnQuote(T0, 24999m, 100, 25000m, 100);
        b.OnTrade(T0, 1, 25000m, 65, 24999m, 100, 25000m, 100);
        b.OnTrade(T0, 2, 25000m, 65, 24999m, 100, 25000m, 100);                       // same price, side, second: one bubble
        b.OnTrade(T0.AddSeconds(5), 3, 25000m, 65 * 40, 24999m, 100, 25000m, 100);    // later: its own, and big
        b.OnTrade(T0.AddSeconds(6), 4, 24999m, 65, 24999m, 100, 25000m, 100);         // a sell

        var all = b.Snapshot(1, 1, 100).Bubbles;
        Assert.Equal(new long[] { 130, 2600, 65 }, all.Select(x => x.Qty));
        Assert.Equal(new[] { 2, 1, 1 }, all.Select(x => x.Prints));
        Assert.Equal(new[] { true, true, false }, all.Select(x => x.Buy));
        Assert.Single(b.Snapshot(1, 65 * 10, 100).Bubbles);   // only the big one passes a 10-lot minimum
    }

    [Fact]
    public void TheFootprintGroupsPricesIntoRowsHighToLow_AndMinutesStayApart()
    {
        var b = Book();
        b.OnQuote(T0, 24999.95m, 100, 25000m, 100);
        b.OnTrade(T0, 1, 25000m, 10, 24999.95m, 100, 25000m, 100);                              // buy at 25000.00
        b.OnTrade(T0.AddSeconds(1), 2, 25000.4m, 5, 24999.95m, 100, 25000m, 100);                // through the ask: buy
        b.OnTrade(T0.AddSeconds(2), 3, 24999.95m, 7, 24999.95m, 100, 25000m, 100);              // at the bid: sell, row 24999
        b.OnTrade(T0.AddMinutes(1), 4, 25000m, 3, 24999.95m, 100, 25000m, 100);                 // the next minute

        var day = b.Snapshot(1, 1, 100);
        Assert.Equal(2, day.Bars.Count);
        var first = day.Bars[0];
        Assert.Equal(new decimal[] { 25000m, 24999m }, first.Levels.Select(l => l.Price));
        Assert.Equal((15L, 0L), (first.Levels[0].Buy, first.Levels[0].Sell));
        Assert.Equal((0L, 7L), (first.Levels[1].Buy, first.Levels[1].Sell));
        Assert.Equal((25000m, 25000.4m, 24999.95m, 24999.95m), (first.Open, first.High, first.Low, first.Close));
    }

    [Fact]
    public void LostTicksAreCounted_ANewDayStartsEmpty_AndQuotesBuildTheTrail()
    {
        var b = Book();
        b.OnTrade(T0, 10, 25000m, 5, 24999m, 1, 25000m, 1);
        b.OnTrade(T0.AddSeconds(1), 13, 25000m, 5, 24999m, 1, 25000m, 1);   // 11 and 12 never arrived
        Assert.Equal(2, b.Meta().SequenceGaps);
        b.OnQuote(T0.AddSeconds(3), 24999.5m, 5, 25000m, 5);
        Assert.True(b.Snapshot(1, 1, 100).Quotes.Count >= 2);

        b.OnTrade(T0.AddDays(1), 1, 25100m, 5, 25099m, 1, 25100m, 1);
        var meta = b.Meta();
        Assert.Equal((1L, 0L), (meta.Prints, meta.SequenceGaps));
        Assert.Single(b.Snapshot(1, 1, 100).Bars);
    }

    [Fact]
    public void TheFeedRoutesATradeToItsIndexByTheIdTheSubscribeReplyGave_AndIgnoresOthers()
    {
        var feed = Feed();
        feed.Clock = () => T0;
        feed.OnTrade(new TrueDataTrade("2", T0, 52000m, 30, 52000m, 100, 52000m, 52000m, 52000m, 52000m, 0, "", 7, 51999m, 10, 52000m, 10));
        feed.OnTrade(new TrueDataTrade("999", T0, 1m, 30, 1m, 100, 1m, 1m, 1m, 1m, 0, "", 7, 1m, 10, 2m, 10));
        feed.OnQuote(new TrueDataQuote("2", null, 51999m, 10, 52000m, 10));

        var streams = feed.Snapshot().Streams;
        Assert.Equal(1, streams.Single(x => x.Underlying == "BANKNIFTY").Trades);
        Assert.Equal(1, streams.Single(x => x.Underlying == "BANKNIFTY").Quotes);
        Assert.Equal(0, streams.Single(x => x.Underlying == "NIFTY").Trades);
    }

    [Theory]
    [InlineData(2026, 11, 24, 8, 29, false)]
    [InlineData(2026, 11, 24, 8, 30, true)]
    [InlineData(2026, 11, 24, 15, 45, true)]
    [InlineData(2026, 11, 24, 15, 46, false)]
    [InlineData(2026, 11, 28, 10, 0, false)] // a Saturday
    public void ItConnectsOnlyInTheSessionWindow(int y, int mo, int d, int h, int mi, bool expected) =>
        Assert.Equal(expected, TrueDataLiveFeed.InWindow(new DateTimeOffset(y, mo, d, h, mi, 0, TimeSpan.FromMinutes(330))));

    private static readonly TrueDataLiveInstrument Nifty = new() { Underlying = "NIFTY", Symbol = "NIFTY-I", LotSize = 65, TickSize = 0.05m };
    private static TrueDataTick Tick(int sec, decimal ltp, long volume, decimal bid, decimal ask) => new(T0.AddSeconds(sec), ltp, volume, 0, bid, 100, ask, 100);

    [Fact]
    public void AReplayedDayFromARunningTotalBooksTheRiseAsTheTradeAndTheFirstTickIsOnlyTheBaseline()
    {
        var book = TickHistoryDays.Build(Nifty, new[]
        {
            Tick(0, 25000m, 5_000, 24999.95m, 25000m),   // baseline: the volume before it is not a trade
            Tick(1, 25000m, 5_065, 24999.95m, 25000m),   // +65 at the ask: a buy
            Tick(2, 24999.95m, 5_065, 24999.95m, 25000m), // no volume: a quote
            Tick(3, 24999.95m, 5_195, 24999.95m, 25000m), // +130 at the bid: a sell
        }, volumeWasPerTick: false);

        var day = book.Snapshot(1, 1, 100);
        Assert.Equal(65, day.Bars.Single().Buy);
        Assert.Equal(130, day.Bars.Single().Sell);
        Assert.Equal(2, day.Meta.Prints);
        Assert.Equal(195, day.Meta.BookedVolume);
        Assert.Equal(195, day.Meta.ExchangeVolume);   // every trade of the day's running volume is in the footprint: 100% coverage
    }

    [Fact]
    public void AReplayedDayFromPerTickVolumesCountsTheFirstTickToo()
    {
        var book = TickHistoryDays.Build(Nifty, new[] { Tick(0, 25000m, 65, 24999.95m, 25000m), Tick(1, 24999.95m, 130, 24999.95m, 25000m) }, volumeWasPerTick: true);
        // TrueDataTickCsv has already made the per-tick column a running total (65, then 130): the first tick is a trade of 65, the next of 65.
        Assert.Equal((65L, 65L), (book.Snapshot(1, 1, 100).Bars.Single().Buy, book.Snapshot(1, 1, 100).Bars.Single().Sell));
    }

    [Fact]
    public void CoverageComparesWhatWasBookedWithTheExchangesRunningVolume_SoALostTradeShowsAsAShortfall()
    {
        var b = Book();
        b.OnTrade(T0, 1, 25000m, 65, 24999m, 1, 25000m, 1, totalVolume: 1_000);
        b.OnTrade(T0.AddSeconds(1), 2, 25000m, 65, 24999m, 1, 25000m, 1, totalVolume: 1_065);
        b.OnTrade(T0.AddSeconds(2), 4, 25000m, 65, 24999m, 1, 25000m, 1, totalVolume: 1_195); // a 65-lot trade (seq 3) never arrived
        var m = b.Meta();
        Assert.Equal(195, m.BookedVolume);
        Assert.Equal(260, m.ExchangeVolume);
    }
}

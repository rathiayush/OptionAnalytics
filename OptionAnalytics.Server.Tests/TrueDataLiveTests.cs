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

    private static TrueDataTrade T(string id, int sec, decimal price, long qty, long total, long seq, decimal bid, decimal ask) =>
        new(id, new DateTimeOffset(2026, 11, 24, 10, 0, sec, TimeSpan.FromMinutes(330)), price, qty, price, total, price, price, price, price, 0, "", seq, bid, 100, ask, 100);

    private static readonly DateTimeOffset Session = new(2026, 11, 24, 10, 0, 0, TimeSpan.FromMinutes(330));

    [Fact]
    public void ATradeIsBookedWithItsOwnQuantityAndTheSideTheQuoteBeforeItGives_AndSequenceGapsAreCounted()
    {
        var feed = Feed();
        var at = Session;
        feed.Clock = () => at;
        // A quote before any trade is held back (no volume baseline yet); the first TRADE only sets the baseline.
        feed.OnQuote(new TrueDataQuote("1", null, 24999m, 100, 25000m, 100), 1);
        feed.OnTrade(T("1", 0, 25000m, 50, 1000, 10, 24999m, 25000m), 1);
        at = Session.AddSeconds(1);
        feed.OnQuote(new TrueDataQuote("1", null, 25000m, 150, 25000.5m, 75), 1);
        at = Session.AddSeconds(2);
        feed.OnTrade(T("1", 2, 25000.5m, 75, 1075, 11, 25000m, 25000.5m), 1);   // at the ask: a buy of exactly 75
        at = Session.AddSeconds(3);
        feed.OnTrade(T("1", 3, 25000m, 150, 1225, 14, 25000m, 25000.5m), 1);    // at the bid: a sell of exactly 150; 12 and 13 never arrived

        var nifty = feed.Snapshot().Streams.Single(s => s.Underlying == "NIFTY");
        Assert.Equal(3, nifty.Trades);
        Assert.Equal(2, nifty.Quotes); // both received, the first held back from the engine
        Assert.Equal(2, nifty.SequenceGaps);
        Assert.Equal(1225, feed.EngineFor("NIFTY")!.LastKnownVolume);

        var bar = feed.EngineFor("NIFTY")!.Snapshot(0.05m, 1, 50).Bars.Single();
        Assert.Equal(75, bar.Buy);
        Assert.Equal(150, bar.Sell);
        Assert.Equal(0, feed.Snapshot().Streams.Single(s => s.Underlying == "BANKNIFTY").Trades);
    }

    [Fact]
    public void ATradeForASymbolNobodyAskedForIsIgnored()
    {
        var feed = Feed();
        feed.OnTrade(T("999", 1, 100m, 5, 5, 1, 99m, 101m), 1);
        Assert.All(feed.Snapshot().Streams, s => Assert.Equal(0, s.Trades));
    }

    [Theory]
    [InlineData(2026, 11, 24, 8, 29, false)]
    [InlineData(2026, 11, 24, 8, 30, true)]
    [InlineData(2026, 11, 24, 15, 45, true)]
    [InlineData(2026, 11, 24, 15, 46, false)]
    [InlineData(2026, 11, 28, 10, 0, false)] // a Saturday
    public void ItConnectsOnlyInTheSessionWindow(int y, int mo, int d, int h, int mi, bool expected) =>
        Assert.Equal(expected, TrueDataLiveFeed.InWindow(new DateTimeOffset(y, mo, d, h, mi, 0, TimeSpan.FromMinutes(330))));
}

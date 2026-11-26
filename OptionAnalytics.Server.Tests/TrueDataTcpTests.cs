using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.TrueData;

namespace OptionAnalytics.Server.Tests;

/// <summary>TrueData's TCP stream (TCP API v2.3): the 87-byte TR trade packet, the 27-byte BA quote, text and JSON mixed in with them,
/// byte order, the time, damaged bytes - and the feed running over a real loopback socket with a fake TrueData behind it. No network.</summary>
public sealed class TrueDataTcpTests
{
    private static readonly TimeSpan Ist = TimeSpan.FromMinutes(330);
    private static readonly DateTimeOffset Now = new(2026, 11, 20, 10, 0, 5, Ist);
    // TrueData's time integer: the IST wall clock written as a Unix time.
    private static uint Epoch(DateTimeOffset istTime) => (uint)new DateTimeOffset(istTime.DateTime, TimeSpan.Zero).ToUnixTimeSeconds();

    private static byte[] TradePacket(uint id, DateTimeOffset time, uint seq, float ltp, uint ltq, uint ttq, float bid, uint bidQty, float ask, uint askQty, bool big = false)
    {
        var p = new byte[87];
        p[0] = (byte)'T'; p[1] = (byte)'R';
        void U(int at, uint v) { if (big) BinaryPrimitives.WriteUInt32BigEndian(p.AsSpan(at), v); else BinaryPrimitives.WriteUInt32LittleEndian(p.AsSpan(at), v); }
        void F(int at, float v) { if (big) BinaryPrimitives.WriteSingleBigEndian(p.AsSpan(at), v); else BinaryPrimitives.WriteSingleLittleEndian(p.AsSpan(at), v); }
        U(2, id); U(6, Epoch(time)); U(10, seq); F(14, ltp); U(18, ltq); F(22, ltp); U(26, ttq);
        F(30, 25000f); F(34, 25100f); F(38, 24900f); F(42, 24950f);
        BinaryPrimitives.WriteInt64LittleEndian(p.AsSpan(46), 123456789);
        F(70, bid); U(74, bidQty); F(78, ask); U(82, askQty);
        p[86] = (byte)'Z';
        return p;
    }

    private static byte[] QuotePacket(uint id, DateTimeOffset time, float bid, uint bidQty, float ask, uint askQty)
    {
        var p = new byte[27];
        p[0] = (byte)'B'; p[1] = (byte)'A';
        BinaryPrimitives.WriteUInt32LittleEndian(p.AsSpan(2), id);
        BinaryPrimitives.WriteUInt32LittleEndian(p.AsSpan(6), Epoch(time));
        BinaryPrimitives.WriteSingleLittleEndian(p.AsSpan(10), bid);
        BinaryPrimitives.WriteUInt32LittleEndian(p.AsSpan(14), bidQty);
        BinaryPrimitives.WriteSingleLittleEndian(p.AsSpan(18), ask);
        BinaryPrimitives.WriteUInt32LittleEndian(p.AsSpan(22), askQty);
        p[26] = (byte)'Z';
        return p;
    }

    private static TrueDataTcpParser Parser() => new() { Clock = () => Now };

    [Fact]
    public void ATradePacketGivesTheLastTicksOwnVolumeTheSequenceAndTheBestBidAsk()
    {
        var f = Parser().Feed(TradePacket(100001262, Now.AddSeconds(-3), 12456, 25000.05f, 195, 55256, 25000f, 45, 25000.05f, 65)).Single();

        Assert.Equal("trade", f.Kind);
        var t = f.Trade!;
        Assert.Equal("100001262", t.SymbolId);
        Assert.Equal(25000.05m, t.Price);          // a float32 comes out as the price it was sent as, not 25000.05000305...
        Assert.Equal(195, t.Quantity);
        Assert.Equal(55256, t.TotalVolume);
        Assert.Equal(12456, t.Sequence);
        Assert.Equal(123456789, t.OpenInterest);
        Assert.Equal((25000m, 45L, 25000.05m, 65L), (t.Bid, t.BidQty, t.Ask, t.AskQty));
        Assert.Equal(Now.AddSeconds(-3), t.Time);
        Assert.Equal((25000m, 25100m, 24900m, 24950m), (t.Open, t.High, t.Low, t.PrevClose));
    }

    [Fact]
    public void AQuotePacketIsABidAsk()
    {
        var q = Parser().Feed(QuotePacket(100001262, Now, 24999.95f, 120, 25000.05f, 80)).Single().Quote!;
        Assert.Equal((24999.95m, 120L, 25000.05m, 80L), (q.Bid, q.BidQty, q.Ask, q.AskQty));
    }

    [Fact]
    public void PacketsSplitAnywhereAcrossReadsComeOutWhole_AndSeveralInOneRead()
    {
        var bytes = TradePacket(1, Now, 1, 100f, 10, 10, 99.95f, 1, 100.05f, 1)
            .Concat(QuotePacket(1, Now, 99.9f, 2, 100.1f, 2)).Concat(TradePacket(1, Now, 2, 100.05f, 20, 30, 99.95f, 1, 100.05f, 1)).ToArray();
        for (var cut = 1; cut < bytes.Length; cut += 13)
        {
            var p = Parser();
            var frames = p.Feed(bytes.AsSpan(0, cut)).Concat(p.Feed(bytes.AsSpan(cut))).ToList();
            Assert.Equal(new[] { "trade", "bidask", "trade" }, frames.Select(f => f.Kind));
            Assert.Equal(0, p.Skipped);
        }
    }

    [Fact]
    public void TextAndJsonLinesAreMixedInWithThePackets()
    {
        var p = Parser();
        var text = Encoding.UTF8.GetBytes("Truedata TCP RT Service\r\nTrueData Real Time Data Service:800:NSE,FO,MCX:12/31/2027 12:00:00 AM\r\n"
            + "{\"success\":true,\"message\":\"symbols added\",\"symbollist\":[[\"NIFTY26NOVFUT\",\"900000596\",\"2026-11-20T09:17:52\",\"24500\"]]}\r\n");
        var frames = p.Feed(text).Concat(p.Feed(TradePacket(900000596, Now, 1, 24500f, 65, 65, 24499.95f, 1, 24500f, 1))).ToList();

        Assert.Equal(new[] { "other", "login", "symbols", "trade" }, frames.Select(f => f.Kind));
        Assert.Equal("900000596", frames[2].Symbols!.Single().SymbolId);
        Assert.Equal(0, p.Skipped);
    }

    [Fact]
    public void ALoginAnswerWithNoLineEndIsTakenOnFlush_AndARefusalInWordsIsAnError()
    {
        var p = Parser();
        Assert.Empty(p.Feed(Encoding.UTF8.GetBytes("TrueData Real Time Data Service:800:NSE,FO,MCX:12/31/2027")));
        Assert.True(p.HasPendingText);
        Assert.Equal("login", p.FlushText().Single().Kind);

        var refusal = Parser().Feed(Encoding.UTF8.GetBytes("User Already Connected\r\n")).Single();
        Assert.Equal("error", refusal.Kind);
        Assert.False(refusal.Success);
    }

    [Fact]
    public void MarketMessagesAreStatusAndTheFiveLevelBookIsSkipped()
    {
        var market = new byte[42]; market[0] = (byte)'F'; market[1] = (byte)'O'; market[41] = (byte)'Z';
        var level2 = new byte[139]; level2[0] = (byte)'L'; level2[1] = (byte)'2'; level2[138] = (byte)'Z';
        var frames = Parser().Feed(market.Concat(level2).Concat(QuotePacket(1, Now, 1f, 1, 2f, 1)).ToArray());
        Assert.Equal(new[] { "status", "bidask" }, frames.Select(f => f.Kind));
        Assert.Equal("FO", frames[0].Message);
    }

    [Fact]
    public void ABigEndianStreamIsRecognisedFromItsFirstPacket()
    {
        var p = Parser();
        var t = p.Feed(TradePacket(7, Now, 9, 24500.5f, 130, 1000, 24500f, 5, 24500.5f, 6, big: true)).Single().Trade!;
        Assert.Equal("big", p.ByteOrder);
        Assert.Equal((24500.5m, 130L, 9L), (t.Price, t.Quantity, t.Sequence));
        Assert.Equal(Now, t.Time);
    }

    [Fact]
    public void ATimeThatIsRealUtcIsConvertedToIst()
    {
        var p = Parser();
        // Real UTC written as the time: read as an IST wall clock it would be 5.5 h behind now.
        var utcEpoch = (uint)Now.ToUnixTimeSeconds();
        var wall = DateTime.SpecifyKind(DateTime.UnixEpoch.AddSeconds(utcEpoch), DateTimeKind.Unspecified);
        Assert.Equal(Now, p.ToTime(utcEpoch));
        // The IST wall clock as an epoch (TrueData's way) is the IST time as it is.
        Assert.Equal(Now, p.ToTime(Epoch(Now)));
        Assert.True(wall < Now.DateTime);
    }

    [Fact]
    public void DamagedBytesAreSkippedAndCounted_NeverThrown()
    {
        var p = Parser();
        var good = TradePacket(1, Now, 1, 100f, 10, 10, 99.95f, 1, 100.05f, 1);
        var junk = new byte[] { 0x01, 0xFF, 0x7F };
        var broken = TradePacket(1, Now, 2, 100f, 10, 20, 99.95f, 1, 100.05f, 1); broken[86] = (byte)'X';   // a TR with no footer
        var frames = p.Feed(junk.Concat(broken).Concat(good).ToArray());

        Assert.Equal(1, frames.Count(f => f.Kind == "trade"));
        Assert.True(p.Skipped > 0);
    }

    // ---- the feed over a loopback socket, a fake TrueData behind it ----

    private static TrueDataLiveFeed Feed(int port)
    {
        var options = Options.Create(new TrueDataOptions
        {
            Enabled = true, UserId = "u", Password = "p",
            Live = new TrueDataLiveOptions
            {
                Enabled = true, Transport = "tcp", TcpHost = "127.0.0.1", TcpPort = port,
                Instruments = new() { new() { Underlying = "NIFTY", Symbol = "NIFTY26NOVFUT", LotSize = 65, TickSize = 0.05m } },
            },
        });
        return new TrueDataLiveFeed(options, NullLogger<TrueDataLiveFeed>.Instance) { Clock = () => Now };
    }

    [Fact]
    public async Task TheFeedLogsInSubscribesAndBooksTheTradesFromTheTcpStream()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        string? login = null, subscribe = null;
        var server = Task.Run(async () =>
        {
            using var c = await listener.AcceptTcpClientAsync();
            var s = c.GetStream();
            await s.WriteAsync(Encoding.UTF8.GetBytes("Truedata TCP RT Service\r\n"));
            var buf = new byte[1024];
            login = Encoding.UTF8.GetString(buf, 0, await s.ReadAsync(buf));
            await s.WriteAsync(Encoding.UTF8.GetBytes("TrueData Real Time Data Service:50:NSE,FO:12/31/2027 12:00:00 AM"));   // no line end
            subscribe = Encoding.UTF8.GetString(buf, 0, await s.ReadAsync(buf));
            await s.WriteAsync(Encoding.UTF8.GetBytes("{\"success\":true,\"message\":\"symbols added\",\"symbolsadded\":1,\"symbollist\":[[\"NIFTY26NOVFUT\",\"900000596\",\"2026-11-20T09:17:52\",\"24500\"]],\"totalsymbolsubscribed\":1}\r\n"));
            var quote = QuotePacket(900000596, Now, 24499.95f, 100, 24500f, 100);
            var trade = TradePacket(900000596, Now, 1, 24500f, 65, 65, 24499.95f, 100, 24500f, 100);
            var second = TradePacket(900000596, Now.AddSeconds(1), 2, 24499.95f, 130, 195, 24499.95f, 100, 24500f, 100);
            var all = quote.Concat(trade).Concat(second).ToArray();
            await s.WriteAsync(all.AsMemory(0, 40));        // a packet cut in two reads
            await Task.Delay(50);
            await s.WriteAsync(all.AsMemory(40));
            await Task.Delay(200);
        });

        var feed = Feed(port);
        using var stop = new CancellationTokenSource();
        var worker = feed.ProcessInboxAsync(stop.Token);        // the ticks are applied by the inbox's worker, not the socket's loop
        var refused = await feed.RunOnceAsync(CancellationToken.None);
        await server;
        while (feed.QueueSnapshot().Depth > 0) await Task.Delay(5);
        stop.Cancel();
        await worker;

        Assert.False(refused);
        Assert.Equal("LOGIN u p", login!.Trim());
        Assert.Contains("addsymbol", subscribe);
        Assert.Contains("NIFTY26NOVFUT", subscribe);
        var day = feed.BookFor("NIFTY")!.Snapshot(1, 1, 100);
        Assert.Equal(65, day.Bars.Single().Buy);       // at the ask
        Assert.Equal(130, day.Bars.Single().Sell);     // at the bid
        Assert.Equal(2, day.Meta.Prints);
        Assert.Equal(0, day.Meta.SequenceGaps);
        Assert.Equal(195, day.Meta.ExchangeVolume);
        Assert.Equal("streaming", feed.Snapshot().State);
    }

    [Fact]
    public async Task ARefusedTcpLoginIsReportedAsRefused()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var server = Task.Run(async () =>
        {
            using var c = await listener.AcceptTcpClientAsync();
            var s = c.GetStream();
            await s.ReadAsync(new byte[256]);
            await s.WriteAsync(Encoding.UTF8.GetBytes("User Already Connected\r\n"));
            await Task.Delay(100);
        });
        var feed = Feed(((IPEndPoint)listener.LocalEndpoint).Port);

        Assert.True(await feed.RunOnceAsync(CancellationToken.None));
        await server;
        Assert.Equal("User Already Connected", feed.Snapshot().Error);
    }

    [Fact]
    public void TheSourcePickedOnThePageIsKeptAcrossARestart_AndNothingElseIsAccepted()
    {
        var folder = Path.Combine(Path.GetTempPath(), "tick-flow-source-" + Guid.NewGuid().ToString("N"));
        try
        {
            TrueDataLiveFeed Make(string transport) => new(Options.Create(new TrueDataOptions
            {
                Enabled = true, UserId = "u", Password = "p",
                Live = new TrueDataLiveOptions { Enabled = true, Transport = transport, StatePath = folder, Instruments = new() { new() { Underlying = "NIFTY", Symbol = "NIFTY-I" } } },
            }), NullLogger<TrueDataLiveFeed>.Instance);

            var feed = Make("websocket");
            Assert.Equal("websocket", feed.Snapshot().Transport);
            Assert.False(feed.SetTransport("udp"));
            Assert.False(feed.SetTransport(null));
            Assert.Equal("websocket", feed.Transport);

            Assert.True(feed.SetTransport(" TCP "));
            Assert.Equal("tcp", feed.Snapshot().Transport);
            Assert.Contains("TCP", feed.Snapshot().Port);

            // A restart: the configured default is websocket, the page's choice is what the file kept.
            Assert.Equal("tcp", Make("websocket").Transport);
            Assert.True(feed.SetTransport("websocket"));
            Assert.Equal("websocket", Make("tcp").Transport);
        }
        finally { if (Directory.Exists(folder)) Directory.Delete(folder, true); }
    }
}

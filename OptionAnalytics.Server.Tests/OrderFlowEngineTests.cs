using System.Buffers.Binary;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services.OrderFlow;

namespace OptionAnalytics.Server.Tests;

/// <summary>Order flow: Dhan's 20-level depth packets, and OrderFlowEngine's trade inference,
/// footprint, book handling and iceberg detection.</summary>
public sealed class OrderFlowEngineTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 5, 4, 0, 0, TimeSpan.Zero); // 09:30 IST

    private static OrderFlowEngine NewEngine() => new("NIFTY", 35001, "NIFTY-Oct2026-FUT", "NSE_FNO", 0.05m, 75);

    private static SpotTick Tick(decimal price, long volume, decimal bid, decimal ask, long bidQty = 750, long askQty = 750) =>
        new(35001, price, 0, 0, 0, 0, volume, bid, ask, 0, T0)
        {
            Bids = new[] { new DepthLevel(bid, bidQty, 5), new DepthLevel(bid - 0.05m, 1500, 9) },
            Asks = new[] { new DepthLevel(ask, askQty, 5), new DepthLevel(ask + 0.05m, 1500, 9) },
        };

    // ---- 20-level depth packets -------------------------------------------------------------

    private static byte[] DepthPacket(byte code, uint securityId, Func<int, (double Price, uint Qty, uint Orders)> level)
    {
        var packet = new byte[DhanDepthPacketParser.SidePacketLength];
        BinaryPrimitives.WriteUInt16LittleEndian(packet, DhanDepthPacketParser.SidePacketLength);
        packet[2] = code;
        packet[3] = 2;
        BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(4), securityId);
        for (var i = 0; i < 20; i++)
        {
            var (price, qty, orders) = level(i);
            var at = 12 + i * 16;
            BinaryPrimitives.WriteDoubleLittleEndian(packet.AsSpan(at), price);
            BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(at + 8), qty);
            BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(at + 12), orders);
        }
        return packet;
    }

    [Fact]
    public void DepthParser_ReadsBidAndAskPacketsStackedInOneMessage()
    {
        var bid = DepthPacket(41, 35001, i => (22710.0 - i * 0.05, (uint)(100 + i), (uint)(1 + i)));
        var ask = DepthPacket(51, 35001, i => i < 18 ? (22710.05 + i * 0.05, (uint)(200 + i), 3u) : (0d, 0u, 0u));

        var packets = DhanDepthPacketParser.Parse(bid.Concat(ask).ToArray(), out var disconnect);

        Assert.Null(disconnect);
        Assert.Equal(2, packets.Count);
        Assert.True(packets[0].IsBid);
        Assert.Equal(35001u, packets[0].SecurityId);
        Assert.Equal(20, packets[0].Levels.Length);
        Assert.Equal(new DepthLevel(22710m, 100, 1), packets[0].Levels[0]);
        Assert.Equal(new DepthLevel(22709.05m, 119, 20), packets[0].Levels[19]);
        Assert.False(packets[1].IsBid);
        Assert.Equal(18, packets[1].Levels.Length); // empty levels skipped
        Assert.Equal(22710.05m, packets[1].Levels[0].Price);
    }

    [Fact]
    public void DepthParser_ReportsADisconnect()
    {
        var packet = new byte[14];
        BinaryPrimitives.WriteUInt16LittleEndian(packet, 14);
        packet[2] = 50;
        BinaryPrimitives.WriteUInt16LittleEndian(packet.AsSpan(12), 805);

        Assert.Empty(DhanDepthPacketParser.Parse(packet, out var disconnect));
        Assert.Equal(805, disconnect);
    }

    [Fact]
    public void DepthParser_StopsOnATruncatedPacket() =>
        Assert.Empty(DhanDepthPacketParser.Parse(DepthPacket(41, 1, _ => (100, 1, 1)).AsSpan(0, 200), out _));

    // ---- trade inference ----------------------------------------------------------------------

    [Theory]
    [InlineData(100.10, 100.00, 100.10, 100.05, -1, 1)]   // at the previous ask -> buyer lifted the offer
    [InlineData(100.00, 100.00, 100.10, 100.05, 1, -1)]   // at the previous bid -> seller hit the bid
    [InlineData(100.05, 100.00, 100.10, 100.00, -1, 1)]   // inside the spread, up-tick -> buy
    [InlineData(100.05, 100.00, 100.10, 100.10, 1, -1)]   // inside the spread, down-tick -> sell
    [InlineData(100.05, 100.00, 100.10, 100.05, -1, -1)]  // unchanged -> same side as the last trade
    public void ClassifiesTheAggressor(double price, double bid, double ask, double prevLtp, int lastSide, int expected) =>
        Assert.Equal(expected, OrderFlowEngine.Classify((decimal)price, (decimal)bid, (decimal)ask, (decimal)prevLtp, lastSide));

    [Fact]
    public void VolumeIncreaseBecomesFootprintVolumeOnTheAggressorSide()
    {
        var engine = NewEngine();
        engine.OnTick(Tick(22710.00m, 10_000, 22710.00m, 22710.05m), T0);                 // seeds volume
        engine.OnTick(Tick(22710.05m, 10_150, 22710.00m, 22710.10m), T0.AddSeconds(1));   // 150 at the ask -> buy
        engine.OnTick(Tick(22710.00m, 10_375, 22709.95m, 22710.05m), T0.AddSeconds(2));   // 225 at the bid -> sell
        engine.OnTick(Tick(22710.00m, 10_375, 22709.95m, 22710.05m), T0.AddSeconds(3));   // no volume -> nothing

        var snapshot = engine.Snapshot(rowSize: 0, minTradeQty: 1, heatmapColumns: 100);
        var bar = Assert.Single(snapshot.Bars);
        Assert.Equal(150, bar.Buy);
        Assert.Equal(225, bar.Sell);
        Assert.Equal(22710.05m, bar.High);
        Assert.Equal(22710.00m, bar.Close);
        Assert.Contains(bar.Levels, l => l.Price == 22710.05m && l.Buy == 150 && l.Sell == 0);
        Assert.Contains(bar.Levels, l => l.Price == 22710.00m && l.Buy == 0 && l.Sell == 225);
        Assert.Equal(new[] { true, false }, snapshot.Trades.Select(t => t.Buy));
    }

    [Fact]
    public void RowsBucketPricesAndBarsSplitByIstMinute()
    {
        var engine = NewEngine();
        engine.OnTick(Tick(22710.00m, 1000, 22710.00m, 22710.05m), T0);
        engine.OnTick(Tick(22711.40m, 1100, 22711.35m, 22711.40m), T0.AddSeconds(10));
        engine.OnTick(Tick(22711.90m, 1200, 22711.85m, 22711.90m), T0.AddSeconds(20));
        engine.OnTick(Tick(22712.05m, 1300, 22712.00m, 22712.05m), T0.AddSeconds(70));

        var snapshot = engine.Snapshot(rowSize: 1, minTradeQty: 1, heatmapColumns: 100);

        Assert.Equal(2, snapshot.Bars.Count);
        Assert.Equal(new DateTimeOffset(2026, 10, 5, 9, 30, 0, TimeSpan.FromHours(5.5)), snapshot.Bars[0].Time);
        var row = Assert.Single(snapshot.Bars[0].Levels);
        Assert.Equal(22711m, row.Price);
        Assert.Equal(200, row.Buy);
        Assert.Equal(22712m, Assert.Single(snapshot.Bars[1].Levels).Price);
    }

    [Fact]
    public void ADroppedVolumeResetsTheBaselineInsteadOfCountingANegativeTrade()
    {
        var engine = NewEngine();
        engine.OnTick(Tick(100m, 5000, 99.95m, 100m), T0);
        engine.OnTick(Tick(100m, 10, 99.95m, 100m), T0.AddSeconds(1));
        engine.OnTick(Tick(100m, 85, 99.95m, 100m), T0.AddSeconds(2));

        var bar = Assert.Single(engine.Snapshot(0, 1, 10).Bars);
        Assert.Equal(75, bar.Buy + bar.Sell);
    }

    // ---- book ---------------------------------------------------------------------------------

    [Fact]
    public void TwentyLevelDepthIsNotOverwrittenByTheFivePacketWhileFresh()
    {
        var engine = NewEngine();
        var deep = Enumerable.Range(0, 20).Select(i => new DepthLevel(22700m - i, 100, 1)).ToArray();
        engine.OnDepth(new DepthSidePacket(35001, 2, true, deep), T0);
        engine.OnTick(Tick(22700.05m, 1000, 22700m, 22700.05m), T0.AddSeconds(1));

        var snapshot = engine.Snapshot(0, 1, 10);
        Assert.Equal(20, snapshot.Book.Bids.Count);
        Assert.Equal(20, snapshot.Meta.DepthLevels);

        engine.OnTick(Tick(22700.05m, 1000, 22700m, 22700.05m), T0.AddSeconds(10)); // 20-level stale now
        Assert.Equal(2, engine.Snapshot(0, 1, 10).Book.Bids.Count);
        Assert.Equal(5, engine.Snapshot(0, 1, 10).Meta.DepthLevels);
    }

    [Fact]
    public void HeatmapSamplesTheBookAtMostEverySnapshotInterval()
    {
        var engine = NewEngine();
        for (var s = 0; s < 10; s++) engine.OnTick(Tick(100m, 1000 + s, 99.95m, 100m), T0.AddSeconds(s));

        var heatmap = engine.Snapshot(0, 1, 100).Heatmap;
        Assert.Equal(5, heatmap.Count); // seconds 0, 2, 4, 6, 8
        Assert.Equal(3, engine.Snapshot(0, 1, 3).Heatmap.Count);
        Assert.Equal(T0.AddSeconds(8), engine.Snapshot(0, 1, 3).Heatmap[^1].Time);
    }

    // ---- icebergs -----------------------------------------------------------------------------

    [Fact]
    public void ABidThatKeepsRefillingWhileTradingFarMoreThanItShowsIsAnIceberg()
    {
        var engine = NewEngine();
        long volume = 10_000;
        engine.OnTick(Tick(100.05m, volume, 100.00m, 100.05m, bidQty: 150), T0);
        // Sellers hit the 100.00 bid 6 times for 150 each (900 = 12 lots); the bid keeps showing 150.
        for (var i = 1; i <= 6; i++)
            engine.OnTick(Tick(100.00m, volume += 150, 100.00m, 100.05m, bidQty: 150), T0.AddSeconds(i));

        var iceberg = Assert.Single(engine.Snapshot(0, 1, 10).Icebergs);
        Assert.True(iceberg.IsBid);
        Assert.Equal(100.00m, iceberg.Price);
        Assert.Equal(900, iceberg.Traded);
        Assert.Equal(150, iceberg.MaxDisplayed);
        Assert.Null(iceberg.EndedAt);

        // Price trades through: the 100.00 bid leaves the book and the episode ends.
        engine.OnTick(Tick(99.95m, volume += 75, 99.90m, 99.95m), T0.AddSeconds(10));
        Assert.Equal(T0.AddSeconds(10), Assert.Single(engine.Snapshot(0, 1, 10).Icebergs).EndedAt);
    }

    [Fact]
    public void AnOrdinaryLevelThatShowsItsSizeIsNotAnIceberg()
    {
        var engine = NewEngine();
        long volume = 10_000;
        engine.OnTick(Tick(100.05m, volume, 100.00m, 100.05m, bidQty: 3000), T0);
        for (var i = 1; i <= 6; i++)
            engine.OnTick(Tick(100.00m, volume += 150, 100.00m, 100.05m, bidQty: 3000 - i * 150), T0.AddSeconds(i));

        Assert.Empty(engine.Snapshot(0, 1, 10).Icebergs);
    }

    [Fact]
    public void ANewIstDayStartsFromScratch()
    {
        var engine = NewEngine();
        engine.OnTick(Tick(100m, 1000, 99.95m, 100m), T0);
        engine.OnTick(Tick(100m, 1100, 99.95m, 100m), T0.AddSeconds(1));
        Assert.Single(engine.Snapshot(0, 1, 10).Bars);

        engine.OnTick(Tick(100m, 50, 99.95m, 100m), T0.AddDays(1));
        Assert.Empty(engine.Snapshot(0, 1, 10).Bars);
    }
}

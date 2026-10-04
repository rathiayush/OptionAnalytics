using System.Buffers.Binary;
using System.Globalization;
using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// Byte-level coverage for DhanTickPacketParser's Full-packet decoding - specifically the best
/// bid/ask depth fields added so StrategyTriggerHostedService's order-retry loop can re-price off
/// the live book instead of only the last traded price (see that class's GetRepricingReferenceAsync
/// and DhanMarketFeedClient's Full-mode subscription for option strikes).
///
/// Builds packets by hand, writing each field at its documented byte offset with the same
/// BinaryPrimitives/float32 helpers the parser itself reads with - if an offset in the parser is
/// ever wrong, decoding a packet built independently here (not by copy-pasting the parser's own
/// offsets) is what would catch it, rather than the two sides of the same mistake agreeing with
/// each other.
/// </summary>
public sealed class DhanTickPacketParserTests
{
    private const int FullPacketLength = 162;
    private const int QuotePacketLength = 50;

    [Fact]
    public void ParseMessage_FullPacket_DecodesLastPriceOhlcVolumeAndBestBidAsk()
    {
        const uint securityId = 49081;
        const byte exchangeSegment = 2; // NSE_FNO - arbitrary for this test, not asserted
        const float lastPrice = 101.60f;
        const uint volume = 12345;
        const float open = 100.0f;
        const float close = 101.5f;
        const float high = 102.0f;
        const float low = 99.5f;
        const float bestBid = 101.45f;
        const float bestAsk = 101.55f;
        var epochSeconds = (uint)DateTimeOffset.Parse("2026-01-05T09:20:00+05:30", CultureInfo.InvariantCulture).ToUnixTimeSeconds();

        var packet = new byte[FullPacketLength];
        packet[0] = (byte)DhanPacketKind.Full;
        BinaryPrimitives.WriteUInt16LittleEndian(packet.AsSpan(1, 2), FullPacketLength);
        packet[3] = exchangeSegment;
        BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(4, 4), securityId);

        BinaryPrimitives.WriteSingleLittleEndian(packet.AsSpan(8, 4), lastPrice);
        BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(14, 4), epochSeconds);
        BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(22, 4), volume);
        BinaryPrimitives.WriteSingleLittleEndian(packet.AsSpan(46, 4), open);
        BinaryPrimitives.WriteSingleLittleEndian(packet.AsSpan(50, 4), close);
        BinaryPrimitives.WriteSingleLittleEndian(packet.AsSpan(54, 4), high);
        BinaryPrimitives.WriteSingleLittleEndian(packet.AsSpan(58, 4), low);

        // First of the 5 depth entries starts at byte 62 (bidQty:4, askQty:4, bidOrders:2,
        // askOrders:2, bidPrice:4, askPrice:4) - best bid/ask are that entry's price fields, at
        // absolute offsets 74 and 78. The remaining 4 depth entries (bytes 82-161) are left zeroed,
        // same as an exchange sending empty levels beyond the top of book.
        BinaryPrimitives.WriteSingleLittleEndian(packet.AsSpan(74, 4), bestBid);
        BinaryPrimitives.WriteSingleLittleEndian(packet.AsSpan(78, 4), bestAsk);

        var parsed = DhanTickPacketParser.ParseMessage(packet);

        var result = Assert.Single(parsed);
        Assert.Equal(DhanPacketKind.Full, result.Kind);
        Assert.Equal(securityId, result.SecurityId);
        Assert.Equal((decimal)lastPrice, result.LastPrice);
        Assert.Equal((long)volume, result.Volume);
        Assert.Equal((decimal)open, result.Open);
        Assert.Equal((decimal)close, result.Close);
        Assert.Equal((decimal)high, result.High);
        Assert.Equal((decimal)low, result.Low);
        Assert.Equal((decimal)bestBid, result.BestBidPrice);
        Assert.Equal((decimal)bestAsk, result.BestAskPrice);
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(epochSeconds) - TimeSpan.FromHours(5.5), result.ExchangeTimestamp);
    }

    [Fact]
    public void ParseMessage_FullPacket_EmptyBookDecodesBidAskAsZero()
    {
        // A genuinely empty top-of-book (an illiquid strike with no resting orders) is exactly what
        // a zeroed depth entry looks like on the wire - GetRepricingReferenceAsync's callers must
        // see 0, not a fabricated price, so they fall back to the last traded price instead.
        var packet = new byte[FullPacketLength];
        packet[0] = (byte)DhanPacketKind.Full;
        BinaryPrimitives.WriteUInt16LittleEndian(packet.AsSpan(1, 2), FullPacketLength);
        BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(4, 4), 12345);
        BinaryPrimitives.WriteSingleLittleEndian(packet.AsSpan(8, 4), 50.0f);

        var parsed = DhanTickPacketParser.ParseMessage(packet);

        var result = Assert.Single(parsed);
        Assert.Equal(0m, result.BestBidPrice);
        Assert.Equal(0m, result.BestAskPrice);
    }

    [Fact]
    public void ParseMessage_QuotePacket_NeverCarriesBestBidAsk()
    {
        // Quote mode (what the spot/index token stays on) has no depth block at all - bytes 62+
        // simply don't exist in a 50-byte Quote packet, so BestBidPrice/BestAskPrice must come back
        // at their zero default rather than reading garbage past the packet's own declared length.
        var packet = new byte[QuotePacketLength];
        packet[0] = (byte)DhanPacketKind.Quote;
        BinaryPrimitives.WriteUInt16LittleEndian(packet.AsSpan(1, 2), QuotePacketLength);
        BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(4, 4), 99999);
        BinaryPrimitives.WriteSingleLittleEndian(packet.AsSpan(8, 4), 250.25f);

        var parsed = DhanTickPacketParser.ParseMessage(packet);

        var result = Assert.Single(parsed);
        Assert.Equal(DhanPacketKind.Quote, result.Kind);
        Assert.Equal(250.25m, result.LastPrice);
        Assert.Equal(0m, result.BestBidPrice);
        Assert.Equal(0m, result.BestAskPrice);
    }

    [Fact]
    public void ParseMessage_TruncatedFullPacket_IsSkippedRatherThanMisread()
    {
        // Shorter than the 162 bytes a Full packet needs to contain a depth block at all - the
        // parser must reject it outright (empty result) rather than read past the buffer or decode
        // whatever partial bytes happen to be there as a price.
        var packet = new byte[100];
        packet[0] = (byte)DhanPacketKind.Full;
        BinaryPrimitives.WriteUInt16LittleEndian(packet.AsSpan(1, 2), 100);
        BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(4, 4), 1);

        var parsed = DhanTickPacketParser.ParseMessage(packet);

        Assert.Empty(parsed);
    }

    [Fact]
    public void ParseMessage_FullPacket_DecodesTradeQtyTotalsAndAllFiveDepthLevels()
    {
        var packet = new byte[FullPacketLength];
        packet[0] = (byte)DhanPacketKind.Full;
        BinaryPrimitives.WriteUInt16LittleEndian(packet.AsSpan(1, 2), FullPacketLength);
        BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(4, 4), 35001);
        BinaryPrimitives.WriteSingleLittleEndian(packet.AsSpan(8, 4), 22710.5f);
        BinaryPrimitives.WriteUInt16LittleEndian(packet.AsSpan(12, 2), 150);       // last traded qty
        BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(26, 4), 410_000);   // total sell qty
        BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(30, 4), 380_000);   // total buy qty
        for (var i = 0; i < 4; i++) // the fifth level stays empty
        {
            var at = 62 + i * 20;
            BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(at, 4), (uint)(1000 + i));
            BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(at + 4, 4), (uint)(2000 + i));
            BinaryPrimitives.WriteUInt16LittleEndian(packet.AsSpan(at + 8, 2), (ushort)(10 + i));
            BinaryPrimitives.WriteUInt16LittleEndian(packet.AsSpan(at + 10, 2), (ushort)(20 + i));
            BinaryPrimitives.WriteSingleLittleEndian(packet.AsSpan(at + 12, 4), 22710f - i * 0.5f);
            BinaryPrimitives.WriteSingleLittleEndian(packet.AsSpan(at + 16, 4), 22711f + i * 0.5f);
        }

        var result = Assert.Single(DhanTickPacketParser.ParseMessage(packet));

        Assert.Equal(150, result.LastTradedQty);
        Assert.Equal(380_000, result.TotalBuyQty);
        Assert.Equal(410_000, result.TotalSellQty);
        Assert.Equal(4, result.Bids!.Length);
        Assert.Equal(4, result.Asks!.Length);
        Assert.Equal(new DepthLevel(22710m, 1000, 10), result.Bids[0]);
        Assert.Equal(new DepthLevel(22708.5m, 1003, 13), result.Bids[3]);
        Assert.Equal(new DepthLevel(22711m, 2000, 20), result.Asks[0]);
        Assert.Equal(new DepthLevel(22712.5m, 2003, 23), result.Asks[3]);
    }
}

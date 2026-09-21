using System.Buffers.Binary;

namespace OptionAnalytics.Server.Dhan;

/// <summary>What a Dhan market-data packet carries, derived from its response code.</summary>
public enum DhanPacketKind
{
    Unknown = 0,
    Ticker = 2,
    Quote = 4,
    OpenInterest = 5,
    PreviousClose = 6,
    MarketStatus = 7,
    Full = 8,
    Disconnect = 50,
}

/// <summary>One decoded packet. A struct so the hot receive path doesn't allocate per packet.</summary>
public readonly record struct DhanPacket(
    DhanPacketKind Kind,
    uint SecurityId,
    byte ExchangeSegment,
    decimal LastPrice,
    long Volume,
    decimal Open,
    decimal High,
    decimal Low,
    decimal Close,
    decimal BestBidPrice,
    decimal BestAskPrice,
    long OpenInterest,
    DateTimeOffset ExchangeTimestamp,
    int DisconnectCode);

/// <summary>
/// Parses DhanHQ v2's binary market-data protocol. Ported from LiveSpreadCalculator's
/// SpreadTrader.DhanIntegration.Ticker.DhanTickPacketParser (see that file's doc comment for the
/// full protocol writeup: little-endian, float32 prices already in rupees, and a message that may
/// carry several length-prefixed packets back to back) - this app also reads best bid/ask now
/// (see the Full case and ReadBestBidAsk below), for pricing/re-pricing live option orders off the
/// real tradeable side of the book rather than only the last traded price.
///
/// Open interest is read out of the Full packet (bytes 34-38, uint32 LE - see the Full case below)
/// - it arrives piggybacked on every Full-mode tick an option strike already receives, so nothing
/// extra needs subscribing for it. The separate standalone OpenInterest packet kind (5) is still
/// left unread (see its own case below) - Full already covers every OI-Replay-tracked leg, since
/// they are all Full-subscribed for depth anyway, and touching that shared packet-kind's handling
/// would also change behavior for every other existing live consumer of this one parser (CDV,
/// StrategyTriggerHostedService) for no benefit here.
/// </summary>
public static class DhanTickPacketParser
{
    private const int HeaderLength = 8;

    // Offset of the depth block within the Full packet (the only kind that carries one), and the
    // size of each of its 5 depth entries - see the Full case's own layout notes below. The best
    // bid/ask are the price fields of the FIRST entry.
    private const int FullDepthOffset = 62;
    private const int DepthEntryLength = 20;

    private static int KnownLength(DhanPacketKind kind) => kind switch
    {
        DhanPacketKind.Ticker => 16,
        DhanPacketKind.Quote => 50,
        DhanPacketKind.OpenInterest => 12,
        DhanPacketKind.PreviousClose => 16,
        DhanPacketKind.MarketStatus => 8,
        DhanPacketKind.Full => 162,
        DhanPacketKind.Disconnect => 10,
        _ => 0,
    };

    public static IReadOnlyList<DhanPacket> ParseMessage(ReadOnlySpan<byte> message)
    {
        if (message.Length < HeaderLength)
            return Array.Empty<DhanPacket>();

        var packets = new List<DhanPacket>(1);
        var offset = 0;

        while (offset + HeaderLength <= message.Length)
        {
            var kind = (DhanPacketKind)message[offset];
            var declaredLength = BinaryPrimitives.ReadUInt16LittleEndian(message.Slice(offset + 1, 2));

            var length = declaredLength;
            if (length < HeaderLength || offset + length > message.Length)
            {
                var known = KnownLength(kind);
                if (known >= HeaderLength && offset + known <= message.Length)
                    length = (ushort)known;
                else
                    break;
            }

            if (TryParsePacket(message.Slice(offset, length), kind, out var packet))
                packets.Add(packet);

            offset += length;
        }

        return packets;
    }

    private static bool TryParsePacket(ReadOnlySpan<byte> packet, DhanPacketKind kind, out DhanPacket result)
    {
        result = default;
        if (packet.Length < HeaderLength) return false;

        var exchangeSegment = packet[3];
        var securityId = BinaryPrimitives.ReadUInt32LittleEndian(packet.Slice(4, 4));
        var now = DateTimeOffset.UtcNow;

        switch (kind)
        {
            case DhanPacketKind.Ticker:
            {
                if (packet.Length < 16) return false;
                result = New(kind, securityId, exchangeSegment) with
                {
                    LastPrice = ReadPrice(packet.Slice(8, 4)),
                    ExchangeTimestamp = ReadEpoch(packet.Slice(12, 4), now),
                };
                return true;
            }

            case DhanPacketKind.Quote:
            {
                if (packet.Length < 50) return false;
                result = New(kind, securityId, exchangeSegment) with
                {
                    LastPrice = ReadPrice(packet.Slice(8, 4)),
                    ExchangeTimestamp = ReadEpoch(packet.Slice(14, 4), now),
                    Volume = BinaryPrimitives.ReadUInt32LittleEndian(packet.Slice(22, 4)),
                    Open = ReadPrice(packet.Slice(34, 4)),
                    Close = ReadPrice(packet.Slice(38, 4)),
                    High = ReadPrice(packet.Slice(42, 4)),
                    Low = ReadPrice(packet.Slice(46, 4)),
                };
                return true;
            }

            case DhanPacketKind.Full:
            {
                // Bytes 62-162 are 5 depth entries x 20 bytes (bidQty uint32, askQty uint32,
                // bidOrders uint16, askOrders uint16, bidPrice float32, askPrice float32) - the
                // best bid/ask are the first entry's price fields, at offsets 74/78. This is the
                // only packet kind carrying depth at all, which is why option strikes are
                // subscribed in Full mode (see DhanMarketFeedClient) rather than Quote. Bytes
                // 34-38 (uint32 LE) are open interest - see this file's own doc comment above.
                if (packet.Length < 162) return false;
                var (bid, ask) = ReadBestBidAsk(packet, FullDepthOffset);
                result = New(kind, securityId, exchangeSegment) with
                {
                    LastPrice = ReadPrice(packet.Slice(8, 4)),
                    ExchangeTimestamp = ReadEpoch(packet.Slice(14, 4), now),
                    Volume = BinaryPrimitives.ReadUInt32LittleEndian(packet.Slice(22, 4)),
                    OpenInterest = BinaryPrimitives.ReadUInt32LittleEndian(packet.Slice(34, 4)),
                    Open = ReadPrice(packet.Slice(46, 4)),
                    Close = ReadPrice(packet.Slice(50, 4)),
                    High = ReadPrice(packet.Slice(54, 4)),
                    Low = ReadPrice(packet.Slice(58, 4)),
                    BestBidPrice = bid,
                    BestAskPrice = ask,
                };
                return true;
            }

            case DhanPacketKind.PreviousClose:
            {
                if (packet.Length < 16) return false;
                result = New(kind, securityId, exchangeSegment) with { Close = ReadPrice(packet.Slice(8, 4)) };
                return true;
            }

            case DhanPacketKind.Disconnect:
            {
                if (packet.Length < 10) return false;
                result = New(kind, securityId, exchangeSegment) with
                {
                    DisconnectCode = BinaryPrimitives.ReadUInt16LittleEndian(packet.Slice(8, 2)),
                };
                return true;
            }

            case DhanPacketKind.MarketStatus:
            case DhanPacketKind.OpenInterest:
                result = New(kind, securityId, exchangeSegment);
                return true;

            default:
                return false;
        }
    }

    private static DhanPacket New(DhanPacketKind kind, uint securityId, byte exchangeSegment) =>
        new(kind, securityId, exchangeSegment, 0, 0, 0, 0, 0, 0, 0, 0, 0, DateTimeOffset.UtcNow, 0);

    /// <summary>Best bid/ask are the price fields of the FIRST of the five depth entries.</summary>
    private static (decimal Bid, decimal Ask) ReadBestBidAsk(ReadOnlySpan<byte> packet, int depthOffset)
    {
        if (packet.Length < depthOffset + DepthEntryLength) return (0m, 0m);
        var bid = ReadPrice(packet.Slice(depthOffset + 12, 4));
        var ask = ReadPrice(packet.Slice(depthOffset + 16, 4));
        return (bid, ask);
    }

    private static decimal ReadPrice(ReadOnlySpan<byte> bytes)
    {
        var value = BinaryPrimitives.ReadSingleLittleEndian(bytes);
        if (float.IsNaN(value) || float.IsInfinity(value) || value <= 0f) return 0m;
        return value > 1e12f ? 0m : (decimal)value;
    }

    /// <summary>Dhan's own docs (Ticker "Bytes 13-16"/Quote+Full "Bytes 15-18", both "Last Trade
    /// Time - EPOCH") just say EPOCH, and the values this reads ARE Unix epoch seconds - but
    /// verified empirically against a live feed, they measure IST WALL-CLOCK time run through a
    /// Unix-epoch formula, not true UTC. Cross-checked against ground truth: Dhan's REST intraday-
    /// history API (DhanHistoricalDataService, a completely separate endpoint) correctly reports
    /// NSE's 09:15 IST session open as 03:45 UTC, while THIS field's value at the exact same live
    /// instant reads a value that is 5 hours 30 minutes - IST's own UTC offset, to the second -
    /// ahead of the process's own DateTimeOffset.UtcNow. So Dhan appears to compute this field from
    /// a clock reading IST without first converting it to UTC. Subtracting IST's offset here is
    /// what makes ExchangeTimestamp agree with every other clock in this app (UtcNow, the REST
    /// backfill, the exchange's actual opening bell) rather than running a session ahead of them.
    ///
    /// The stakes: this timestamp becomes a live tick's bucketed 1-minute bar time
    /// (SpotUnderlyingState/CdvStrikeRuntime.ApplyPriceTick), which - left uncorrected - misplaces
    /// every live-ticked bar 5.5 hours from where the correctly-UTC REST-backfilled bars around it
    /// sit. On an index-based candlestick axis that renders as an apparently instantaneous,
    /// discontinuous price jump exactly where live data picks up after a backfill (a restart, most
    /// concretely), and it corrupts the IST trading-day boundary (BacktestUtil.IstDate and
    /// CdvUnderlyingState.ApplyDailyBaseline both derive "which day is this bar in" from this exact
    /// timestamp) closely enough to the real day boundary that it can misclassify a live tick into
    /// the wrong trading day - which is what a stray RESET marker or an EMA/Confluence state that
    /// contradicts the chart right next to it, both reported live against this app, looked like.
    /// Every consumer of live ticks shares this one parser (spot AND every option strike, since CDV
    /// and OBV tick through the identical path), so the fix is here once rather than needing to be
    /// applied at each call site.</summary>
    private static readonly TimeSpan IstOffset = IstClock.Offset;

    private static DateTimeOffset ReadEpoch(ReadOnlySpan<byte> bytes, DateTimeOffset fallback)
    {
        var epoch = BinaryPrimitives.ReadUInt32LittleEndian(bytes);
        return epoch > 0 ? DateTimeOffset.FromUnixTimeSeconds(epoch) - IstOffset : fallback;
    }
}

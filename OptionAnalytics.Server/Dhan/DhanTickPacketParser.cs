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
    DateTimeOffset ExchangeTimestamp,
    int DisconnectCode);

/// <summary>
/// Parses DhanHQ v2's binary market-data protocol. Ported verbatim from LiveSpreadCalculator's
/// SpreadTrader.DhanIntegration.Ticker.DhanTickPacketParser (this app only reads
/// price/volume/OHLC, so the depth and open-interest fields that parser also carries are
/// dropped here - see that file's doc comment for the full protocol writeup: little-endian,
/// float32 prices already in rupees, and a message that may carry several length-prefixed
/// packets back to back).
/// </summary>
public static class DhanTickPacketParser
{
    private const int HeaderLength = 8;

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
                if (packet.Length < 162) return false;
                result = New(kind, securityId, exchangeSegment) with
                {
                    LastPrice = ReadPrice(packet.Slice(8, 4)),
                    ExchangeTimestamp = ReadEpoch(packet.Slice(14, 4), now),
                    Volume = BinaryPrimitives.ReadUInt32LittleEndian(packet.Slice(22, 4)),
                    Open = ReadPrice(packet.Slice(46, 4)),
                    Close = ReadPrice(packet.Slice(50, 4)),
                    High = ReadPrice(packet.Slice(54, 4)),
                    Low = ReadPrice(packet.Slice(58, 4)),
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
        new(kind, securityId, exchangeSegment, 0, 0, 0, 0, 0, 0, DateTimeOffset.UtcNow, 0);

    private static decimal ReadPrice(ReadOnlySpan<byte> bytes)
    {
        var value = BinaryPrimitives.ReadSingleLittleEndian(bytes);
        if (float.IsNaN(value) || float.IsInfinity(value) || value <= 0f) return 0m;
        return value > 1e12f ? 0m : (decimal)value;
    }

    private static DateTimeOffset ReadEpoch(ReadOnlySpan<byte> bytes, DateTimeOffset fallback)
    {
        var epoch = BinaryPrimitives.ReadUInt32LittleEndian(bytes);
        return epoch > 0 ? DateTimeOffset.FromUnixTimeSeconds(epoch) : fallback;
    }
}

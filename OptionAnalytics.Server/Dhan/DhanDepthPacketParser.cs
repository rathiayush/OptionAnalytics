using System.Buffers.Binary;

namespace OptionAnalytics.Server.Dhan;

/// <summary>One side (bid or ask) of one instrument's book, as a single packet on Dhan's 20-level or
/// 200-level depth socket delivers it. Depth: which feed it came from (20 or 200).</summary>
public readonly record struct DepthSidePacket(uint SecurityId, byte ExchangeSegment, bool IsBid, DepthLevel[] Levels, int Depth = 20);

/// <summary>
/// Decodes Dhan's 20-level market depth feed (https://dhanhq.co/docs/v2/full-market-depth/). Every
/// packet is a 12-byte header - message length (int16 LE), feed response code (41 = bid side,
/// 51 = ask side, 50 = disconnect), exchange segment, security id (int32 LE), a message sequence to
/// be ignored - followed, for a bid/ask packet, by 20 levels of 16 bytes each: price (float64 LE),
/// quantity (uint32 LE), number of orders (uint32 LE). Bid and ask arrive as separate packets, and a
/// single WebSocket message can carry several packets back to back.
///
/// The 200-level feed (wss://full-depth-api.dhan.co/twohundreddepth) uses the same layout except that
/// header bytes 9-12 are the NUMBER OF ROWS in the packet instead of a sequence - see ParseTwoHundred.
/// </summary>
public static class DhanDepthPacketParser
{
    public const int HeaderLength = 12;
    public const int LevelLength = 16;
    public const int LevelCount = 20;
    public const int SidePacketLength = HeaderLength + LevelCount * LevelLength; // 332

    public const byte BidCode = 41;
    public const byte AskCode = 51;
    public const byte DisconnectCode = 50;
    public const int TwoHundredLevelCount = 200;

    /// <summary>Every bid/ask packet in <paramref name="message"/>. A disconnect packet sets
    /// <paramref name="disconnectReason"/> (Dhan's reason code). Empty levels are skipped.</summary>
    public static List<DepthSidePacket> Parse(ReadOnlySpan<byte> message, out int? disconnectReason)
        => ParseCore(message, rowsInHeader: false, out disconnectReason);

    /// <summary>The 200-level feed's packets: as Parse, with the row count taken from the header
    /// (at most 200).</summary>
    public static List<DepthSidePacket> ParseTwoHundred(ReadOnlySpan<byte> message, out int? disconnectReason)
        => ParseCore(message, rowsInHeader: true, out disconnectReason);

    private static List<DepthSidePacket> ParseCore(ReadOnlySpan<byte> message, bool rowsInHeader, out int? disconnectReason)
    {
        disconnectReason = null;
        var result = new List<DepthSidePacket>();
        var offset = 0;
        while (offset + HeaderLength <= message.Length)
        {
            var declared = BinaryPrimitives.ReadUInt16LittleEndian(message.Slice(offset, 2));
            var code = message[offset + 2];
            var segment = message[offset + 3];
            var securityId = BinaryPrimitives.ReadUInt32LittleEndian(message.Slice(offset + 4, 4));

            if (code == DisconnectCode)
            {
                disconnectReason = offset + HeaderLength + 2 <= message.Length
                    ? BinaryPrimitives.ReadUInt16LittleEndian(message.Slice(offset + HeaderLength, 2))
                    : 0;
                break;
            }

            if (code is not (BidCode or AskCode))
            {
                // Unknown packet: skip it by its declared length when that is usable, else stop - a
                // misaligned read would only produce garbage prices.
                if (declared < HeaderLength || offset + declared > message.Length) break;
                offset += declared;
                continue;
            }

            var rows = rowsInHeader
                ? (int)Math.Min(BinaryPrimitives.ReadUInt32LittleEndian(message.Slice(offset + 8, 4)), TwoHundredLevelCount)
                : LevelCount;
            // The declared length is trusted only when it covers every row and fits; otherwise the
            // rows' own size is used.
            var minimum = HeaderLength + rows * LevelLength;
            var length = declared >= minimum && offset + declared <= message.Length ? declared : minimum;
            if (offset + length > message.Length) break;

            var levels = new List<DepthLevel>(rows);
            for (var i = 0; i < rows; i++)
            {
                var at = offset + HeaderLength + i * LevelLength;
                var price = BinaryPrimitives.ReadDoubleLittleEndian(message.Slice(at, 8));
                var quantity = BinaryPrimitives.ReadUInt32LittleEndian(message.Slice(at + 8, 4));
                var orders = BinaryPrimitives.ReadUInt32LittleEndian(message.Slice(at + 12, 4));
                if (!double.IsFinite(price) || price <= 0 || price > 1e9) continue;
                levels.Add(new DepthLevel(Math.Round((decimal)price, 2), quantity, (int)Math.Min(orders, int.MaxValue)));
            }

            result.Add(new DepthSidePacket(securityId, segment, code == BidCode, levels.ToArray(), rowsInHeader ? TwoHundredLevelCount : LevelCount));
            offset += length;
        }

        return result;
    }
}

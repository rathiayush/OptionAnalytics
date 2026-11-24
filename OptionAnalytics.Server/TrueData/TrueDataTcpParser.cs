using System.Buffers.Binary;
using System.Text;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.TrueData;

/// <summary>
/// Decodes TrueData's real-time TCP stream (tcp.truedata.in:7070, TCP API v2.3) into the SAME frames the WebSocket parser gives
/// (<see cref="TrueDataFrame"/> - so the feed's routing, TickBook and page are shared). Pure - bytes in, frames out, no network.
///
/// The stream mixes TEXT (the welcome line, the login answer, JSON replies to "addsymbol" - the symbol ids) with fixed-size BINARY
/// packets that start with a two-letter code and end with "Z": "TR" trade (87 bytes - symbol id, time, SEQUENCE number, LTP, the LAST
/// TICK'S VOLUME, ATP, the day's volume, OHL, previous close, OI, turnover, best bid / ask), "BA" best bid / ask (27), "L2" five-level
/// book (139, skipped - NSE has level 1 only) and the market-session codes (PO / PC / CO / CC / CK / CL / FO / FC / DO / DC).
/// Numbers are LITTLE-ENDIAN (TrueData's own Python client decodes its binary feed '&lt;i' / '&lt;f' / '&lt;d'); the first trade or quote
/// checks that against the clock and a big-endian stream is read as such. The time is a Unix integer holding the IST wall clock
/// (that client prints it as IST); one that only fits the clock as real UTC is read as that (<see cref="ToTime"/>).
///
/// Bytes that make no sense are skipped up to the next recognisable start and counted (<see cref="Skipped"/>) - never thrown.
/// </summary>
public sealed class TrueDataTcpParser
{
    public const int TradeSize = 87, QuoteSize = 27, Level2Size = 139, MarketSize = 42;
    private static readonly TimeSpan Ist = TimeSpan.FromMinutes(330);
    private static readonly HashSet<string> MarketCodes = new() { "PO", "PC", "CO", "CC", "CK", "CL", "FO", "FC", "DO", "DC" };

    private byte[] _buf = new byte[4096];
    private int _len;
    private bool? _littleEndian;

    /// <summary>The arrival clock (a test sets it).</summary>
    public Func<DateTimeOffset> Clock { get; set; } = () => DateTimeOffset.UtcNow;
    /// <summary>Bytes thrown away to find the next packet - 0 on a clean stream.</summary>
    public long Skipped { get; private set; }
    public long Trades { get; private set; }
    public long Quotes { get; private set; }
    /// <summary>"little" / "big" once known, else "unknown".</summary>
    public string ByteOrder => _littleEndian is null ? "unknown" : _littleEndian.Value ? "little" : "big";
    /// <summary>True while bytes of a text line wait for their end (the transport flushes them after a short idle).</summary>
    public bool HasPendingText => _len > 0 && IsTextStart(_buf[0]);

    public IReadOnlyList<TrueDataFrame> Feed(ReadOnlySpan<byte> bytes)
    {
        if (_len + bytes.Length > _buf.Length) Array.Resize(ref _buf, Math.Max(_buf.Length * 2, _len + bytes.Length));
        bytes.CopyTo(_buf.AsSpan(_len));
        _len += bytes.Length;
        return Drain(flushText: false);
    }

    /// <summary>A text line with no line end that nothing has followed: take it as it is (a login answer may not end in one).</summary>
    public IReadOnlyList<TrueDataFrame> FlushText() => Drain(flushText: true);

    private List<TrueDataFrame> Drain(bool flushText)
    {
        var frames = new List<TrueDataFrame>();
        var pos = 0;
        while (pos < _len)
        {
            var b = _buf[pos];
            if (b is (byte)'\r' or (byte)'\n' or (byte)' ' or 0) { pos++; continue; }
            var left = _len - pos;
            if (b == '{')
            {
                var end = JsonEnd(pos);
                if (end < 0) break;
                frames.Add(TrueDataLiveParser.Parse(Encoding.UTF8.GetString(_buf, pos, end - pos)));
                pos = end;
                continue;
            }
            if (left < 2) break;
            var code = ((char)b).ToString() + (char)_buf[pos + 1];
            if (code is "TR" or "BA" or "L2")
            {
                var size = code == "TR" ? TradeSize : code == "BA" ? QuoteSize : Level2Size;
                if (left < size) break;
                if (_buf[pos + size - 1] != (byte)'Z') { pos++; Skipped++; continue; }   // not a packet after all: look on
                var frame = code == "TR" ? Trade(_buf.AsSpan(pos, size)) : code == "BA" ? Quote(_buf.AsSpan(pos, size)) : null;
                if (frame is not null) frames.Add(frame);
                pos += size;
                continue;
            }
            if (MarketCodes.Contains(code) && !(_buf[pos + 1] is >= (byte)'a' and <= (byte)'z'))
            {
                var z = IndexOfZ(pos + 2, Math.Min(_len, pos + MarketSize));
                if (z < 0) { if (left < MarketSize) break; pos += 2; Skipped += 2; continue; }
                frames.Add(new TrueDataFrame("status", Message: code));
                pos = z + 1;
                continue;
            }
            if (IsTextStart(b))
            {
                // Text only when a run of printable characters ends in a line end (or runs into the packets after it); binary bytes that
                // merely start with a letter are not a line that waits for ever.
                var run = 0;
                while (pos + run < _len && _buf[pos + run] is >= 0x20 and <= 0x7E) run++;
                var atEnd = pos + run >= _len;
                var endsLine = !atEnd && _buf[pos + run] is (byte)'\r' or (byte)'\n';
                if (atEnd && !flushText) break;
                if (endsLine || atEnd || run >= 8)
                {
                    var text = Encoding.UTF8.GetString(_buf, pos, run).Trim();
                    if (text.Length > 0) frames.Add(Line(text));
                    pos += run;
                    continue;
                }
            }
            pos++; Skipped++;   // a byte that starts nothing
        }
        if (pos > 0)
        {
            Buffer.BlockCopy(_buf, pos, _buf, 0, _len - pos);
            _len -= pos;
        }
        return frames;
    }

    private static bool IsTextStart(byte b) => b is >= (byte)'A' and <= (byte)'Z' or >= (byte)'a' and <= (byte)'z';

    private int IndexOfZ(int from, int to)
    {
        for (var i = from; i < to; i++) if (_buf[i] == (byte)'Z') return i;
        return -1;
    }

    /// <summary>The end (exclusive) of the JSON object starting at <paramref name="start"/>, or -1 while it is incomplete.</summary>
    private int JsonEnd(int start)
    {
        int depth = 0; var inString = false; var escaped = false;
        for (var i = start; i < _len; i++)
        {
            var c = _buf[i];
            if (inString)
            {
                if (escaped) escaped = false;
                else if (c == '\\') escaped = true;
                else if (c == '"') inString = false;
                continue;
            }
            if (c == '"') inString = true;
            else if (c == '{') depth++;
            else if (c == '}' && --depth == 0) return i + 1;
        }
        return -1;
    }

    /// <summary>A plain text line: the welcome, the login answer ("TrueData Real Time Data Service:800:NSE,FO,MCX:12/31/2021 ..."),
    /// or a refusal in words.</summary>
    internal static TrueDataFrame Line(string text)
    {
        if (text.StartsWith("TrueData Real Time", StringComparison.OrdinalIgnoreCase) && text.Contains(':'))
            return new TrueDataFrame("login", Message: text);
        var lower = text.ToLowerInvariant();
        if (lower.Contains("already") || lower.Contains("invalid") || lower.Contains("incorrect") || lower.Contains("denied")
            || lower.Contains("expired") || lower.Contains("not allowed") || lower.Contains("failed") || lower.Contains("wrong"))
            return new TrueDataFrame("error", Message: text, Success: false);
        return new TrueDataFrame("other", Message: text);
    }

    private TrueDataFrame? Trade(ReadOnlySpan<byte> p)
    {
        if (!Order(U32(p, 6))) return null;
        Trades++;
        return new TrueDataFrame("trade", Trade: new TrueDataTrade(
            U32(p, 2).ToString(), ToTime(U32(p, 6)), F32(p, 14), U32(p, 18), F32(p, 22), U32(p, 26),
            F32(p, 30), F32(p, 34), F32(p, 38), F32(p, 42), I64(p, 46), "", U32(p, 10),
            F32(p, 70), U32(p, 74), F32(p, 78), U32(p, 82)));
    }

    private TrueDataFrame? Quote(ReadOnlySpan<byte> p)
    {
        if (!Order(U32(p, 6))) return null;
        Quotes++;
        return new TrueDataFrame("bidask", Quote: new TrueDataQuote(U32(p, 2).ToString(), ToTime(U32(p, 6)), F32(p, 10), U32(p, 14), F32(p, 18), U32(p, 22)));
    }

    /// <summary>Settles the byte order on the first packet: the time read little-endian must be near now (either as the IST wall clock
    /// or as UTC); if not, big-endian is tried. A time that fits neither way keeps little-endian and the packet is still read.</summary>
    private bool Order(long epochAsRead)
    {
        if (_littleEndian is not null) return true;
        if (Plausible(epochAsRead)) { _littleEndian = true; return true; }
        var swapped = BinaryPrimitives.ReverseEndianness((uint)epochAsRead);
        _littleEndian = Plausible(swapped) ? false : true;
        return true;
    }

    private bool Plausible(long epoch)
    {
        if (epoch <= 0) return false;
        var now = Clock().ToUnixTimeSeconds();
        return Math.Abs(epoch - now) < 3 * 86_400 + 6 * 3600;
    }

    /// <summary>TrueData's time integer: the IST wall clock written as a Unix time. One that is hours off now that way but within two hours of now
    /// as real UTC is read as real UTC. Public for the tests.</summary>
    public DateTimeOffset ToTime(long epoch)
    {
        var wall = DateTime.SpecifyKind(DateTime.UnixEpoch.AddSeconds(epoch), DateTimeKind.Unspecified);
        var asIst = new DateTimeOffset(wall, Ist);
        var asUtc = new DateTimeOffset(wall, TimeSpan.Zero).ToOffset(Ist);
        var now = Clock();
        var near = TimeSpan.FromHours(2);
        return (asUtc - now).Duration() < near && (asIst - now).Duration() >= near ? asUtc : asIst;
    }

    private long U32(ReadOnlySpan<byte> p, int at) => _littleEndian == false ? BinaryPrimitives.ReadUInt32BigEndian(p[at..]) : BinaryPrimitives.ReadUInt32LittleEndian(p[at..]);
    private long I64(ReadOnlySpan<byte> p, int at) => _littleEndian == false ? BinaryPrimitives.ReadInt64BigEndian(p[at..]) : BinaryPrimitives.ReadInt64LittleEndian(p[at..]);
    private decimal F32(ReadOnlySpan<byte> p, int at) => DecimalConversion.FromSingle(_littleEndian == false ? BinaryPrimitives.ReadSingleBigEndian(p[at..]) : BinaryPrimitives.ReadSingleLittleEndian(p[at..]));
}

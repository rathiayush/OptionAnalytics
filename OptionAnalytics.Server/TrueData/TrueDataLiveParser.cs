using System.Globalization;
using System.Text.Json;

namespace OptionAnalytics.Server.TrueData;

/// <summary>One "trade" message of TrueData's real-time feed: the last trade with the best bid / ask in the same packet
/// (Specification v2.6, "Tick Streaming Data Response"). <c>Quantity</c> is the LAST TRADE's quantity (LTQ) and
/// <c>TotalVolume</c> the day's running total (TTQ) - so a trade is given, never inferred from a volume change.</summary>
public sealed record TrueDataTrade(string SymbolId, DateTimeOffset? Time, decimal Price, long Quantity, decimal Atp, long TotalVolume,
    decimal Open, decimal High, decimal Low, decimal PrevClose, long OpenInterest, string Tag, long Sequence,
    decimal Bid, long BidQty, decimal Ask, long AskQty);

/// <summary>A "bidask" message: the best bid / ask changed with no trade.</summary>
public sealed record TrueDataQuote(string SymbolId, DateTimeOffset? Time, decimal Bid, long BidQty, decimal Ask, long AskQty);

/// <summary>A symbol and its id from a subscribe reply (the "symbollist" rows) - the feed names symbols by id.</summary>
public sealed record TrueDataSymbol(string Name, string SymbolId);

/// <summary>What one text frame of the real-time socket is.</summary>
public sealed record TrueDataFrame(
    string Kind, // "trade" | "bidask" | "login" | "symbols" | "heartbeat" | "status" | "error" | "other"
    TrueDataTrade? Trade = null, TrueDataQuote? Quote = null, IReadOnlyList<TrueDataSymbol>? Symbols = null, string? Message = null, bool Success = true);

/// <summary>Reads the real-time socket's JSON frames. Pure - no network. A frame that is not understood is "other" (never
/// thrown). Times are IST, second resolution; the "bidask" example in the spec uses "2/18/2020 3:43:45 PM", so several
/// formats are accepted and a time that does not parse is null (the caller uses the arrival time).</summary>
public static class TrueDataLiveParser
{
    private static readonly TimeSpan Ist = TimeSpan.FromMinutes(330);
    private static readonly string[] TimeFormats =
    {
        "yyyy-MM-ddTHH:mm:ss", "yyyy-MM-ddTHH:mm:ss.fff", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-ddTHH:mm:ss.ffffff",
        "M/d/yyyy h:mm:ss tt", "MM/dd/yyyy h:mm:ss tt", "M/d/yyyy H:mm:ss", "dd-MM-yyyy HH:mm:ss",
    };

    public static TrueDataFrame Parse(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return new TrueDataFrame("other");
        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return new TrueDataFrame("other");

            if (root.TryGetProperty("trade", out var trade)) return ParseTrade(trade);
            if (root.TryGetProperty("bidask", out var bidAsk)) return ParseQuote(bidAsk);

            var message = Str(root, "message");
            var success = !root.TryGetProperty("success", out var ok) || ok.ValueKind != JsonValueKind.False && !(ok.ValueKind == JsonValueKind.String && ok.GetString() == "false");
            if (root.TryGetProperty("symbollist", out var list))
                return new TrueDataFrame("symbols", Symbols: ParseSymbols(list), Message: message, Success: success);
            if (string.Equals(message, "HeartBeat", StringComparison.OrdinalIgnoreCase)) return new TrueDataFrame("heartbeat", Message: message);
            if (string.Equals(message, "marketstatus", StringComparison.OrdinalIgnoreCase)) return new TrueDataFrame("status", Message: Str(root, "data") ?? message);
            if (!success) return new TrueDataFrame("error", Message: message ?? "TrueData refused the request", Success: false);
            if (root.TryGetProperty("segments", out _) || root.TryGetProperty("maxsymbols", out _))
                return new TrueDataFrame("login", Message: message, Success: true);
            return new TrueDataFrame("other", Message: message, Success: success);
        }
        catch (JsonException) { return new TrueDataFrame("other"); }
    }

    private static TrueDataFrame ParseTrade(JsonElement element)
    {
        // {"trade":[...]} - one trade; tolerate an array of them (the first is taken: one frame, one message).
        var f = Fields(element);
        if (f is null || f.Count < 15) return new TrueDataFrame("other");
        decimal bid = 0, ask = 0;
        long bidQty = 0, askQty = 0;
        if (f.Count >= 19) { bid = D(f[15]); bidQty = L(f[16]); ask = D(f[17]); askQty = L(f[18]); }
        var trade = new TrueDataTrade(f[0], Time(f[1]), D(f[2]), L(f[3]), D(f[4]), L(f[5]), D(f[6]), D(f[7]), D(f[8]), D(f[9]),
            L(f[10]), f.Count > 13 ? f[13] : "", L(f[14]), bid, bidQty, ask, askQty);
        return new TrueDataFrame("trade", Trade: trade);
    }

    private static TrueDataFrame ParseQuote(JsonElement element)
    {
        var f = Fields(element);
        if (f is null || f.Count < 6) return new TrueDataFrame("other");
        return new TrueDataFrame("bidask", Quote: new TrueDataQuote(f[0], Time(f[1]), D(f[2]), L(f[3]), D(f[4]), L(f[5])));
    }

    private static IReadOnlyList<TrueDataSymbol> ParseSymbols(JsonElement list)
    {
        var rows = new List<TrueDataSymbol>();
        if (list.ValueKind != JsonValueKind.Array) return rows;
        foreach (var row in list.EnumerateArray())
        {
            var f = Fields(row);
            if (f is { Count: >= 2 } && f[0].Length > 0 && f[1].Length > 0) rows.Add(new TrueDataSymbol(f[0], f[1]));
        }
        return rows;
    }

    /// <summary>An array's values as strings (TrueData sends every number as a string).</summary>
    private static List<string>? Fields(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Array) return null;
        if (element.GetArrayLength() > 0 && element[0].ValueKind == JsonValueKind.Array) element = element[0];
        var values = new List<string>(element.GetArrayLength());
        foreach (var v in element.EnumerateArray())
            values.Add(v.ValueKind switch
            {
                JsonValueKind.String => v.GetString() ?? "",
                JsonValueKind.Number => v.GetRawText(),
                JsonValueKind.Null => "",
                _ => v.GetRawText(),
            });
        return values;
    }

    private static string? Str(JsonElement root, string name) =>
        root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static decimal D(string s) => decimal.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : 0;
    private static long L(string s) =>
        long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? v
        : decimal.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? (long)d : 0;

    internal static DateTimeOffset? Time(string s) =>
        DateTime.TryParseExact(s, TimeFormats, CultureInfo.InvariantCulture, DateTimeStyles.None, out var t) ? new DateTimeOffset(t, Ist) : null;
}

using System.Globalization;

namespace OptionAnalytics.Server.TrueData;

/// <summary>One tick of TrueData's history: the last trade (price, quantity) with the best bid / ask then.
/// Volume is the day's CUMULATIVE traded quantity (see TrueDataTickCsv.Parse) - what OrderFlowEngine
/// reads a trade from (its change).</summary>
public sealed record TrueDataTick(DateTimeOffset Time, decimal Ltp, long Volume, long OpenInterest, decimal Bid, long BidQty, decimal Ask, long AskQty);

/// <summary>Parses TrueData's tick history CSV - header, then
/// <c>time,ltp,volume,oi[,bid,bid_qty,ask,ask_qty]</c> (the bid / ask columns only with bidask=1), times
/// in IST. Rows that do not parse are skipped. A reply that is not a CSV (TrueData's "No data exists for
/// ..." / "Symbol does not exist" or an error) comes back as Error with no ticks.</summary>
public static class TrueDataTickCsv
{
    private static readonly TimeSpan Ist = TimeSpan.FromMinutes(330);
    private static readonly string[] TimeFormats =
    {
        "yyyy-MM-ddTHH:mm:ss", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-ddTHH:mm:ss.fff", "yyyy-MM-dd HH:mm:ss.fff",
        "dd-MM-yyyy HH:mm:ss", "yyyyMMdd HH:mm:ss", "yyMMddTHH:mm:ss",
    };

    public sealed record Result(IReadOnlyList<TrueDataTick> Ticks, string? Error, bool VolumeWasPerTick);

    public static Result Parse(string? csv)
    {
        if (string.IsNullOrWhiteSpace(csv)) return new Result(Array.Empty<TrueDataTick>(), "TrueData returned nothing", false);
        var lines = csv.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var first = lines[0];
        if (!first.Contains(',')) return new Result(Array.Empty<TrueDataTick>(), $"TrueData: {Trim(first)}", false);

        var raw = new List<(DateTimeOffset Time, decimal Ltp, long Volume, long Oi, decimal Bid, long BidQty, decimal Ask, long AskQty)>(lines.Length);
        foreach (var line in lines)
        {
            var f = line.Split(',');
            if (f.Length < 3 || !TryTime(f[0], out var time) || !TryDecimal(f[1], out var ltp)) continue; // the header, or junk
            TryLong(f[2], out var volume);
            var oi = f.Length > 3 && TryLong(f[3], out var o) ? o : 0;
            decimal bid = 0, ask = 0;
            long bidQty = 0, askQty = 0;
            if (f.Length >= 8)
            {
                TryDecimal(f[4], out bid);
                TryLong(f[5], out bidQty);
                TryDecimal(f[6], out ask);
                TryLong(f[7], out askQty);
            }
            raw.Add((time, ltp, volume, oi, bid, bidQty, ask, askQty));
        }
        if (raw.Count == 0) return new Result(Array.Empty<TrueDataTick>(), "TrueData's reply had no ticks", false);
        raw.Sort((a, b) => a.Time.CompareTo(b.Time));

        // The volume column: the day's running total on some feeds, the tick's own quantity on others. A
        // running total never goes down over a whole day of ticks; a tick's own quantity goes up and down.
        var perTick = raw.Count >= 2 && raw.Zip(raw.Skip(1)).Any(p => p.Second.Volume < p.First.Volume);
        long running = 0;
        var ticks = new List<TrueDataTick>(raw.Count);
        foreach (var r in raw)
        {
            running = perTick ? running + Math.Max(0, r.Volume) : r.Volume;
            ticks.Add(new TrueDataTick(r.Time, r.Ltp, running, r.Oi, r.Bid, r.BidQty, r.Ask, r.AskQty));
        }
        return new Result(ticks, null, perTick);
    }

    private static string Trim(string text) => text.Length > 160 ? text[..160] + "..." : text;

    private static bool TryTime(string text, out DateTimeOffset time)
    {
        text = text.Trim().Trim('"');
        if (DateTime.TryParseExact(text, TimeFormats, CultureInfo.InvariantCulture, DateTimeStyles.None, out var dt)
            || DateTime.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.None, out dt) && text.Length >= 10 && char.IsDigit(text[0]))
        {
            time = new DateTimeOffset(DateTime.SpecifyKind(dt, DateTimeKind.Unspecified), Ist);
            return true;
        }
        time = default;
        return false;
    }

    private static bool TryDecimal(string text, out decimal value) =>
        decimal.TryParse(text.Trim().Trim('"'), NumberStyles.Float, CultureInfo.InvariantCulture, out value);

    private static bool TryLong(string text, out long value)
    {
        if (long.TryParse(text.Trim().Trim('"'), NumberStyles.Integer, CultureInfo.InvariantCulture, out value)) return true;
        if (decimal.TryParse(text.Trim().Trim('"'), NumberStyles.Float, CultureInfo.InvariantCulture, out var d)) { value = (long)d; return true; }
        value = 0;
        return false;
    }
}

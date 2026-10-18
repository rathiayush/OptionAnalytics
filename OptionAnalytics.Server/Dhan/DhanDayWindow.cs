using System.Net;
using System.Text.Json;

namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// A Dhan candle call's window of IST days through the per-day disk cache (DhanDataCache): the days kept are read from
/// disk, the rest - the first day not kept to the last one, today always among them - are asked of Dhan in ONE call,
/// and each closed day of that answer is kept for every later window that holds it. Used by DhanHistoricalDataService
/// (intraday spot / futures / option candles) and DhanRollingOptionDataService (the rolling / expired-option chain).
/// </summary>
internal static class DhanDayWindow
{
    /// <summary>The days of [from, to] read from disk (wrapped as Dhan's own answer, the caller disposes them) and the
    /// span still to ask Dhan for (null = every day was kept). Kept days inside that span come with the call instead.</summary>
    /// <paramref name="fullDayRows"/> (0 = any): a kept day with fewer rows than that (but some) has holes - it is dropped and
    /// asked again (<paramref name="seriesOf"/> finds the arrays in a kept answer).
    public static (List<DhanApiResponse> Kept, (DateOnly From, DateOnly To)? Ask) Plan(DhanDataCache? cache, string endpoint, object key, DateOnly from, DateOnly to,
        int fullDayRows = 0, Func<JsonElement, JsonElement>? seriesOf = null, int intervalMinutes = 1)
    {
        if (cache is null) return (new List<DhanApiResponse>(), (from, to));
        DateOnly? askFrom = null, askTo = null;
        void Ask(DateOnly d)
        {
            if (askFrom is null || d < askFrom) askFrom = d;
            if (askTo is null || d > askTo) askTo = d;
        }

        foreach (var d in Days(from, to)) if (!cache.HasDay(endpoint, key, d)) Ask(d);
        var kept = new SortedDictionary<DateOnly, JsonDocument>();
        foreach (var d in Days(from, to))
        {
            if (askFrom is not null && d >= askFrom && d <= askTo) continue;
            var doc = cache.TryGetDay(endpoint, key, d);
            if (doc is not null && HasHoles(seriesOf is null ? doc.RootElement : seriesOf(doc.RootElement), fullDayRows, intervalMinutes))
            {
                doc.Dispose();
                doc = null;
                cache.DropDay(endpoint, key, d);
            }
            if (doc is not null) kept[d] = doc;
            else Ask(d); // gone or broken since (a broken file is deleted): asked too
        }
        var parts = new List<DhanApiResponse>();
        foreach (var (day, doc) in kept)
        {
            if (askFrom is not null && day >= askFrom && day <= askTo) doc.Dispose();
            else parts.Add(new DhanApiResponse(true, HttpStatusCode.OK, doc, null));
        }
        return (parts, askFrom is null ? null : (askFrom.Value, askTo!.Value));
    }

    /// <summary>Keeps each final day of [from, to] in Dhan's answer. <paramref name="series"/> is where its parallel
    /// arrays are (the answer itself for /charts/intraday, data.ce / data.pe for /charts/rollingoption) and
    /// <paramref name="wrap"/> writes a day's part back in the answer's shape. A day is final when it is before today
    /// AND Dhan sent a full session of it (its own minutes - a thin strike's 0-priced ones count) or has already sent a
    /// LATER past day in this answer (then a holiday has nothing - kept empty - and a short session stays short). The
    /// last day of an answer with less than a session is asked again; a day already on disk is left as it is. With
    /// <paramref name="fullDayRows"/> (1-minute rows, 0 = off) a day with data is kept only when it has that many - one
    /// with holes in it is asked again next time rather than kept with them for good. Returns the days written.</summary>
    public static int Keep(DhanDataCache? cache, string endpoint, object key, DateOnly from, DateOnly to, JsonElement series,
        Func<Action<Utf8JsonWriter>, Action<Utf8JsonWriter>> wrap, int intervalMinutes, int fullDayRows = 0)
    {
        if (cache is null) return 0;
        var ranges = DayRanges(series);
        if (ranges is null) return 0;
        var minimum = Math.Max(1, 300 / Math.Max(1, intervalMinutes));
        var pastWithData = ranges.Keys.Where(cache.Cacheable).ToList();
        DateOnly? lastPast = pastWithData.Count > 0 ? pastWithData.Max() : null;
        var kept = 0;
        foreach (var d in Days(from, to))
        {
            if (!cache.Cacheable(d) || cache.HasDay(endpoint, key, d)) continue;
            var answeredPast = lastPast is not null && d < lastPast;
            if (ranges.TryGetValue(d, out var r))
            {
                if (r.End - r.Start < minimum && !answeredPast) continue;
                if (r.End > r.Start && r.End - r.Start < fullDayRows / Math.Max(1, intervalMinutes)) continue;
                cache.PutDay(endpoint, key, d, wrap(w => WriteSlice(w, series, r.Start, r.End)));
            }
            else if (answeredPast) cache.PutDay(endpoint, key, d, wrap(w => WriteSlice(w, series, 0, 0)));
            else continue;
            kept++;
        }
        return kept;
    }

    /// <summary>Whether any day of the answer has data but fewer than <paramref name="fullDayRows"/> rows (0 = never).</summary>
    public static bool HasHoles(JsonElement series, int fullDayRows, int intervalMinutes = 1)
    {
        if (fullDayRows <= 0) return false;
        var ranges = DayRanges(series);
        return ranges is not null && ranges.Values.Any(r => r.End > r.Start && r.End - r.Start < fullDayRows / Math.Max(1, intervalMinutes));
    }

    /// <summary>Each IST day's [Start, End) of the answer's arrays - empty when it has none; null when its timestamps are
    /// not in order (nothing is then kept per day).</summary>
    internal static Dictionary<DateOnly, (int Start, int End)>? DayRanges(JsonElement series)
    {
        var ranges = new Dictionary<DateOnly, (int Start, int End)>();
        if (series.ValueKind != JsonValueKind.Object || !series.TryGetProperty("timestamp", out var stamps) || stamps.ValueKind != JsonValueKind.Array) return ranges;
        DateOnly? current = null;
        int start = 0, i = 0;
        foreach (var t in stamps.EnumerateArray())
        {
            if (t.ValueKind != JsonValueKind.Number || !t.TryGetDouble(out var seconds) || seconds <= 0) return null;
            var day = IstClock.IstDate(DateTimeOffset.FromUnixTimeSeconds((long)seconds));
            if (day != current)
            {
                if (current is not null)
                {
                    if (day < current || ranges.ContainsKey(current.Value)) return null;
                    ranges[current.Value] = (start, i);
                }
                current = day;
                start = i;
            }
            i++;
        }
        if (current is not null)
        {
            if (ranges.ContainsKey(current.Value)) return null;
            ranges[current.Value] = (start, i);
        }
        return ranges;
    }

    /// <summary>The answer's object with every array cut to [start, end) - the other fields as they are.</summary>
    internal static void WriteSlice(Utf8JsonWriter w, JsonElement series, int start, int end)
    {
        w.WriteStartObject();
        foreach (var p in series.EnumerateObject())
        {
            w.WritePropertyName(p.Name);
            if (p.Value.ValueKind != JsonValueKind.Array) { p.Value.WriteTo(w); continue; }
            w.WriteStartArray();
            var i = 0;
            foreach (var e in p.Value.EnumerateArray())
            {
                if (i >= end) break;
                if (i++ >= start) e.WriteTo(w);
            }
            w.WriteEndArray();
        }
        w.WriteEndObject();
    }

    internal static IEnumerable<DateOnly> Days(DateOnly from, DateOnly to)
    {
        for (var d = from; d <= to; d = d.AddDays(1)) yield return d;
    }
}

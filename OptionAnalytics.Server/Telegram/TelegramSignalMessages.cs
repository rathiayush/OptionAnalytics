using System.Globalization;
using System.IO.Compression;
using System.Text.Json;

namespace OptionAnalytics.Server.Telegram;

/// <summary>
/// The channel's messages of the past days FETCHED FROM TELEGRAM, kept on the server so a day is asked of Telegram once
/// (asked for - "server side + caching, if it is not there then telegram fetch"): one gzip JSON per IST day
/// (`{yyyy-MM-dd}.json.gz` in `from-telegram/` under the message log's folder - Storage:TelegramLogPath; an empty day - a
/// weekend, a holiday - kept empty so it is not asked again), KeepDays kept. Only a whole past day is written (never today,
/// never a day a fetch was cut short on).
/// </summary>
public sealed class TelegramDayCache
{
    public const int KeepDays = 400;

    private readonly string _root;
    private readonly ILogger<TelegramDayCache> _logger;
    private DateOnly _prunedOn;

    public TelegramDayCache(TelegramMessageLog log, ILogger<TelegramDayCache> logger) : this(Path.Combine(log.Root, "from-telegram"), logger)
    {
    }

    internal TelegramDayCache(string root, ILogger<TelegramDayCache> logger)
    {
        _root = root;
        _logger = logger;
    }

    private sealed record Row(int Id, DateTimeOffset Time, string Text);

    /// <summary>The day's messages as kept, or null when the day was never fetched (or its file cannot be read).</summary>
    public IReadOnlyList<TelegramChannelMessage>? Read(DateOnly day)
    {
        var file = FileOf(day);
        if (!File.Exists(file)) return null;
        try
        {
            using var stream = new GZipStream(File.OpenRead(file), CompressionMode.Decompress);
            var rows = JsonSerializer.Deserialize<List<Row>>(stream) ?? [];
            return rows.Select(r => new TelegramChannelMessage(r.Id, r.Time, r.Text)).ToList();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not read the kept Telegram day {Day} - it is asked of Telegram again.", day);
            return null;
        }
    }

    public void Write(DateOnly day, IEnumerable<TelegramChannelMessage> messages, DateOnly today)
    {
        try
        {
            Directory.CreateDirectory(_root);
            var file = FileOf(day);
            var tmp = file + ".tmp";
            using (var stream = new GZipStream(File.Create(tmp), CompressionLevel.Fastest))
                JsonSerializer.Serialize(stream, messages.Select(m => new Row(m.Id, m.Time, m.Text)).ToList());
            File.Move(tmp, file, overwrite: true);
            if (_prunedOn != today) { _prunedOn = today; Prune(today); }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not keep the Telegram day {Day} - it is asked of Telegram again next time.", day);
        }
    }

    private void Prune(DateOnly today)
    {
        var oldest = today.AddDays(-KeepDays);
        foreach (var file in Directory.EnumerateFiles(_root, "*.json.gz"))
        {
            var name = Path.GetFileName(file)[..^".json.gz".Length];
            if (DateOnly.TryParseExact(name, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day) && day < oldest)
            {
                try { File.Delete(file); } catch (IOException) { /* next time */ }
            }
        }
    }

    private string FileOf(DateOnly day) => Path.Combine(_root, $"{day:yyyy-MM-dd}.json.gz");
}

/// <summary>A message for the Telegram signals page: when, its text, how it went (`sent` / `failed` / `off` - the server's
/// log; `sent` for what Telegram holds) and where it came from (`server`, `cache`, `telegram`).</summary>
public sealed record TelegramSignalMessage(DateTimeOffset Time, string Text, string Status, string Source);

/// <summary>Where a day came from: `server` (the message log holds the whole day), `cache` (fetched from Telegram before),
/// `telegram` (fetched now - kept if a past day), `partial` (a fetch cut short at MaxMessages - not kept), `missing` (not on
/// the server and Telegram could not be read - `Note` says why).</summary>
public sealed record TelegramSignalDay(DateOnly Date, string Source, int Count, string? Note);

public sealed record TelegramSignalRead(DateOnly From, DateOnly To, IReadOnlyList<TelegramSignalDay> Days, IReadOnlyList<TelegramSignalMessage> Messages);

/// <summary>
/// The Telegram signals page's messages, SERVER FIRST (asked for - "server side + caching, if it is not there then telegram
/// fetch"): each IST day from the server's own log when it holds the whole day (`TelegramMessageLog.Covers`), else from the
/// days fetched from Telegram before (`TelegramDayCache`), else FETCHED FROM TELEGRAM (`TelegramChannelReader` - the days
/// not on the server only, consecutive ones in one request, at most its MaxDays each) and, a whole past day, kept. Telegram
/// not connected / not answering: those days are listed as missing with why, the rest still shown. At most MaxDays days.
/// </summary>
public sealed class TelegramSignalMessages
{
    public const int MaxDays = TelegramMessageLog.MaxDaysRead;

    private readonly TelegramMessageLog _log;
    private readonly TelegramDayCache _cache;
    private readonly TelegramChannelReader _reader;
    private readonly Func<DateOnly> _today;

    public TelegramSignalMessages(TelegramMessageLog log, TelegramDayCache cache, TelegramChannelReader reader)
        : this(log, cache, reader, IstClock.Today)
    {
    }

    internal TelegramSignalMessages(TelegramMessageLog log, TelegramDayCache cache, TelegramChannelReader reader, Func<DateOnly> today)
    {
        _log = log;
        _cache = cache;
        _reader = reader;
        _today = today;
    }

    public async Task<TelegramSignalRead> ReadAsync(DateOnly from, DateOnly to, CancellationToken cancellationToken)
    {
        var today = _today();
        if (to > today) to = today;
        if (from > to) (from, to) = (to, from);
        if (to.DayNumber - from.DayNumber >= MaxDays) from = to.AddDays(-(MaxDays - 1));

        var days = new SortedDictionary<DateOnly, TelegramSignalDay>();
        var messages = new List<TelegramSignalMessage>();
        var missing = new List<DateOnly>();
        for (var day = from; day <= to; day = day.AddDays(1))
        {
            if (_log.Covers(day))
            {
                var kept = _log.Read(day, day);
                messages.AddRange(kept.Select(m => new TelegramSignalMessage(m.Time, m.Text, m.Status, "server")));
                days[day] = new TelegramSignalDay(day, "server", kept.Count, null);
            }
            else if (_cache.Read(day) is { } cached)
            {
                messages.AddRange(cached.Select(m => new TelegramSignalMessage(m.Time, m.Text, "sent", "cache")));
                days[day] = new TelegramSignalDay(day, "cache", cached.Count, null);
            }
            else missing.Add(day);
        }

        string? stopped = null;
        foreach (var (first, last) in Runs(missing, TelegramChannelReader.MaxDays))
        {
            if (stopped is not null)
            {
                for (var d = first; d <= last; d = d.AddDays(1)) days[d] = new TelegramSignalDay(d, "missing", 0, stopped);
                continue;
            }
            IReadOnlyList<TelegramChannelMessage> got;
            try { got = await _reader.ReadAsync(first, last, cancellationToken); }
            catch (TelegramReaderException ex)
            {
                // Not connected, signed out, not answering: the same for every other run - not asked again in this load.
                stopped = $"Not on the server, and Telegram could not be read: {ex.Message}";
                for (var d = first; d <= last; d = d.AddDays(1)) days[d] = new TelegramSignalDay(d, "missing", 0, stopped);
                continue;
            }
            var cut = got.Count >= TelegramChannelReader.MaxMessages ? IstClock.IstDate(got[0].Time) : (DateOnly?)null;
            var byDay = got.GroupBy(m => IstClock.IstDate(m.Time)).ToDictionary(g => g.Key, g => g.ToList());
            for (var d = first; d <= last; d = d.AddDays(1))
            {
                var list = byDay.TryGetValue(d, out var l) ? l : [];
                messages.AddRange(list.Select(m => new TelegramSignalMessage(m.Time, m.Text, "sent", "telegram")));
                if (cut is { } c && d <= c)
                {
                    days[d] = new TelegramSignalDay(d, "partial", list.Count, $"Over {TelegramChannelReader.MaxMessages:N0} messages from here on - only the newest were read; ask for fewer days.");
                    continue;
                }
                if (d < today) _cache.Write(d, list, today);
                days[d] = new TelegramSignalDay(d, "telegram", list.Count, null);
            }
        }

        messages.Sort((a, b) => a.Time.CompareTo(b.Time));
        return new TelegramSignalRead(from, to, days.Values.ToList(), messages);
    }

    /// <summary>The days as runs of consecutive days, each at most `max` long.</summary>
    internal static IEnumerable<(DateOnly First, DateOnly Last)> Runs(IReadOnlyList<DateOnly> days, int max)
    {
        var k = 0;
        while (k < days.Count)
        {
            var first = days[k];
            var last = first;
            while (k + 1 < days.Count && days[k + 1] == last.AddDays(1) && last.DayNumber - first.DayNumber + 1 < max) last = days[++k];
            yield return (first, last);
            k++;
        }
    }
}

using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Threading.Channels;

namespace OptionAnalytics.Server.TrueData;

/// <summary>
/// TRUEDATA'S RAW TICKS ON DISK - its OWN store (asked for - "cache future and options data ticks ... separate cache store for TrueData ... in
/// compressed format because we are receiving ticks there"): <c>Storage:TrueDataTicksPath</c> (/app/data/truedata-ticks on the persistent
/// volume), nothing of the Dhan cache, the Order Flow days or the scanner runner's folder. Two kinds, one gzip CSV per CONTRACT and IST day,
/// in TrueData's own tick-history columns (<c>time,ltp,volume,oi,bid,bid_qty,ask,ask_qty</c>, volume = the day's running total) so
/// <see cref="TrueDataTickCsv"/> reads both:
/// <list type="bullet">
/// <item><c>live/{yyyy-MM-dd}/{SYMBOL}.csv.gz</c> - EVERY trade and quote the live feed applies, futures and options, recorded as it comes. The
/// file is COMPRESSED WHILE THE DAY RUNS: each flush (every <see cref="FlushEvery"/> or <see cref="FlushBytes"/> a file) is appended as its own
/// gzip member, and a gzip file of several members is one stream to every reader (.NET's GZipStream, zcat, 7-Zip). A crash loses at most the
/// last flush; a member cut short by a crash is the end of what is read.</item>
/// <item><c>history/{yyyy-MM-dd}/{SYMBOL}.csv.gz</c> - every whole-session tick-history answer of a PAST day (<see cref="CachingTrueDataHistoryApi"/>),
/// so a day is asked of TrueData once - and a day TrueData no longer keeps (the trial keeps today and the day before) replays from what was
/// recorded live.</item>
/// </list>
/// Nothing is ever deleted here. Recording never blocks the tick path: lines go into a bounded queue and one writer appends them; a full queue
/// drops the line and counts it (<see cref="Dropped"/>). No path configured = off, and a failed write is logged and counted, never thrown.
/// </summary>
public sealed class TrueDataTickStore : IAsyncDisposable
{
    public static readonly TimeSpan FlushEvery = TimeSpan.FromSeconds(5);
    public const int FlushBytes = 256 * 1024;
    public const int QueueCapacity = 500_000;
    public const string Header = "time,ltp,volume,oi,bid,bid_qty,ask,ask_qty";
    private static readonly TimeSpan Ist = TimeSpan.FromMinutes(330);

    private readonly string _root;
    private readonly ILogger _logger;
    private readonly Channel<(string Symbol, DateOnly Day, string Line)> _queue =
        Channel.CreateBounded<(string, DateOnly, string)>(new BoundedChannelOptions(QueueCapacity) { SingleReader = true, FullMode = BoundedChannelFullMode.DropWrite });
    // The last trade a contract had - a quote line carries it on (its ltp / volume / oi), so the line is a whole tick.
    private readonly Dictionary<string, (decimal Ltp, long Volume, long Oi)> _last = new(StringComparer.Ordinal);
    private readonly object _lastLock = new();
    private readonly CancellationTokenSource _stop = new();
    private readonly Task _writer;
    private long _recorded, _dropped, _writeErrors, _bytesWritten;

    public TrueDataTickStore(string root, ILogger logger)
    {
        _root = root;
        _logger = logger;
        _writer = Enabled ? Task.Run(() => WriteLoopAsync(_stop.Token)) : Task.CompletedTask;
    }

    internal static string ResolveRoot(string? path, string contentRoot) =>
        string.IsNullOrWhiteSpace(path) ? "" : Path.IsPathRooted(path) ? path : Path.Combine(contentRoot, path);

    public bool Enabled => _root.Length > 0;
    public string Root => _root;
    public long Recorded => Interlocked.Read(ref _recorded);
    public long Dropped => Interlocked.Read(ref _dropped);
    public long WriteErrors => Interlocked.Read(ref _writeErrors);
    public long BytesWritten => Interlocked.Read(ref _bytesWritten);

    public string LiveFile(string symbol, DateOnly day) => Path.Combine(_root, "live", day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), Safe(symbol) + ".csv.gz");
    public string HistoryFile(string symbol, DateOnly day) => Path.Combine(_root, "history", day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), Safe(symbol) + ".csv.gz");

    private static string Safe(string symbol)
    {
        var s = new StringBuilder(symbol.Length);
        foreach (var c in symbol.Trim().ToUpperInvariant()) s.Append(char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '_');
        return s.Length == 0 ? "_" : s.ToString();
    }

    // ---------------- LIVE: what the feed applies ----------------

    /// <summary>A trade of <paramref name="symbol"/> (a futures contract or an option) as the feed applied it.</summary>
    public void RecordTrade(string symbol, DateTimeOffset time, decimal ltp, long totalVolume, long oi, decimal bid, long bidQty, decimal ask, long askQty)
    {
        if (!Enabled || string.IsNullOrEmpty(symbol)) return;
        lock (_lastLock) _last[symbol] = (ltp, totalVolume, oi);
        Enqueue(symbol, time, ltp, totalVolume, oi, bid, bidQty, ask, askQty);
    }

    /// <summary>A quote of <paramref name="symbol"/> - written with the contract's last trade (ltp / volume / oi), so its volume does not rise.</summary>
    public void RecordQuote(string symbol, DateTimeOffset time, decimal bid, long bidQty, decimal ask, long askQty)
    {
        if (!Enabled || string.IsNullOrEmpty(symbol)) return;
        (decimal Ltp, long Volume, long Oi) last;
        lock (_lastLock) _last.TryGetValue(symbol, out last);
        Enqueue(symbol, time, last.Ltp, last.Volume, last.Oi, bid, bidQty, ask, askQty);
    }

    private void Enqueue(string symbol, DateTimeOffset time, decimal ltp, long volume, long oi, decimal bid, long bidQty, decimal ask, long askQty)
    {
        var ist = time.ToOffset(Ist);
        var line = string.Create(CultureInfo.InvariantCulture,
            $"{ist:yyyy-MM-dd HH:mm:ss.fff},{ltp},{volume},{oi},{bid},{bidQty},{ask},{askQty}");
        if (_queue.Writer.TryWrite((symbol, DateOnly.FromDateTime(ist.DateTime), line))) Interlocked.Increment(ref _recorded);
        else Interlocked.Increment(ref _dropped);
    }

    private sealed class Pending { public readonly StringBuilder Text = new(); public DateTime Since = DateTime.UtcNow; }

    private async Task WriteLoopAsync(CancellationToken token)
    {
        var pending = new Dictionary<(string, DateOnly), Pending>();
        var reader = _queue.Reader;
        while (true)
        {
            var more = true;
            try
            {
                using var tick = CancellationTokenSource.CreateLinkedTokenSource(token);
                tick.CancelAfter(TimeSpan.FromSeconds(1));
                more = await reader.WaitToReadAsync(tick.Token);
            }
            catch (OperationCanceledException) when (!token.IsCancellationRequested) { }
            catch (OperationCanceledException) { more = false; }
            while (reader.TryRead(out var item))
            {
                if (!pending.TryGetValue((item.Symbol, item.Day), out var p)) pending[(item.Symbol, item.Day)] = p = new Pending();
                p.Text.Append(item.Line).Append('\n');
                if (p.Text.Length >= FlushBytes) { Flush(item.Symbol, item.Day, p); pending.Remove((item.Symbol, item.Day)); }
            }
            var now = DateTime.UtcNow;
            foreach (var key in pending.Where(kv => !more || token.IsCancellationRequested || now - kv.Value.Since >= FlushEvery).Select(kv => kv.Key).ToList())
            {
                Flush(key.Item1, key.Item2, pending[key]);
                pending.Remove(key);
            }
            if (!more || token.IsCancellationRequested && !reader.TryPeek(out _)) break;
        }
        foreach (var (key, p) in pending) Flush(key.Item1, key.Item2, p);
    }

    /// <summary>Appends one gzip member to the contract's day file (the header first when the file is new).</summary>
    private void Flush(string symbol, DateOnly day, Pending p)
    {
        if (p.Text.Length == 0) return;
        try
        {
            var file = LiveFile(symbol, day);
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            var isNew = !File.Exists(file) || new FileInfo(file).Length == 0;
            using var stream = new FileStream(file, FileMode.Append, FileAccess.Write, FileShare.Read);
            var before = stream.Position;
            using (var gz = new GZipStream(stream, CompressionLevel.Optimal, leaveOpen: true))
            {
                var text = isNew ? Header + "\n" + p.Text : p.Text.ToString();
                var bytes = Encoding.UTF8.GetBytes(text);
                gz.Write(bytes, 0, bytes.Length);
            }
            stream.Flush(true);
            Interlocked.Add(ref _bytesWritten, stream.Position - before);
        }
        catch (Exception ex)
        {
            if (Interlocked.Increment(ref _writeErrors) == 1 || _writeErrors % 1000 == 0)
                _logger.LogWarning(ex, "TrueData ticks of {Symbol} {Day} could not be written ({Errors} write errors).", symbol, day, _writeErrors);
        }
    }

    /// <summary>Writes everything queued so far (the tests, and before a read of today's file).</summary>
    internal async Task DrainAsync()
    {
        for (var i = 0; i < 200 && _queue.Reader.Count > 0; i++) await Task.Delay(10);
        await Task.Delay(FlushEvery + TimeSpan.FromSeconds(1.2));
    }

    public async ValueTask DisposeAsync()
    {
        _queue.Writer.TryComplete();
        _stop.Cancel();
        try { await _writer.WaitAsync(TimeSpan.FromSeconds(10)); } catch { /* shutting down */ }
        _stop.Dispose();
    }

    // ---------------- READ ----------------

    /// <summary>The CSV text of a contract's day as recorded live (every gzip member), or null.</summary>
    public string? ReadLive(string symbol, DateOnly day) => ReadGzip(LiveFile(symbol, day));

    /// <summary>A past day's tick history as TrueData answered it, or null.</summary>
    public string? ReadHistory(string symbol, DateOnly day) => ReadGzip(HistoryFile(symbol, day));

    private string? ReadGzip(string file)
    {
        if (!Enabled || !File.Exists(file)) return null;
        try
        {
            using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var gz = new GZipStream(stream, CompressionMode.Decompress);
            using var text = new StreamReader(gz, Encoding.UTF8);
            var sb = new StringBuilder();
            var buffer = new char[64 * 1024];
            try { int n; while ((n = text.Read(buffer, 0, buffer.Length)) > 0) sb.Append(buffer, 0, n); }
            catch (InvalidDataException) { /* a member cut short by a crash - what came before it is kept */ }
            catch (EndOfStreamException) { }
            return sb.Length == 0 ? null : sb.ToString();
        }
        catch (Exception ex) { _logger.LogWarning(ex, "TrueData ticks {File} could not be read.", file); return null; }
    }

    /// <summary>Keeps a PAST day's tick history answer (a CSV with ticks); today and later are never kept. Whole file, moved into place.</summary>
    public bool WriteHistory(string symbol, DateOnly day, string csv)
    {
        if (!Enabled || day >= IstClock.Today() || string.IsNullOrEmpty(csv) || !csv.Contains(',')) return false;
        try
        {
            var file = HistoryFile(symbol, day);
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            var temp = file + ".tmp";
            using (var stream = File.Create(temp))
            using (var gz = new GZipStream(stream, CompressionLevel.Optimal))
            {
                var bytes = Encoding.UTF8.GetBytes(csv);
                gz.Write(bytes, 0, bytes.Length);
            }
            File.Move(temp, file, true);
            return true;
        }
        catch (Exception ex) { _logger.LogWarning(ex, "TrueData tick history {Symbol} {Day} could not be kept.", symbol, day); return false; }
    }

    /// <summary>What is kept, a day at a time (the newest first): files and bytes of each kind.</summary>
    public IReadOnlyList<TickStoreDay> Days()
    {
        if (!Enabled) return Array.Empty<TickStoreDay>();
        var days = new SortedDictionary<string, TickStoreDay>(StringComparer.Ordinal);
        foreach (var kind in new[] { "live", "history" })
        {
            var dir = Path.Combine(_root, kind);
            if (!Directory.Exists(dir)) continue;
            foreach (var dayDir in Directory.EnumerateDirectories(dir))
            {
                var name = Path.GetFileName(dayDir);
                var files = Directory.EnumerateFiles(dayDir, "*.csv.gz").Select(f => new FileInfo(f)).ToList();
                var d = days.TryGetValue(name, out var x) ? x : new TickStoreDay(name, 0, 0, 0, 0);
                days[name] = kind == "live"
                    ? d with { LiveFiles = files.Count, LiveBytes = files.Sum(f => f.Length) }
                    : d with { HistoryFiles = files.Count, HistoryBytes = files.Sum(f => f.Length) };
            }
        }
        return days.Values.Reverse().ToList();
    }
}

public sealed record TickStoreDay(string Date, int LiveFiles, long LiveBytes, int HistoryFiles, long HistoryBytes);

/// <summary>
/// TrueData's tick history read THROUGH the tick store: a past day asked for a window inside one session is read from disk when it was kept (the
/// window's lines only - no TrueData call); otherwise TrueData is asked and a whole-session answer with ticks is kept. When TrueData has no ticks
/// for a past day (it keeps only the last few), the day as RECORDED LIVE stands in - so replay goes on past TrueData's own history.
/// </summary>
public sealed class CachingTrueDataHistoryApi : ITrueDataHistoryApi
{
    private static readonly TimeSpan SessionOpen = new(9, 15, 0), SessionClose = new(15, 30, 0);
    private readonly ITrueDataHistoryApi _inner;
    private readonly TrueDataTickStore _store;

    public CachingTrueDataHistoryApi(ITrueDataHistoryApi inner, TrueDataTickStore store) { _inner = inner; _store = store; }

    public async Task<string> GetTicksWithBidAskAsync(string symbol, DateTime fromIst, DateTime toIst, CancellationToken cancellationToken)
    {
        var day = DateOnly.FromDateTime(fromIst);
        var past = _store.Enabled && DateOnly.FromDateTime(toIst) == day && day < IstClock.Today();
        if (past && _store.ReadHistory(symbol, day) is { } kept) return Window(kept, fromIst, toIst);
        string csv;
        try { csv = await _inner.GetTicksWithBidAskAsync(symbol, fromIst, toIst, cancellationToken); }
        catch (Exception) when (past && _store.ReadLive(symbol, day) is not null && !cancellationToken.IsCancellationRequested)
        {
            return Window(_store.ReadLive(symbol, day)!, fromIst, toIst);
        }
        if (past)
        {
            var ticks = TrueDataTickCsv.Parse(csv).Ticks.Count;
            if (ticks > 0 && fromIst.TimeOfDay <= SessionOpen && toIst.TimeOfDay >= SessionClose) _store.WriteHistory(symbol, day, csv);
            else if (ticks == 0 && _store.ReadLive(symbol, day) is { } live) return Window(live, fromIst, toIst);
        }
        return csv;
    }

    /// <summary>The header and the lines whose time is inside the window.</summary>
    internal static string Window(string csv, DateTime fromIst, DateTime toIst)
    {
        var sb = new StringBuilder(csv.Length);
        var first = true;
        foreach (var raw in csv.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (line.Length == 0) continue;
            if (first) { first = false; if (!char.IsDigit(line[0])) { sb.Append(line).Append('\n'); continue; } }
            var comma = line.IndexOf(',');
            if (comma > 0 && DateTime.TryParse(line[..comma], CultureInfo.InvariantCulture, DateTimeStyles.None, out var t) && (t < fromIst || t > toIst)) continue;
            sb.Append(line).Append('\n');
        }
        return sb.ToString();
    }
}

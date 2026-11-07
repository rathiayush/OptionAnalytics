using System.Collections.Concurrent;
using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Services.OrderFlow;

/// <summary>
/// The order flow days the Order Flow page can replay EXACTLY - the footprint, imbalances, stacked imbalances, the tape and
/// the book as the live engine recorded them - instead of the estimate rebuilt from Dhan's 1-minute candles (which has no
/// per-price trades, so no imbalances at all).
///
/// MEMORY: the newest OrderFlow:DaysInMemory days (default 3), handed over by OrderFlowService when an engine rolls into a
/// new day or is replaced at a futures rollover.
///
/// DISK (Storage:OrderFlowPath - the persistent volume; none configured = memory only, as before): every day kept, ONE GZIP
/// JSON FILE PER CONTRACT AND DAY ({root}/{UNDERLYING}/{securityId}/{yyyy-MM-dd}.json.gz, the contract's name beside them),
/// the newest OrderFlow:DaysOnDisk dates (default 30) - so a deploy / restart no longer turns every past day into an
/// estimate. TODAY is saved too while it is recorded (OrderFlowService's checkpoints, every few minutes and at shutdown) and
/// read back into the new engine at start (LoadSaved -> OrderFlowEngine.ImportDay), so a deploy mid-session keeps the
/// morning exact; only the minutes the server was down are missing.
///
/// Writes go through ONE background queue (never on an engine's lock or the tick path - a day is megabytes); a day read
/// from disk is kept for the next asks (a replay asks for its tape at every step).
/// </summary>
public sealed class OrderFlowDayStore : IDisposable
{
    private const int LoadedKept = 4;

    private readonly int _maxDays;
    private readonly int _daysOnDisk;
    private readonly string? _root;
    private readonly ILogger _logger;
    private readonly LiveEventQueue<OrderFlowDay>? _writer;
    private readonly object _fileLock = new();
    // Per contract: "{UNDERLYING}:{securityId}".
    private readonly ConcurrentDictionary<string, SortedDictionary<DateOnly, OrderFlowEngine>> _days = new(StringComparer.OrdinalIgnoreCase);
    // Days read back from disk (not in memory's newest few) - the last few asked for.
    private readonly ConcurrentDictionary<(string Key, DateOnly Date), (OrderFlowEngine Engine, long At)> _loaded = new();
    private long _loadClock;

    public OrderFlowDayStore(IConfiguration? configuration = null, ILogger<OrderFlowDayStore>? logger = null)
        : this(configuration, logger, startWriter: true) { }

    /// <summary>`startWriter` false: nothing is written until FlushForTests (tests).</summary>
    internal OrderFlowDayStore(IConfiguration? configuration, ILogger<OrderFlowDayStore>? logger, bool startWriter)
    {
        _logger = (ILogger?)logger ?? NullLogger.Instance;
        _maxDays = Math.Clamp(configuration?.GetValue("OrderFlow:DaysInMemory", 3) ?? 3, 0, 30);
        _daysOnDisk = Math.Clamp(configuration?.GetValue("OrderFlow:DaysOnDisk", 30) ?? 30, 1, 400);
        var root = configuration?["Storage:OrderFlowPath"];
        if (string.IsNullOrWhiteSpace(root)) return;
        try
        {
            Directory.CreateDirectory(root);
            _root = root;
            _writer = new LiveEventQueue<OrderFlowDay>("Order flow days", WriteDay, _logger, 64, startWriter);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Order flow days cannot be kept on disk at {Path} - memory only.", root);
        }
    }

    /// <summary>Whether days are kept on disk.</summary>
    public bool OnDisk => _root is not null;

    /// <summary>The folder the days are kept in (null = memory only) - the admin Cache page lists it (CacheBrowser).</summary>
    public string? Root => _root;

    /// <summary>Drops the days read back from disk (the Cache page deleted files - a day asked again is read again, or not
    /// found). The days the server holds in memory - today's live engine among them - are untouched.</summary>
    public void ForgetLoaded() => _loaded.Clear();

    private static string Key(string underlying, uint securityId) => $"{underlying.ToUpperInvariant()}:{securityId}";

    /// <summary>Keeps a finished day for replay, replacing any held for the same contract and date - in memory and on disk.</summary>
    public void Add(OrderFlowDay day)
    {
        if (day.Bars.Count == 0 && day.Snapshots.Count == 0) return;
        Save(day);
        if (_maxDays == 0) return;
        var days = _days.GetOrAdd(Key(day.Underlying, day.SecurityId), _ => new SortedDictionary<DateOnly, OrderFlowEngine>());
        var engine = OrderFlowEngine.FromDay(day);
        lock (days)
        {
            days[day.Day] = engine;
            while (days.Count > _maxDays) days.Remove(days.Keys.First());
        }
        _loaded.TryRemove((Key(day.Underlying, day.SecurityId), day.Day), out _);
        EvictOlderDates();
    }

    /// <summary>Writes a day to disk on the background queue (today's checkpoint, or a finished day) - returns at once.</summary>
    public void Save(OrderFlowDay day)
    {
        if (_writer is null || day.Bars.Count == 0 && day.Snapshots.Count == 0) return;
        _writer.Enqueue(day);
    }

    /// <summary>Writes a day to disk now, on the caller's thread (the shutdown checkpoint - nothing after it runs).</summary>
    public void SaveNow(OrderFlowDay day)
    {
        if (_root is null || day.Bars.Count == 0 && day.Snapshots.Count == 0) return;
        WriteDay(day);
    }

    /// <summary>Tests: writes everything queued on the calling thread.</summary>
    internal void FlushForTests() => _writer?.Drain();

    /// <summary>A day kept on disk (null when none) - what a new engine starts today from (OrderFlowEngine.ImportDay).</summary>
    public OrderFlowDay? LoadSaved(string underlying, uint securityId, DateOnly date)
    {
        if (_root is null) return null;
        var path = DayPath(underlying, securityId, date);
        if (!File.Exists(path)) return null;
        try
        {
            lock (_fileLock)
            {
                using var file = File.OpenRead(path);
                using var gzip = new GZipStream(file, CompressionMode.Decompress);
                return JsonSerializer.Deserialize<OrderFlowDay>(gzip, Json);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Order flow day {Path} could not be read.", path);
            return null;
        }
    }

    /// <summary>Keeps only the newest DaysInMemory trading dates across EVERY contract: per-contract
    /// limits alone would keep an expired contract's last days forever (a new futures contract gets a
    /// new key each month), growing the server's memory month after month.</summary>
    private void EvictOlderDates()
    {
        var keep = _days.Values.SelectMany(d => { lock (d) return d.Keys.ToList(); }).Distinct().OrderByDescending(d => d).Take(_maxDays).ToHashSet();
        foreach (var (key, days) in _days)
        {
            lock (days)
            {
                foreach (var date in days.Keys.Where(d => !keep.Contains(d)).ToList()) days.Remove(date);
                if (days.Count == 0) _days.TryRemove(key, out _);
            }
        }
    }

    /// <summary>The day's engine - memory, else read from disk (and kept for the next asks); null when the day is not kept.</summary>
    public OrderFlowEngine? EngineFor(string underlying, uint securityId, DateOnly date)
    {
        var key = Key(underlying, securityId);
        if (_days.TryGetValue(key, out var days))
            lock (days) if (days.TryGetValue(date, out var engine)) return engine;
        if (_root is null) return null;
        if (_loaded.TryGetValue((key, date), out var hit))
        {
            _loaded[(key, date)] = (hit.Engine, Interlocked.Increment(ref _loadClock));
            return hit.Engine;
        }
        if (LoadSaved(underlying, securityId, date) is not { } saved) return null;
        var loaded = OrderFlowEngine.FromDay(saved);
        _loaded[(key, date)] = (loaded, Interlocked.Increment(ref _loadClock));
        while (_loaded.Count > LoadedKept) _loaded.TryRemove(_loaded.OrderBy(kv => kv.Value.At).First().Key, out _);
        return loaded;
    }

    /// <summary>The days held for an underlying (every contract, memory and disk), newest first.</summary>
    public IReadOnlyList<(DateOnly Date, string ContractSymbol, DateOnly? Expiry)> Days(string underlying)
    {
        var prefix = underlying.ToUpperInvariant() + ":";
        var result = new Dictionary<(DateOnly, string), (DateOnly, string, DateOnly?)>();
        foreach (var (key, days) in _days)
        {
            if (!key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
            lock (days) foreach (var kv in days) result[(kv.Key, kv.Value.ContractSymbol)] = (kv.Key, kv.Value.ContractSymbol, kv.Value.Expiry);
        }
        if (_root is not null)
        {
            var folder = Path.Combine(_root, underlying.ToUpperInvariant());
            if (Directory.Exists(folder))
            {
                foreach (var contractDir in Directory.EnumerateDirectories(folder))
                {
                    var contract = ReadContract(contractDir);
                    if (contract is null) continue;
                    foreach (var file in Directory.EnumerateFiles(contractDir, "*.json.gz"))
                        if (DateOnly.TryParseExact(Path.GetFileName(file)[..^".json.gz".Length], "yyyy-MM-dd", out var date))
                            result.TryAdd((date, contract.ContractSymbol), (date, contract.ContractSymbol, contract.Expiry));
                }
            }
        }
        return result.Values.OrderByDescending(d => d.Item1).ToList();
    }

    // ---- disk -----------------------------------------------------------------------------------------------------

    private sealed record ContractFile(string ContractSymbol, DateOnly? Expiry);

    private string ContractDir(string underlying, uint securityId) => Path.Combine(_root!, underlying.ToUpperInvariant(), securityId.ToString());
    private string DayPath(string underlying, uint securityId, DateOnly date) => Path.Combine(ContractDir(underlying, securityId), $"{date:yyyy-MM-dd}.json.gz");

    private static ContractFile? ReadContract(string dir)
    {
        try { return JsonSerializer.Deserialize<ContractFile>(File.ReadAllText(Path.Combine(dir, "contract.json")), Json); }
        catch { return null; }
    }

    // The background writer: the whole day to a temporary file, moved into place (a reader never sees half a day), then
    // the dates past DaysOnDisk removed.
    private void WriteDay(OrderFlowDay day)
    {
        var dir = ContractDir(day.Underlying, day.SecurityId);
        var path = DayPath(day.Underlying, day.SecurityId, day.Day);
        try
        {
            Directory.CreateDirectory(dir);
            var temp = path + ".tmp";
            using (var file = File.Create(temp))
            using (var gzip = new GZipStream(file, CompressionLevel.Fastest))
                JsonSerializer.Serialize(gzip, day, Json);
            lock (_fileLock)
            {
                File.Move(temp, path, overwrite: true);
                File.WriteAllText(Path.Combine(dir, "contract.json"), JsonSerializer.Serialize(new ContractFile(day.ContractSymbol, day.Expiry), Json));
            }
            _loaded.TryRemove((Key(day.Underlying, day.SecurityId), day.Day), out _);
            TrimDisk();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Order flow day {Day} of {Contract} could not be kept on disk.", day.Day, day.ContractSymbol);
        }
    }

    // The newest DaysOnDisk dates across every contract stay; older files (and emptied folders) go.
    private void TrimDisk()
    {
        var files = Directory.EnumerateFiles(_root!, "*.json.gz", SearchOption.AllDirectories)
            .Select(f => (Path: f, Ok: DateOnly.TryParseExact(Path.GetFileName(f)[..^".json.gz".Length], "yyyy-MM-dd", out var d), Date: d))
            .Where(f => f.Ok).ToList();
        var keep = files.Select(f => f.Date).Distinct().OrderByDescending(d => d).Take(_daysOnDisk).ToHashSet();
        foreach (var f in files.Where(f => !keep.Contains(f.Date)))
        {
            try { lock (_fileLock) File.Delete(f.Path); } catch { /* next write tries again */ }
            var dir = Path.GetDirectoryName(f.Path)!;
            try { if (!Directory.EnumerateFiles(dir, "*.json.gz").Any()) Directory.Delete(dir, recursive: true); } catch { /* best effort */ }
        }
    }

    // A heatmap row as [row, quantity] - a day holds thousands of book snapshots of dozens of rows each.
    private sealed class HeatRowConverter : JsonConverter<HeatRow>
    {
        public override HeatRow Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        {
            if (reader.TokenType != JsonTokenType.StartArray) throw new JsonException("A heatmap row is [row, quantity].");
            reader.Read(); var row = reader.GetInt32();
            reader.Read(); var quantity = reader.GetInt32();
            reader.Read();
            return new HeatRow(row, quantity);
        }

        public override void Write(Utf8JsonWriter writer, HeatRow value, JsonSerializerOptions options)
        {
            writer.WriteStartArray();
            writer.WriteNumberValue(value.Row);
            writer.WriteNumberValue(value.Quantity);
            writer.WriteEndArray();
        }
    }

    private static readonly JsonSerializerOptions Json = new() { Converters = { new HeatRowConverter() } };

    public void Dispose() => _writer?.Dispose();
}

using System.IO.Compression;
using System.Text.Json;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Keeps OiReplayService.RunAsync's answers so the same day is not paid for twice - each answer is 42 Dhan
/// rolling-option calls (ATM+-10, CE and PE) on a server with no stored database, and the same day is asked for
/// by many callers: the OI Replay page, the Order Flow page (and both of them at once when their days are synced),
/// the server's own scanner for three indices, a scan-day, every reload and every open tab.
///
///   - A PAST day does not change once it is complete, so a complete answer is kept in memory (the last
///     MaxPastInMemory days) and, when Storage:OiDayCachePath is set, on disk too - it outlives a restart. Only a
///     complete day is kept: successful, no strike series that failed, CE and PE present, and at least
///     MinPastSpotMinutes of spot (a day still being backfilled is asked for again next time).
///   - TODAY is a seed the live tick feed then carries forward, so it may be TodayTtl old: requests arriving
///     together (several pages, the scanner for each index, a reconnect storm) share one Dhan fetch, and a page
///     reload a few seconds later gets the same answer.
///   - Either way, identical requests in flight at once share one fetch.
/// </summary>
public sealed class OiDayCache
{
    internal const int MaxPastInMemory = 12;
    internal const int MaxDiskDays = 600;
    internal const int MinPastSpotMinutes = 300;
    internal static readonly TimeSpan TodayTtl = TimeSpan.FromSeconds(30);

    private readonly string? _dir;
    private readonly int _minSpotMinutes;
    private readonly ILogger<OiDayCache>? _logger;
    private readonly object _lock = new();
    private readonly Dictionary<string, (OiReplayResult Result, DateTimeOffset At)> _memory = new();
    private readonly Dictionary<string, Task<OiReplayResult>> _inFlight = new();
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>Answers served without a Dhan fetch (memory or disk) - read by the tests and the usage endpoint.</summary>
    public long Hits => Interlocked.Read(ref _hits);
    private long _hits;

    public OiDayCache(IConfiguration? configuration = null, ILogger<OiDayCache>? logger = null) : this(configuration, logger, MinPastSpotMinutes) { }

    /// <summary>minSpotMinutes: how much of a past day's spot makes it complete (tests use short synthetic days).</summary>
    internal OiDayCache(IConfiguration? configuration, ILogger<OiDayCache>? logger, int minSpotMinutes)
    {
        _minSpotMinutes = minSpotMinutes;
        _logger = logger;
        var dir = configuration?["Storage:OiDayCachePath"];
        if (!string.IsNullOrWhiteSpace(dir))
        {
            try { Directory.CreateDirectory(dir); _dir = dir; }
            catch (Exception ex) { _logger?.LogWarning(ex, "OI day cache directory {Dir} could not be created - keeping days in memory only.", dir); }
        }
    }

    /// <summary>The day's answer: kept, shared with an identical request in flight, or fetched by <paramref name="fetch"/>.</summary>
    public async Task<OiReplayResult> GetAsync(string underlying, DateOnly date, int timeframe, string expiryFlag, bool forceLive,
        Func<CancellationToken, Task<OiReplayResult>> fetch, CancellationToken cancellationToken)
    {
        var today = IstClock.Today();
        var past = date < today;
        // forceLive only matters for today (a stored-first answer and a live one can differ); a past day is one key.
        var key = $"{underlying}|{date:yyyy-MM-dd}|{expiryFlag}|{timeframe}|{(past ? "" : forceLive ? "live" : "stored")}".ToUpperInvariant();

        Task<OiReplayResult> task;
        lock (_lock)
        {
            if (_memory.TryGetValue(key, out var kept) && (past || DateTimeOffset.UtcNow - kept.At <= TodayTtl))
            {
                Interlocked.Increment(ref _hits);
                return kept.Result;
            }
            if (!_inFlight.TryGetValue(key, out task!))
            {
                // Not tied to one caller's token: a request that gives up must not cancel the fetch the others wait on.
                // Started on the pool, never inline: a fetch that finished synchronously inside this lock would remove
                // its in-flight entry BEFORE it is added, leaving a finished task there for good.
                task = Task.Run(() => FetchAsync(key, past, underlying, date, fetch));
                _inFlight[key] = task;
            }
            else Interlocked.Increment(ref _hits);
        }
        return await task.WaitAsync(cancellationToken);
    }

    private async Task<OiReplayResult> FetchAsync(string key, bool past, string underlying, DateOnly date, Func<CancellationToken, Task<OiReplayResult>> fetch)
    {
        try
        {
            if (past && ReadDisk(key) is { } fromDisk)
            {
                Interlocked.Increment(ref _hits);
                Remember(key, fromDisk);
                return fromDisk;
            }
            var result = await fetch(CancellationToken.None);
            if (!past) { if (result.Success) Remember(key, result); }
            else if (IsComplete(result))
            {
                Remember(key, result);
                WriteDisk(key, result);
            }
            return result;
        }
        finally
        {
            lock (_lock) _inFlight.Remove(key);
        }
    }

    /// <summary>A past day worth keeping for good: nothing missing that a later fetch could still fill in.</summary>
    internal bool IsComplete(OiReplayResult r) =>
        r.Success && r.OptionErrors.Count == 0 && r.CePoints.Count > 0 && r.PePoints.Count > 0
        && (r.SpotCandlesOneMinute?.Count ?? 0) >= _minSpotMinutes;

    private void Remember(string key, OiReplayResult result)
    {
        lock (_lock)
        {
            _memory[key] = (result, DateTimeOffset.UtcNow);
            // Today's entries expire by time; past days are bounded by count (a day is a few MB in memory).
            foreach (var stale in _memory.Where(kv => !IsPastKey(kv.Key) && DateTimeOffset.UtcNow - kv.Value.At > TodayTtl).Select(kv => kv.Key).ToList())
                _memory.Remove(stale);
            while (_memory.Count(kv => IsPastKey(kv.Key)) > MaxPastInMemory)
                _memory.Remove(_memory.Where(kv => IsPastKey(kv.Key)).OrderBy(kv => kv.Value.At).First().Key);
        }
    }

    private static bool IsPastKey(string key) => key.EndsWith('|');

    private string? PathOf(string key) => _dir is null ? null : System.IO.Path.Combine(_dir, key.TrimEnd('|').Replace('|', '_') + ".json.gz");

    private OiReplayResult? ReadDisk(string key)
    {
        if (PathOf(key) is not { } path || !File.Exists(path)) return null;
        try
        {
            using var file = File.OpenRead(path);
            using var gzip = new GZipStream(file, CompressionMode.Decompress);
            var result = JsonSerializer.Deserialize<OiReplayResult>(gzip, Json);
            return result is not null && IsComplete(result) ? result : null;
        }
        catch (Exception ex)
        {
            _logger?.LogWarning(ex, "OI day cache file {Path} could not be read - fetching the day again.", path);
            return null;
        }
    }

    private void WriteDisk(string key, OiReplayResult result)
    {
        if (PathOf(key) is not { } path) return;
        try
        {
            var temp = path + ".tmp";
            using (var file = File.Create(temp))
            using (var gzip = new GZipStream(file, CompressionLevel.Fastest))
                JsonSerializer.Serialize(gzip, result, Json);
            File.Move(temp, path, overwrite: true);
            // Bounded: the oldest-written days go once there are more than MaxDiskDays (a day is ~1-2 MB compressed).
            var files = new DirectoryInfo(_dir!).GetFiles("*.json.gz");
            if (files.Length > MaxDiskDays)
                foreach (var old in files.OrderBy(f => f.LastWriteTimeUtc).Take(files.Length - MaxDiskDays)) old.Delete();
        }
        catch (Exception ex)
        {
            _logger?.LogWarning(ex, "OI day cache file {Path} could not be written - the day stays in memory only.", path);
        }
    }
}

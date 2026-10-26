using System.Collections.Concurrent;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// What one OI Replay day load is doing, step by step - for the page's progress panel (GET
/// /api/oi-replay/progress/{id}): how many of the series are done, how many came from disk or from Dhan, which Dhan
/// calls were rate-limited, retried or failed, and a running log of each.
///
/// Recorded through an AsyncLocal (<see cref="Use"/>), so the Dhan services deep below the load (the rolling-option and
/// candle fetches, the rate limiter) add to it with no extra parameters - a call made outside a load records nothing.
/// </summary>
public sealed class LoadProgress
{
    private const int MaxEntries = 400;
    private static readonly AsyncLocal<LoadProgress?> CurrentLoad = new();

    private readonly object _lock = new();
    private readonly List<Entry> _entries = new();
    private readonly System.Diagnostics.Stopwatch _clock = System.Diagnostics.Stopwatch.StartNew();
    private int _total, _done, _failed, _fromDisk, _dhanCalls, _rateLimited, _retries, _savedToDisk, _diskErrors;
    // Every entry ever added - the page's cursor (the oldest drop off the front past MaxEntries).
    private int _added;
    private string _stage = "starting";
    private bool _finished;
    private string? _error;

    public LoadProgress(string id) => Id = id;

    public string Id { get; }
    public DateTimeOffset StartedUtc { get; } = DateTimeOffset.UtcNow;
    public bool Finished { get { lock (_lock) return _finished; } }

    public sealed record Entry(double At, string Level, string Text);

    /// <summary>The load the current async flow belongs to, if any.</summary>
    public static LoadProgress? Current => CurrentLoad.Value;

    /// <summary>Records the rest of the current async flow (and everything it starts) on <paramref name="progress"/>.</summary>
    public static IDisposable Use(LoadProgress? progress)
    {
        var before = CurrentLoad.Value;
        CurrentLoad.Value = progress;
        return new Restore(before);
    }

    private sealed class Restore(LoadProgress? before) : IDisposable
    {
        public void Dispose() => CurrentLoad.Value = before;
    }

    // The static helpers below are what the services call - each a no-op outside a load.
    public static void Info(string text) => Current?.Add("info", text);
    public static void Ok(string text) => Current?.Add("ok", text);
    public static void Warn(string text) => Current?.Add("warn", text);
    public static void Error(string text) => Current?.Add("error", text);
    public static void Stage(string stage) { if (Current is { } p) lock (p._lock) p._stage = stage; }
    public static void AddTotal(int count) { if (Current is { } p) lock (p._lock) p._total += count; }
    public static void Done(bool failed) { if (Current is { } p) lock (p._lock) { p._done++; if (failed) p._failed++; } }
    /// <summary>A series that had failed came back on a later try.</summary>
    public static void Recovered() { if (Current is { } p) lock (p._lock) p._failed = Math.Max(0, p._failed - 1); }
    public static void FromDisk() { if (Current is { } p) lock (p._lock) p._fromDisk++; }
    public static void DhanCall() { if (Current is { } p) lock (p._lock) p._dhanCalls++; }
    /// <summary>A past day Dhan sent was written to the disk cache (DhanDataCache) - the next load reads it from there.</summary>
    public static void SavedToDisk() { if (Current is { } p) lock (p._lock) p._savedToDisk++; }
    /// <summary>A past day could not be written to the disk cache - it will be asked of Dhan again next time.</summary>
    public static void DiskError(string text) { if (Current is { } p) { lock (p._lock) p._diskErrors++; p.Add("error", text); } }
    public static void RateLimited() { if (Current is { } p) lock (p._lock) p._rateLimited++; }
    public static void Retry() { if (Current is { } p) lock (p._lock) p._retries++; }

    public void Add(string level, string text)
    {
        lock (_lock)
        {
            _entries.Add(new Entry(Math.Round(_clock.Elapsed.TotalSeconds, 1), level, text));
            _added++;
            if (_entries.Count > MaxEntries) _entries.RemoveRange(0, _entries.Count - MaxEntries);
        }
    }

    public void Finish(string? error)
    {
        lock (_lock)
        {
            _finished = true;
            _error = error;
            _stage = error is null ? "done" : "failed";
        }
        Add(error is null ? "ok" : "error", error is null ? $"Loaded in {_clock.Elapsed.TotalSeconds:0.0} s." : $"Failed: {error}");
    }

    /// <summary>The state now, with the log entries after the first <paramref name="since"/> (the page asks only for new ones).</summary>
    public object Snapshot(int since)
    {
        lock (_lock)
        {
            var from = Math.Clamp(since - (_added - _entries.Count), 0, _entries.Count);
            return new
            {
                id = Id,
                stage = _stage,
                finished = _finished,
                error = _error,
                elapsedSeconds = Math.Round(_clock.Elapsed.TotalSeconds, 1),
                total = _total,
                done = _done,
                failed = _failed,
                fromDisk = _fromDisk,
                dhanCalls = _dhanCalls,
                savedToDisk = _savedToDisk,
                diskErrors = _diskErrors,
                rateLimited = _rateLimited,
                retries = _retries,
                next = _added,
                entries = _entries.Skip(from).ToList(),
            };
        }
    }

}

/// <summary>The loads in progress (and finished in the last few minutes), by the id the page made up for each.</summary>
public sealed class LoadProgressStore
{
    private static readonly TimeSpan KeepFor = TimeSpan.FromMinutes(10);
    private readonly ConcurrentDictionary<string, LoadProgress> _loads = new();

    public LoadProgress Start(string id)
    {
        foreach (var (key, old) in _loads)
            if (DateTimeOffset.UtcNow - old.StartedUtc > KeepFor) _loads.TryRemove(key, out _);
        var progress = new LoadProgress(id);
        _loads[id] = progress;
        return progress;
    }

    public LoadProgress? Get(string id) => _loads.TryGetValue(id, out var progress) ? progress : null;
}

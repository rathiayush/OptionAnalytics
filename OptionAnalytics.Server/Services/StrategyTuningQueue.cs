using System.Text.Json;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Scheduled strategy tuning jobs, run ONE AT A TIME (StrategyTuningService runs one job at a time anyway): each item is
/// a job for one index, optionally not before a given time and optionally repeated every day. Kept in
/// {tuning}/queue.json so a restart does not lose the schedule. StrategyTuningQueueHostedService starts the next due
/// item whenever no job is running and records how each one ended.
/// </summary>
public sealed class StrategyTuningQueue
{
    private readonly StrategyTuningService _tuning;
    private readonly ILogger<StrategyTuningQueue> _logger;
    private readonly object _lock = new();
    private readonly string _path;
    private List<TuningQueueItem> _items;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    /// <summary>Finished items kept for the list (oldest go first).</summary>
    internal const int KeepFinished = 50;

    public StrategyTuningQueue(StrategyTuningService tuning, ILogger<StrategyTuningQueue> logger)
    {
        _tuning = tuning;
        _logger = logger;
        _path = Path.Combine(tuning.TuningDirectory, "queue.json");
        _items = Load();
    }

    public IReadOnlyList<TuningQueueItem> Items() { lock (_lock) return _items.ToList(); }

    public TuningQueueItem Add(TuningJob job, DateTimeOffset? runAtUtc, bool repeatDaily)
    {
        var item = new TuningQueueItem(Guid.NewGuid().ToString("n")[..12], job, runAtUtc, repeatDaily, "queued", DateTimeOffset.UtcNow, null, null, null);
        lock (_lock) { _items.Add(item); Save(); }
        return item;
    }

    /// <summary>Removes a queued item (a running one is stopped from the page's Stop button, not here); false if none.</summary>
    public bool Remove(string id)
    {
        lock (_lock)
        {
            var removed = _items.RemoveAll(i => i.Id == id && i.State != "running") > 0;
            if (removed) Save();
            return removed;
        }
    }

    /// <summary>Drops every finished item (done / failed / cancelled) from the list.</summary>
    public void ClearFinished()
    {
        lock (_lock) { _items.RemoveAll(i => i.State is not ("queued" or "running")); Save(); }
    }

    /// <summary>One pass: records how the running item ended, then starts the next due one if nothing is running.
    /// <paramref name="startupGrace"/>: right after a restart an item still marked running is only given up on once the
    /// tuning service has had its chance to resume it.</summary>
    public void Tick(DateTimeOffset now, bool startupGrace = false)
    {
        lock (_lock)
        {
            var status = _tuning.Status();
            var changed = false;
            for (var i = 0; i < _items.Count; i++)
            {
                var item = _items[i];
                if (item.State != "running" || status.State == "running") continue;
                if (startupGrace) continue;
                var state = status.State switch { "done" => "done", "cancelled" => "cancelled", "failed" => "failed", _ => "failed" };
                var error = state == "done" ? null : status.Error ?? (status.State == "idle" ? "the server restarted while it ran" : null);
                _items[i] = item with { State = state, FinishedUtc = now, Error = error };
                changed = true;
                if (item.RepeatDaily)
                {
                    // Again tomorrow at the same time (or a day after it started, when it had no fixed time).
                    var next = (item.RunAtUtc ?? item.StartedUtc ?? now).AddDays(1);
                    while (next <= now) next = next.AddDays(1);
                    _items.Add(new TuningQueueItem(Guid.NewGuid().ToString("n")[..12], item.Job, next, true, "queued", now, null, null, null));
                }
            }
            if (status.State != "running" && !_items.Any(x => x.State == "running"))
            {
                var due = _items.Where(x => x.State == "queued" && (x.RunAtUtc is null || x.RunAtUtc <= now))
                    .OrderBy(x => x.RunAtUtc ?? x.AddedUtc).ThenBy(x => x.AddedUtc).FirstOrDefault();
                if (due is not null)
                {
                    var error = _tuning.Start(due.Job with { Resumed = false, Attempt = 0 });
                    var index = _items.IndexOf(due);
                    _items[index] = error is null
                        ? due with { State = "running", StartedUtc = now }
                        : due with { State = "failed", FinishedUtc = now, Error = error };
                    changed = true;
                    if (error is null) _logger.LogInformation("Scheduled tuning job {Id} for {Underlying} started.", due.Id, due.Job.Underlying);
                    else _logger.LogWarning("Scheduled tuning job {Id} for {Underlying} could not start: {Error}", due.Id, due.Job.Underlying, error);
                }
            }
            var finished = _items.Where(x => x.State is not ("queued" or "running")).OrderBy(x => x.FinishedUtc).ToList();
            foreach (var old in finished.Take(Math.Max(0, finished.Count - KeepFinished))) { _items.Remove(old); changed = true; }
            if (changed) Save();
        }
    }

    private List<TuningQueueItem> Load()
    {
        try { return File.Exists(_path) ? JsonSerializer.Deserialize<List<TuningQueueItem>>(File.ReadAllText(_path), Json) ?? new() : new(); }
        catch (Exception ex) { _logger.LogWarning(ex, "The tuning schedule {Path} could not be read - starting empty.", _path); return new(); }
    }

    private void Save()
    {
        try
        {
            var temp = _path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(_items, Json));
            File.Move(temp, _path, overwrite: true);
        }
        catch (Exception ex) { _logger.LogWarning(ex, "The tuning schedule could not be saved."); }
    }
}

/// <summary>Starts scheduled tuning jobs one after another (StrategyTuningQueue.Tick every 10 s).</summary>
public sealed class StrategyTuningQueueHostedService(StrategyTuningQueue queue, IHostApplicationLifetime lifetime, ILogger<StrategyTuningQueueHostedService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var started = new TaskCompletionSource();
        using (lifetime.ApplicationStarted.Register(() => started.TrySetResult())) await started.Task.WaitAsync(stoppingToken);
        var since = DateTimeOffset.UtcNow;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                // The first 90 s after a start leave an interrupted job to StrategyTuningResumeHostedService (60 s).
                queue.Tick(DateTimeOffset.UtcNow, startupGrace: DateTimeOffset.UtcNow - since < TimeSpan.FromSeconds(90));
            }
            catch (Exception ex) { logger.LogWarning(ex, "The tuning schedule pass failed."); }
            await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
        }
    }
}

/// <summary>One scheduled job: State queued / running / done / failed / cancelled.</summary>
public sealed record TuningQueueItem(string Id, TuningJob Job, DateTimeOffset? RunAtUtc, bool RepeatDaily, string State,
    DateTimeOffset AddedUtc, DateTimeOffset? StartedUtc, DateTimeOffset? FinishedUtc, string? Error);

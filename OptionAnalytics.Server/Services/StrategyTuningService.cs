using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Hosting.Server;
using OptionAnalytics.Server.Auth;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Runs the strategy tuning job (scanner-runner/tune.mjs - strategyTuning.js) for one index at a time, in its
/// own Node process with the runner's key: it scans the past days through this server's API and writes its
/// result to {Storage:ScannerRunnerPath}/tuning/{INDEX}-latest.json (and a dated copy). Started from the
/// Strategy tuning page; read-only - it changes no setting (the page applies a result).
/// </summary>
public sealed class StrategyTuningService
{
    private readonly IConfiguration _configuration;
    private readonly IHostEnvironment _environment;
    private readonly IServer _server;
    private readonly ScannerRunnerKey _key;
    private readonly ILogger<StrategyTuningService> _logger;
    private readonly object _lock = new();
    private readonly string _dir;
    private Process? _process;
    private TuningStatus _status = new("idle", null, null, null, null, null, null);

    public StrategyTuningService(IConfiguration configuration, IHostEnvironment environment, IServer server, ScannerRunnerKey key,
        ScannerRunnerStore store, IHostApplicationLifetime lifetime, ILogger<StrategyTuningService> logger)
    {
        _configuration = configuration;
        _environment = environment;
        _server = server;
        _key = key;
        _logger = logger;
        _dir = Path.Combine(store.DataDirectory, "tuning");
        Directory.CreateDirectory(_dir);
        // Stopping the server stops the job but keeps it on record (current-job.json): it starts again after the restart
        // (ResumeInterrupted), and the days it had fetched come from the disk cache - only the rest are asked of Dhan.
        lifetime.ApplicationStopping.Register(() => Cancel(userRequested: false));
    }

    /// <summary>{Storage:ScannerRunnerPath}/tuning - the results, the history, the schedule (StrategyTuningQueue).</summary>
    public string TuningDirectory => _dir;

    /// <summary>Removes the tuning results and history (runs.csv, every run's trades / settings, the latest and dated
    /// result files) - and, with <paramref name="alsoCache"/>, the days the jobs fetched (each costs Dhan calls to fetch
    /// again). Refused while a job runs. Returns null, or why not.</summary>
    public string? ClearHistory(bool alsoCache)
    {
        lock (_lock)
        {
            if (_status.State == "running") return "a tuning job is running - stop it first";
            try
            {
                if (Directory.Exists(HistoryDirectory)) Directory.Delete(HistoryDirectory, recursive: true);
                foreach (var file in Directory.GetFiles(_dir, "*.json"))
                {
                    var name = Path.GetFileName(file);
                    // The results only: the schedule and an interrupted job's record stay.
                    if (name is "queue.json" or "current-job.json") continue;
                    File.Delete(file);
                }
                if (alsoCache && Directory.Exists(CacheDirectory)) Directory.Delete(CacheDirectory, recursive: true);
                _logger.LogInformation("Strategy tuning history cleared{Cache}.", alsoCache ? " (and the fetched-days cache)" : "");
                return null;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "The tuning history could not be cleared.");
                return $"could not clear everything: {ex.Message}";
            }
        }
    }

    /// <summary>
    /// Removes ONE run and everything it produced: its history files ({run_id}-trades / -settings / -days.csv), its row
    /// in runs.csv, its result (the latest and the dated copy - those naming this run, or for an older result the same
    /// index finished within two minutes of it), and the days it fetched into the cache - that index's files for the
    /// run's dates (its day list; else its first..last day). An older cache file with no index folder for one of those
    /// dates goes too (it cannot be told apart). Refused for the run of a job still running.
    /// </summary>
    public (TuningRunDeleted? Deleted, string? Error) DeleteRun(string runId)
    {
        if (!RunIdPattern.IsMatch(runId ?? "")) return (null, "not a tuning run id");
        lock (_lock)
        {
            if (_status.State == "running" && _status.RunId == runId) return (null, "that job is still running - stop it first");
        }
        var run = HistoryRuns().FirstOrDefault(r => r.GetValueOrDefault("run_id") == runId);
        var index = run?.GetValueOrDefault("index") ?? runId.Split('-')[0];
        var data = run?.GetValueOrDefault("data") ?? runId.Split('-')[1];
        // The dates it fetched: its day list, else first..last day.
        var dates = new HashSet<string>(StringComparer.Ordinal);
        foreach (var d in HistoryRows(runId, "days") ?? new()) if (d.GetValueOrDefault("date") is { Length: 10 } date) dates.Add(date);
        if (dates.Count == 0 && run is not null && DateOnly.TryParse(run.GetValueOrDefault("first_day"), out var a) && DateOnly.TryParse(run.GetValueOrDefault("last_day"), out var b))
        {
            if (a > b) (a, b) = (b, a);
            for (var d = a; d <= b && dates.Count < 400; d = d.AddDays(1)) dates.Add(d.ToString("yyyy-MM-dd"));
        }
        try
        {
            var historyFiles = 0;
            foreach (var kind in new[] { "trades", "settings", "days" })
            {
                var path = Path.Combine(HistoryDirectory, $"{runId}-{kind}.csv");
                if (File.Exists(path)) { File.Delete(path); historyFiles++; }
            }
            var row = RemoveRunRow(runId);
            var results = 0;
            var finishedIst = run?.GetValueOrDefault("finished_ist");
            var prefix = $"{index}{(data == "spot" ? "-spot" : "")}-";
            foreach (var file in Directory.GetFiles(_dir, $"{prefix}*.json"))
            {
                if (ResultBelongsTo(file, runId, finishedIst, data)) { File.Delete(file); results++; }
            }
            var cache = 0;
            var versions = Directory.Exists(CacheDirectory) ? Directory.GetDirectories(CacheDirectory) : Array.Empty<string>();
            foreach (var version in versions)
            {
                foreach (var folder in new[] { Path.Combine(version, index.ToUpperInvariant()), version })
                {
                    if (!Directory.Exists(folder)) continue;
                    foreach (var month in Directory.GetDirectories(folder))
                    {
                        if (!System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(month), "^[0-9]{4}-[0-9]{2}$")) continue;
                        foreach (var file in Directory.GetFiles(month, "*.json.gz"))
                        {
                            var name = Path.GetFileName(file);
                            if (name.Length >= 10 && dates.Contains(name[..10])) { File.Delete(file); cache++; }
                        }
                    }
                }
            }
            _logger.LogInformation("Tuning run {RunId} deleted: {History} history file(s), {Results} result(s), {Cache} cached day file(s).", runId, historyFiles, results, cache);
            return (new TuningRunDeleted(runId, historyFiles, results, cache, row), null);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Tuning run {RunId} could not be deleted completely.", runId);
            return (null, $"could not delete everything: {ex.Message}");
        }
    }

    /// <summary>The run a finished queue job wrote, for a job from before the run id was kept: the same index, data and
    /// range, finished between its start and two minutes after its end.</summary>
    public string? FindRun(TuningJob job, DateTimeOffset? startedUtc, DateTimeOffset? finishedUtc)
    {
        if (startedUtc is null) return null;
        var until = (finishedUtc ?? DateTimeOffset.UtcNow).AddMinutes(2);
        foreach (var r in HistoryRuns())
        {
            if (r.GetValueOrDefault("index") != job.Underlying.ToUpperInvariant() || r.GetValueOrDefault("data", "futures") != job.Data) continue;
            if ((job.From ?? "") != r.GetValueOrDefault("from", "") || (job.To ?? "") != r.GetValueOrDefault("to", "")) continue;
            if (!DateTime.TryParse(r.GetValueOrDefault("finished_ist"), CultureInfo.InvariantCulture, DateTimeStyles.None, out var ist)) continue;
            var at = new DateTimeOffset(ist, IstClock.Offset);
            if (at >= startedUtc.Value.AddMinutes(-1) && at <= until) return r.GetValueOrDefault("run_id");
        }
        return null;
    }

    private bool RemoveRunRow(string runId)
    {
        var runsPath = Path.Combine(HistoryDirectory, "runs.csv");
        if (!File.Exists(runsPath)) return false;
        var parsed = ScannerLogStore.Parse(File.ReadAllText(runsPath));
        if (parsed.Count == 0) return false;
        var columns = parsed[0].ToArray();
        var rows = ScannerLogStore.Read(runsPath).ToList();
        var kept = rows.Where(r => r.GetValueOrDefault("run_id") != runId).ToList();
        if (kept.Count == rows.Count) return false;
        var sb = new StringBuilder(string.Join(',', columns)).Append('\n');
        foreach (var row in kept) sb.Append(ScannerLogStore.Line(columns, row)).Append('\n');
        var temp = runsPath + ".tmp";
        File.WriteAllText(temp, sb.ToString());
        File.Move(temp, runsPath, overwrite: true);
        return true;
    }

    private static bool ResultBelongsTo(string file, string runId, string? finishedIst, string data)
    {
        try
        {
            var node = JsonNode.Parse(File.ReadAllText(file));
            if (node?["runId"]?.GetValue<string>() is { } id) return id == runId;
            if ((node?["data"]?.GetValue<string>() ?? "futures") != data) return false;
            // An older result (no runId): the one that finished with this run.
            if (finishedIst is null || node?["finishedUtc"]?.GetValue<string>() is not { } f || !DateTimeOffset.TryParse(f, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var finished)) return false;
            if (!DateTime.TryParse(finishedIst, CultureInfo.InvariantCulture, DateTimeStyles.None, out var ist)) return false;
            return Math.Abs((finished - new DateTimeOffset(ist, IstClock.Offset)).TotalMinutes) <= 2;
        }
        catch { return false; }
    }

    /// <summary>Removes only the fetched-days cache. Refused while a job runs.</summary>
    public string? ClearCache()
    {
        lock (_lock)
        {
            if (_status.State == "running") return "a tuning job is running - stop it first";
            try { if (Directory.Exists(CacheDirectory)) Directory.Delete(CacheDirectory, recursive: true); return null; }
            catch (Exception ex) { return $"could not clear the cache: {ex.Message}"; }
        }
    }

    /// <summary>Each past day's fetched data (tune.mjs / tuneFetch.mjs): a rerun, a resumed job or a longer range reads
    /// it from here instead of Dhan.</summary>
    public string CacheDirectory => Path.Combine(_dir, "cache");
    private string CurrentJobPath => Path.Combine(_dir, "current-job.json");
    private static readonly JsonSerializerOptions JobJson = new(JsonSerializerDefaults.Web);

    /// <summary>How many times a job interrupted by a server stop may be started again before it is given up on.
    /// A job that dies the moment it starts - out of memory on a big range response, a crash - used to be started
    /// again after EVERY restart for ever, because the attempt was never recorded anywhere: the record was rewritten
    /// with a clean slate each time it started. The attempt is now carried in the record itself (TuningJob.Attempt),
    /// so the loop ends and says why.</summary>
    private int MaxResumes => Math.Clamp(_configuration.GetValue("StrategyTuning:MaxResumes", 2), 0, 10);

    /// <summary>A job the server was stopped in the middle of (a restart / redeploy) - started again; null if none,
    /// or the reason it was not.</summary>
    public string? ResumeInterrupted()
    {
        TuningJob? job;
        try { job = File.Exists(CurrentJobPath) ? JsonSerializer.Deserialize<TuningJob>(File.ReadAllText(CurrentJobPath), JobJson) : null; }
        catch (Exception ex) { _logger.LogWarning(ex, "The interrupted tuning job could not be read - dropped."); TryDelete(CurrentJobPath); return null; }
        if (job is null) return null;
        var attempt = job.Attempt + 1;
        if (attempt > MaxResumes)
        {
            // Given up on, out loud, and the record removed so the next restart does not try again: a job that keeps
            // dying is a thing to look at, not a thing to keep restarting.
            var reason = $"the {job.Underlying} tuning job was interrupted and started again {job.Attempt} time(s) already (the limit is {MaxResumes}) - it is not being started again. Something is making it die: look at the server log for it, then start it again from the Strategy tuning page (the days already fetched come from the cache).";
            _logger.LogError("Strategy tuning: {Reason}", reason);
            TryDelete(CurrentJobPath);
            lock (_lock) _status = new TuningStatus("failed", job, null, DateTimeOffset.UtcNow, reason, null, null);
            return reason;
        }
        _logger.LogInformation("Resuming the strategy tuning job for {Underlying} that the last stop interrupted (attempt {Attempt} of {Max}).",
            job.Underlying, attempt, MaxResumes);
        return Start(job with { Resumed = true, Attempt = attempt });
    }

    public TuningStatus Status() { lock (_lock) return _status; }

    /// <summary>The latest result file; the spot + options mode ("spot") keeps its own, so it never overwrites the futures one.</summary>
    public string ResultPath(string underlying, string data = "futures") => Path.Combine(_dir, $"{underlying.ToUpperInvariant()}{(data == "spot" ? "-spot" : "")}-latest.json");

    /// <summary>The tuning HISTORY, as CSV (no database - scanner-runner/tuneHistory.mjs): runs.csv, and per run
    /// {run_id}-trades.csv, {run_id}-settings.csv and {run_id}-days.csv (every day it looked at: used - train / test - or
    /// left out, and why). A run is never overwritten, so a strategy can be compared run by
    /// run and the Trades page can club several runs' trades (any index) by date and time.</summary>
    public string HistoryDirectory => Path.Combine(_dir, "history");

    private static readonly Regex RunIdPattern = new("^[A-Z0-9]{1,20}-(futures|spot)-[0-9]{8}-[0-9]{6}$", RegexOptions.Compiled);

    /// <summary>One history file's full path, or null for an id this server did not write (never a path from the URL).</summary>
    public string? HistoryPath(string runId, string kind)
    {
        if (!RunIdPattern.IsMatch(runId ?? "") || kind is not ("trades" or "settings" or "days")) return null;
        var path = Path.Combine(HistoryDirectory, $"{runId}-{kind}.csv");
        return File.Exists(path) ? path : null;
    }

    /// <summary>Every run, newest first (runs.csv) - empty when none has finished yet.</summary>
    public List<Dictionary<string, string>> HistoryRuns()
    {
        var path = Path.Combine(HistoryDirectory, "runs.csv");
        try
        {
            if (!File.Exists(path)) return new();
            var rows = ScannerLogStore.Read(path).ToList();
            rows.Reverse();
            return rows;
        }
        catch (Exception ex) { _logger.LogWarning(ex, "The tuning history {Path} could not be read.", path); return new(); }
    }

    /// <summary>One run's trades or settings as rows, or null when there is no such file.</summary>
    public List<Dictionary<string, string>>? HistoryRows(string runId, string kind)
    {
        var path = HistoryPath(runId, kind);
        try { return path is null ? null : ScannerLogStore.Read(path).ToList(); }
        catch (Exception ex) { _logger.LogWarning(ex, "The tuning history {Path} could not be read.", path); return null; }
    }

    /// <summary>Keeps the newest `keep` runs - an older run's files are removed with its row.</summary>
    public void PruneHistory(int keep)
    {
        try
        {
            var runs = HistoryRuns();
            if (keep <= 0 || runs.Count <= keep) return;
            var drop = runs.Skip(keep).Select(r => r.GetValueOrDefault("run_id", "")).Where(id => RunIdPattern.IsMatch(id)).ToHashSet(StringComparer.Ordinal);
            foreach (var id in drop)
                foreach (var kind in new[] { "trades", "settings", "days" })
                {
                    var path = Path.Combine(HistoryDirectory, $"{id}-{kind}.csv");
                    if (File.Exists(path)) File.Delete(path);
                }
            var kept = runs.Take(keep).Reverse().ToList(); // runs.csv is oldest-first on disk
            var runsPath = Path.Combine(HistoryDirectory, "runs.csv");
            var columns = ScannerLogStore.Parse(File.ReadAllText(runsPath))[0].ToArray();
            var sb = new StringBuilder(string.Join(',', columns)).Append('\n');
            foreach (var row in kept) sb.Append(ScannerLogStore.Line(columns, row)).Append('\n');
            File.WriteAllText(runsPath, sb.ToString());
            _logger.LogInformation("Tuning history: {Dropped} old run(s) removed, {Kept} kept.", drop.Count, kept.Count);
        }
        catch (Exception ex) { _logger.LogWarning(ex, "The tuning history could not be pruned."); }
    }

    /// <summary>The last result for an index (null when none).</summary>
    public JsonNode? Result(string underlying, string data = "futures")
    {
        var path = ResultPath(underlying, data);
        try { return File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path)) : null; }
        catch (Exception ex) { _logger.LogWarning(ex, "Tuning result {Path} could not be read.", path); return null; }
    }

    /// <summary>Starts a job; null, or why it cannot start.</summary>
    public string? Start(TuningJob job)
    {
        var script = _configuration["StrategyTuning:ScriptPath"] is { Length: > 0 } configured
            ? Path.GetFullPath(configured, _environment.ContentRootPath)
            : Path.Combine(_environment.ContentRootPath, "scanner-runner", "tune.mjs");
        if (!File.Exists(script)) return $"{Path.GetFileName(script)} is not on the server (build it with `npm run build:runner`)";
        lock (_lock)
        {
            if (_status.State == "running") return $"a tuning job for {_status.Job?.Underlying} is already running";
            _stopping = false;
            var output = ResultPath(job.Underlying, job.Data);
            var node = _configuration["ScannerRunner:NodePath"] is { Length: > 0 } n ? n : "node";
            var info = new ProcessStartInfo(node)
            {
                RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(script)!,
            };
            // A 250-day job holds every scanned day in memory: the heap cap is set rather than left to Node's default.
            info.ArgumentList.Add($"--max-old-space-size={Math.Clamp(_configuration.GetValue("StrategyTuning:MaxMemoryMb", 4096), 512, 65536)}");
            info.ArgumentList.Add(script);
            info.Environment["RUNNER_BASE_URL"] = ScannerRunnerHostedService.BaseUrlOf(_server);
            info.Environment["RUNNER_KEY"] = _key.Value;
            info.Environment["TUNE_JOB"] = JsonSerializer.Serialize(job, new JsonSerializerOptions(JsonSerializerDefaults.Web));
            info.Environment["TUNE_OUT"] = output + ".running";
            info.Environment["TUNE_HISTORY_DIR"] = HistoryDirectory;
            info.Environment["TUNE_CACHE_DIR"] = CacheDirectory;
            info.Environment["TUNE_CACHE_MAX_MB"] = Math.Max(0, _configuration.GetValue("StrategyTuning:CacheMaxMb", 4096)).ToString(System.Globalization.CultureInfo.InvariantCulture);
            info.Environment["TUNE_PACE_MS"] = Math.Max(0, _configuration.GetValue("StrategyTuning:PaceMs", 0)).ToString(System.Globalization.CultureInfo.InvariantCulture);
            // The job's own hard end (see tune.mjs's header): past this it stops scanning, writes its result and
            // history with the days it got to, and says how many that was. Generous by default, but never absent.
            info.Environment["TUNE_JOB_BUDGET_MS"] =
                (Math.Clamp(_configuration.GetValue("StrategyTuning:JobBudgetMinutes", 90), 1, 24 * 60) * 60_000L).ToString(System.Globalization.CultureInfo.InvariantCulture);
            // And the hard end on one day being fetched over and over by the retry rounds (42 Dhan option-series
            // calls every time): a day's data of one kind is fetched at most this many times in a whole job.
            info.Environment["TUNE_MAX_FETCHES_PER_DAY"] =
                Math.Clamp(_configuration.GetValue("StrategyTuning:MaxFetchesPerDay", 3), 1, 10).ToString(System.Globalization.CultureInfo.InvariantCulture);
            var process = new Process { StartInfo = info, EnableRaisingEvents = true };
            process.OutputDataReceived += (_, e) => OnOutput(e.Data);
            process.ErrorDataReceived += (_, e) => { if (e.Data is { Length: > 0 } line) _logger.LogWarning("[tuning] {Line}", line); };
            try
            {
                if (!process.Start()) return $"{node} did not start";
            }
            catch (Exception ex)
            {
                process.Dispose();
                return $"{node} could not be started: {ex.Message}";
            }
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            _process = process;
            _status = new TuningStatus("running", job, DateTimeOffset.UtcNow, null, null, null, process.Id);
            // Resumed is cleared (the next start is its own), but Attempt is NOT - it is what ends a restart loop.
            try { File.WriteAllText(CurrentJobPath, JsonSerializer.Serialize(job with { Resumed = false }, JobJson)); }
            catch (Exception ex) { _logger.LogWarning(ex, "The tuning job could not be recorded for a resume after a restart."); }
            _logger.LogInformation("Strategy tuning started for {Underlying} (pid {Pid}).", job.Underlying, process.Id);
            _ = WatchAsync(process, job, output);
            return null;
        }
    }

    /// <summary>Stops the running job. <paramref name="userRequested"/> (the Stop button): it is forgotten; a server stop
    /// keeps it to resume after the restart.</summary>
    public void Cancel() => Cancel(userRequested: true);

    public void Cancel(bool userRequested)
    {
        lock (_lock)
        {
            if (userRequested) TryDelete(CurrentJobPath);
            if (_process is null) return;
            _stopping = !userRequested;
            try { _process.Kill(entireProcessTree: true); } catch { /* already gone */ }
            _status = _status with { State = "cancelled", FinishedUtc = DateTimeOffset.UtcNow };
        }
    }

    private bool _stopping;
    private static void TryDelete(string path) { try { if (File.Exists(path)) File.Delete(path); } catch { /* next time */ } }

    private void OnOutput(string? line)
    {
        if (string.IsNullOrEmpty(line)) return;
        if (line.StartsWith("HISTORY ", StringComparison.Ordinal))
        {
            var id = line["HISTORY ".Length..].Split(' ')[0];
            if (RunIdPattern.IsMatch(id)) lock (_lock) _status = _status with { RunId = id };
        }
        if (line.StartsWith("PROGRESS ", StringComparison.Ordinal))
        {
            try
            {
                var p = JsonNode.Parse(line["PROGRESS ".Length..]);
                lock (_lock) _status = _status with { Progress = p };
            }
            catch (JsonException) { /* not ours */ }
            return;
        }
        _logger.LogInformation("[tuning] {Line}", line);
    }

    private async Task WatchAsync(Process process, TuningJob job, string output)
    {
        try
        {
            await process.WaitForExitAsync();
            var running = output + ".running";
            string? error = null;
            if (File.Exists(running))
            {
                var body = JsonNode.Parse(File.ReadAllText(running));
                if (body?["ok"]?.GetValue<bool>() == true)
                {
                    File.Copy(running, Path.Combine(_dir, $"{job.Underlying}{(job.Data == "spot" ? "-spot" : "")}-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}.json"), overwrite: true);
                    File.Move(running, output, overwrite: true);
                }
                else
                {
                    error = body?["error"]?.GetValue<string>() ?? "the job failed";
                    File.Delete(running);
                }
            }
            else if (process.ExitCode != 0) error = $"the job exited with code {process.ExitCode}";
            PruneHistory(_configuration.GetValue("StrategyTuning:HistoryRuns", 100));
            lock (_lock)
            {
                // Finished, failed or stopped from the page: nothing to resume. Killed by a server stop: kept.
                if (!_stopping) TryDelete(CurrentJobPath);
                if (_status.State == "running")
                    _status = _status with { State = error is null ? "done" : "failed", FinishedUtc = DateTimeOffset.UtcNow, Error = error };
                _process = null;
            }
            _logger.LogInformation("Strategy tuning for {Underlying} finished: {Result}.", job.Underlying, error ?? "done");
        }
        catch (Exception ex)
        {
            lock (_lock) { _status = _status with { State = "failed", FinishedUtc = DateTimeOffset.UtcNow, Error = ex.Message }; _process = null; }
        }
        finally
        {
            process.Dispose();
        }
    }
}

/// <summary>Starts again, after the server is up, a tuning job the last stop (a restart / redeploy) interrupted.</summary>
public sealed class StrategyTuningResumeHostedService(StrategyTuningService tuning, IHostApplicationLifetime lifetime, ILogger<StrategyTuningResumeHostedService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // After the server listens (the job reads its API) and its Dhan session has had time to come up.
        var started = new TaskCompletionSource();
        using (lifetime.ApplicationStarted.Register(() => started.TrySetResult())) await started.Task.WaitAsync(stoppingToken);
        await Task.Delay(TimeSpan.FromSeconds(60), stoppingToken);
        var error = tuning.ResumeInterrupted();
        if (error is not null) logger.LogWarning("The interrupted tuning job could not be resumed: {Error}", error);
    }
}

/// <summary>What to tune: one index; strategies "top3" / "top5" / "all" or a list of ids; how many past days;
/// whether days rebuilt from 1-minute candles count; the fewest trades a setting needs.
///
/// Attempt is how many times a server restart has already started this same job again - carried in current-job.json
/// and checked by ResumeInterrupted, so an interrupted job resumes a couple of times and then gives up with a reason
/// rather than restarting for ever.</summary>
public sealed record TuningJob(string Underlying, JsonNode? Strategies, int Days, bool IncludeEstimated, int MinTrades, string What = "trade", IReadOnlyList<string>? OiFactors = null, string Search = "step", string Data = "futures", string? From = null, string? To = null, bool Resumed = false, int Attempt = 0);

public sealed record TuningStatus(string State, TuningJob? Job, DateTimeOffset? StartedUtc, DateTimeOffset? FinishedUtc, string? Error, JsonNode? Progress, int? Pid)
{
    /// <summary>The history run the job wrote (tune.mjs prints "HISTORY {run_id}") - the queue keeps it, so deleting the
    /// job can remove its run, result and cache.</summary>
    public string? RunId { get; init; }
}

/// <summary>What deleting a run removed.</summary>
public sealed record TuningRunDeleted(string? RunId, int HistoryFiles, int ResultFiles, int CacheFiles, bool RunRow);

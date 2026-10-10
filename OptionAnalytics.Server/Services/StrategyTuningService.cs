using System.Diagnostics;
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

    /// <summary>Each past day's fetched data (tune.mjs / tuneFetch.mjs): a rerun, a resumed job or a longer range reads
    /// it from here instead of Dhan.</summary>
    public string CacheDirectory => Path.Combine(_dir, "cache");
    private string CurrentJobPath => Path.Combine(_dir, "current-job.json");
    private static readonly JsonSerializerOptions JobJson = new(JsonSerializerDefaults.Web);

    /// <summary>A job the server was stopped in the middle of (a restart / redeploy) - started again; null if none.</summary>
    public string? ResumeInterrupted()
    {
        TuningJob? job;
        try { job = File.Exists(CurrentJobPath) ? JsonSerializer.Deserialize<TuningJob>(File.ReadAllText(CurrentJobPath), JobJson) : null; }
        catch (Exception ex) { _logger.LogWarning(ex, "The interrupted tuning job could not be read - dropped."); File.Delete(CurrentJobPath); return null; }
        if (job is null) return null;
        _logger.LogInformation("Resuming the strategy tuning job for {Underlying} that the last stop interrupted.", job.Underlying);
        return Start(job with { Resumed = true });
    }

    public TuningStatus Status() { lock (_lock) return _status; }

    /// <summary>The latest result file; the spot + options mode ("spot") keeps its own, so it never overwrites the futures one.</summary>
    public string ResultPath(string underlying, string data = "futures") => Path.Combine(_dir, $"{underlying.ToUpperInvariant()}{(data == "spot" ? "-spot" : "")}-latest.json");

    /// <summary>The tuning HISTORY, as CSV (no database - scanner-runner/tuneHistory.mjs): runs.csv, and per run
    /// {run_id}-trades.csv and {run_id}-settings.csv. A run is never overwritten, so a strategy can be compared run by
    /// run and the Trades page can club several runs' trades (any index) by date and time.</summary>
    public string HistoryDirectory => Path.Combine(_dir, "history");

    private static readonly Regex RunIdPattern = new("^[A-Z0-9]{1,20}-(futures|spot)-[0-9]{8}-[0-9]{6}$", RegexOptions.Compiled);

    /// <summary>One history file's full path, or null for an id this server did not write (never a path from the URL).</summary>
    public string? HistoryPath(string runId, string kind)
    {
        if (!RunIdPattern.IsMatch(runId ?? "") || kind is not ("trades" or "settings")) return null;
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
                foreach (var kind in new[] { "trades", "settings" })
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
/// whether days rebuilt from 1-minute candles count; the fewest trades a setting needs.</summary>
public sealed record TuningJob(string Underlying, JsonNode? Strategies, int Days, bool IncludeEstimated, int MinTrades, string What = "trade", IReadOnlyList<string>? OiFactors = null, string Search = "step", string Data = "futures", string? From = null, string? To = null, bool Resumed = false);

public sealed record TuningStatus(string State, TuningJob? Job, DateTimeOffset? StartedUtc, DateTimeOffset? FinishedUtc, string? Error, JsonNode? Progress, int? Pid);

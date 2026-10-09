using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
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
        lifetime.ApplicationStopping.Register(Cancel);
    }

    public TuningStatus Status() { lock (_lock) return _status; }

    public string ResultPath(string underlying) => Path.Combine(_dir, $"{underlying.ToUpperInvariant()}-latest.json");

    /// <summary>The last result for an index (null when none).</summary>
    public JsonNode? Result(string underlying)
    {
        var path = ResultPath(underlying);
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
            var output = ResultPath(job.Underlying);
            var node = _configuration["ScannerRunner:NodePath"] is { Length: > 0 } n ? n : "node";
            var info = new ProcessStartInfo(node)
            {
                RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(script)!,
            };
            info.ArgumentList.Add(script);
            info.Environment["RUNNER_BASE_URL"] = ScannerRunnerHostedService.BaseUrlOf(_server);
            info.Environment["RUNNER_KEY"] = _key.Value;
            info.Environment["TUNE_JOB"] = JsonSerializer.Serialize(job, new JsonSerializerOptions(JsonSerializerDefaults.Web));
            info.Environment["TUNE_OUT"] = output + ".running";
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
            _logger.LogInformation("Strategy tuning started for {Underlying} (pid {Pid}).", job.Underlying, process.Id);
            _ = WatchAsync(process, job, output);
            return null;
        }
    }

    public void Cancel()
    {
        lock (_lock)
        {
            if (_process is null) return;
            try { _process.Kill(entireProcessTree: true); } catch { /* already gone */ }
            _status = _status with { State = "cancelled", FinishedUtc = DateTimeOffset.UtcNow };
        }
    }

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
                    File.Copy(running, Path.Combine(_dir, $"{job.Underlying}-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}.json"), overwrite: true);
                    File.Move(running, output, overwrite: true);
                }
                else
                {
                    error = body?["error"]?.GetValue<string>() ?? "the job failed";
                    File.Delete(running);
                }
            }
            else if (process.ExitCode != 0) error = $"the job exited with code {process.ExitCode}";
            lock (_lock)
            {
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

/// <summary>What to tune: one index; strategies "top3" / "top5" / "all" or a list of ids; how many past days;
/// whether days rebuilt from 1-minute candles count; the fewest trades a setting needs.</summary>
public sealed record TuningJob(string Underlying, JsonNode? Strategies, int Days, bool IncludeEstimated, int MinTrades, string What = "trade", IReadOnlyList<string>? OiFactors = null);

public sealed record TuningStatus(string State, TuningJob? Job, DateTimeOffset? StartedUtc, DateTimeOffset? FinishedUtc, string? Error, JsonNode? Progress, int? Pid);

using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using OptionAnalytics.Server.Auth;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// The server-side strategy scanner: the same scanner the Order Flow page runs (optionanalytics.client's
/// scannerCore.js, strategyEngine.js ...), bundled into scanner-runner/runner.mjs and run by Node, for
/// NIFTY, BANKNIFTY and SENSEX at once - with or without a browser open. This service starts it once the
/// web server is listening, restarts it if it stops (backing off up to a minute), passes it the base URL,
/// its key (ScannerRunnerKey) and where to keep its state, and copies its output into the log.
///
/// Phase 2: alerts and PAPER trades only. The runner's role cannot place live orders.
///
/// ScannerRunner:Enabled (default true) turns it off; ScannerRunner:NodePath (default "node") and
/// ScannerRunner:ScriptPath (default {ContentRoot}/scanner-runner/runner.mjs) locate it. A server with no
/// Node or no bundle just logs that and runs without it.
/// </summary>
public sealed class ScannerRunnerHostedService : BackgroundService
{
    private readonly IConfiguration _configuration;
    private readonly IHostEnvironment _environment;
    private readonly IHostApplicationLifetime _lifetime;
    private readonly IServer _server;
    private readonly ScannerRunnerKey _key;
    private readonly ScannerRunnerStore _store;
    private readonly ILogger<ScannerRunnerHostedService> _logger;

    public ScannerRunnerHostedService(IConfiguration configuration, IHostEnvironment environment, IHostApplicationLifetime lifetime, IServer server,
        ScannerRunnerKey key, ScannerRunnerStore store, ILogger<ScannerRunnerHostedService> logger)
    {
        _configuration = configuration;
        _environment = environment;
        _lifetime = lifetime;
        _server = server;
        _key = key;
        _store = store;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_configuration.GetValue("ScannerRunner:Enabled", true))
        {
            _store.SetProcess("off", "ScannerRunner:Enabled is false");
            return;
        }
        var script = _configuration["ScannerRunner:ScriptPath"] is { Length: > 0 } configured
            ? Path.GetFullPath(configured, _environment.ContentRootPath)
            : Path.Combine(_environment.ContentRootPath, "scanner-runner", "runner.mjs");
        if (!File.Exists(script))
        {
            _logger.LogInformation("Server scanner: {Script} not found - not started (build it with `npm run build:runner`).", script);
            _store.SetProcess("missing", $"{script} not found");
            return;
        }

        // Only once Kestrel is listening - the runner's first call is to this server.
        var started = new TaskCompletionSource();
        using (_lifetime.ApplicationStarted.Register(() => started.TrySetResult()))
        using (stoppingToken.Register(() => started.TrySetCanceled()))
        {
            try { await started.Task; } catch (OperationCanceledException) { return; }
        }

        var delay = TimeSpan.FromSeconds(5);
        while (!stoppingToken.IsCancellationRequested)
        {
            var startedAt = DateTimeOffset.UtcNow;
            try
            {
                await RunOnceAsync(script, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Server scanner could not be started.");
                _store.SetProcess("failed", ex.Message);
            }
            // A run that lasted a while starts again quickly; one that keeps dying backs off.
            delay = DateTimeOffset.UtcNow - startedAt > TimeSpan.FromMinutes(5) ? TimeSpan.FromSeconds(5) : TimeSpan.FromSeconds(Math.Min(60, delay.TotalSeconds * 2));
            try { await Task.Delay(delay, stoppingToken); } catch (OperationCanceledException) { break; }
        }
    }

    private async Task RunOnceAsync(string script, CancellationToken stoppingToken)
    {
        var node = _configuration["ScannerRunner:NodePath"] is { Length: > 0 } n ? n : "node";
        var info = new ProcessStartInfo(node)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(script)!,
        };
        info.ArgumentList.Add(script);
        info.Environment["RUNNER_BASE_URL"] = BaseUrl();
        info.Environment["RUNNER_KEY"] = _key.Value;
        info.Environment["RUNNER_DATA_DIR"] = _store.DataDirectory;

        using var process = new Process { StartInfo = info, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, e) => { if (e.Data is { Length: > 0 } line) _logger.LogInformation("[scanner-runner] {Line}", line); };
        process.ErrorDataReceived += (_, e) => { if (e.Data is { Length: > 0 } line) _logger.LogWarning("[scanner-runner] {Line}", line); };
        if (!process.Start()) throw new InvalidOperationException($"{node} did not start");
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        _store.SetProcess("running", null, process.Id);
        _logger.LogInformation("Server scanner started (pid {Pid}).", process.Id);
        try
        {
            await process.WaitForExitAsync(stoppingToken);
            _logger.LogWarning("Server scanner exited with code {Code}.", process.ExitCode);
            _store.SetProcess("exited", $"exit code {process.ExitCode}");
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch { /* already gone */ }
            _store.SetProcess("stopped", null);
            throw;
        }
    }

    // This server's own address as the runner should call it: the first address Kestrel listens on,
    // with a wildcard host made loopback.
    private string BaseUrl() => BaseUrlOf(_server);

    internal static string BaseUrlOf(IServer server)
    {
        var _server = server;
        var address = _server.Features.Get<IServerAddressesFeature>()?.Addresses.FirstOrDefault(a => a.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
            ?? _server.Features.Get<IServerAddressesFeature>()?.Addresses.FirstOrDefault()
            ?? "http://127.0.0.1:8080";
        var uri = new UriBuilder(address.Replace("://+", "://localhost").Replace("://*", "://localhost").Replace("://[::]", "://localhost").Replace("://0.0.0.0", "://localhost"));
        if (uri.Host is "localhost") uri.Host = "127.0.0.1";
        return uri.Uri.GetLeftPart(UriPartial.Authority);
    }
}

/// <summary>
/// What the server scanner runs with and what it last reported. Its CONFIG (which indices it scans, and the
/// scanner settings - strategies alerted, filters, trailing, option side / strike / lots, SL / target per
/// index) is a JSON file under Storage:ScannerRunnerPath, written by the Order Flow page (an admin's
/// scanner settings are synced to it as they change). Its STATUS (per index: the last look, the day's
/// signals and paper trades, errors) is posted by the runner every few seconds and kept in memory.
/// </summary>
public sealed class ScannerRunnerStore
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly string _configPath;
    private readonly object _lock = new();
    private JsonObject _config;
    private JsonNode? _status;
    private DateTimeOffset? _statusAt;
    private (string State, string? Note, int? Pid, DateTimeOffset At) _process = ("not started", null, null, DateTimeOffset.UtcNow);

    public ScannerRunnerStore(IHostEnvironment environment, IConfiguration configuration)
    {
        var configured = configuration["Storage:ScannerRunnerPath"];
        var path = string.IsNullOrWhiteSpace(configured) ? "scanner-runner-data" : configured;
        DataDirectory = Path.IsPathRooted(path) ? path : Path.Combine(environment.ContentRootPath, path);
        Directory.CreateDirectory(DataDirectory);
        _configPath = Path.Combine(DataDirectory, "config.json");
        _config = Load(_configPath);
    }

    public string DataDirectory { get; }

    /// <summary>The indices scanned unless switched off.</summary>
    public static readonly string[] Underlyings = { "NIFTY", "BANKNIFTY", "SENSEX" };

    private static JsonObject Load(string path)
    {
        try
        {
            if (File.Exists(path) && JsonNode.Parse(File.ReadAllText(path)) is JsonObject saved) return saved;
        }
        catch { /* a broken file starts over */ }
        return new JsonObject();
    }

    public JsonObject Config()
    {
        lock (_lock)
        {
            var copy = (JsonObject)_config.DeepClone();
            if (copy["enabled"] is not JsonObject enabled)
            {
                enabled = new JsonObject();
                copy["enabled"] = enabled;
            }
            foreach (var u in Underlyings) enabled[u] ??= true;
            return copy;
        }
    }

    /// <summary>Merges the given top-level keys (settings, levels, enabled ...) into the saved config.</summary>
    public JsonObject Update(JsonObject patch)
    {
        lock (_lock)
        {
            foreach (var (key, value) in patch)
            {
                if (key == "enabled" && value is JsonObject enabledPatch)
                {
                    var enabled = _config["enabled"] as JsonObject ?? new JsonObject();
                    foreach (var (u, v) in enabledPatch) if (Underlyings.Contains(u)) enabled[u] = v?.GetValue<bool>() ?? true;
                    _config["enabled"] = enabled;
                }
                else _config[key] = value?.DeepClone();
            }
            _config["updatedUtc"] = DateTimeOffset.UtcNow;
            var temp = _configPath + ".tmp";
            File.WriteAllText(temp, _config.ToJsonString(Json));
            File.Move(temp, _configPath, overwrite: true);
        }
        return Config();
    }

    public void SetStatus(JsonNode status)
    {
        lock (_lock) { _status = status.DeepClone(); _statusAt = DateTimeOffset.UtcNow; }
    }

    public void SetProcess(string state, string? note, int? pid = null)
    {
        lock (_lock) _process = (state, note, pid, DateTimeOffset.UtcNow);
    }

    public object Status()
    {
        lock (_lock)
        {
            return new
            {
                process = new { state = _process.State, note = _process.Note, pid = _process.Pid, sinceUtc = _process.At },
                reportedUtc = _statusAt,
                // A runner that has not reported for a while is shown as stale, whatever it last said.
                stale = _statusAt is null || DateTimeOffset.UtcNow - _statusAt > TimeSpan.FromSeconds(60),
                status = _status?.DeepClone(),
            };
        }
    }
}

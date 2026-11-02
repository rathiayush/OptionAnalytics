using System.Diagnostics;
using Microsoft.AspNetCore.Hosting.Server;
using OptionAnalytics.Server.Auth;

namespace OptionAnalytics.Server.Services.SignalStrategies;

/// <summary>
/// Keeps the saved strategies' LIVE scan running: scanner-runner/signal-live.mjs in its own Node process with the runner's
/// key (paper only - the Runner role reaches no live-trading API), started once this server listens and started again when
/// it exits (5 s after a long run, doubling to a minute while it keeps dying). The process itself works only in the
/// session (IST weekdays) and idles otherwise; it reads today from the server's memory, so it adds no Dhan polling.
/// "SignalLive:Enabled" false turns it off; "SignalLive:ScriptPath" points elsewhere (tests).
/// </summary>
public sealed class SignalLiveHostedService : BackgroundService
{
    private readonly IConfiguration _configuration;
    private readonly IHostEnvironment _environment;
    private readonly IHostApplicationLifetime _lifetime;
    private readonly IServer _server;
    private readonly ScannerRunnerKey _key;
    private readonly ILogger<SignalLiveHostedService> _logger;

    /// <summary>What the page shows: off / missing / running / exited / failed.</summary>
    public string State { get; private set; } = "starting";

    public SignalLiveHostedService(IConfiguration configuration, IHostEnvironment environment, IHostApplicationLifetime lifetime, IServer server,
        ScannerRunnerKey key, ILogger<SignalLiveHostedService> logger)
    {
        _configuration = configuration;
        _environment = environment;
        _lifetime = lifetime;
        _server = server;
        _key = key;
        _logger = logger;
    }

    internal string ScriptPath() => _configuration["SignalLive:ScriptPath"] is { Length: > 0 } configured
        ? Path.GetFullPath(configured, _environment.ContentRootPath)
        : Path.Combine(_environment.ContentRootPath, "scanner-runner", "signal-live.mjs");

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_configuration.GetValue("SignalLive:Enabled", true)) { State = "off"; return; }
        var script = ScriptPath();
        if (!File.Exists(script))
        {
            State = "missing";
            _logger.LogInformation("Saved strategies live scan: {Script} not found - not started (build it with `npm run build:runner`).", script);
            return;
        }
        // Only once Kestrel is listening - the process's first call is to this server.
        var started = new TaskCompletionSource();
        using (_lifetime.ApplicationStarted.Register(() => started.TrySetResult()))
        using (stoppingToken.Register(() => started.TrySetCanceled()))
        {
            try { await started.Task; } catch (OperationCanceledException) { return; }
        }
        // No Dhan call is made here - the process's requests are the runner's (background) ones.
        using var background = MarketHours.BackgroundScope();
        var delay = TimeSpan.FromSeconds(5);
        while (!stoppingToken.IsCancellationRequested)
        {
            var startedAt = DateTimeOffset.UtcNow;
            try { await RunOnceAsync(script, stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex)
            {
                State = "failed";
                _logger.LogWarning(ex, "Saved strategies live scan could not be started.");
            }
            delay = DateTimeOffset.UtcNow - startedAt > TimeSpan.FromMinutes(5) ? TimeSpan.FromSeconds(5) : TimeSpan.FromSeconds(Math.Min(60, delay.TotalSeconds * 2));
            try { await Task.Delay(delay, stoppingToken); } catch (OperationCanceledException) { break; }
        }
    }

    private async Task RunOnceAsync(string script, CancellationToken stoppingToken)
    {
        var node = _configuration["ScannerRunner:NodePath"] is { Length: > 0 } n ? n : "node";
        var info = new ProcessStartInfo(node)
        {
            RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(script)!,
        };
        info.ArgumentList.Add(script);
        info.Environment["RUNNER_BASE_URL"] = ScannerRunnerHostedService.BaseUrlOf(_server);
        info.Environment["RUNNER_KEY"] = _key.Value;
        using var process = new Process { StartInfo = info, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, e) => { if (e.Data is { Length: > 0 } line) _logger.LogInformation("[signal-live] {Line}", line); };
        process.ErrorDataReceived += (_, e) => { if (e.Data is { Length: > 0 } line) _logger.LogWarning("[signal-live] {Line}", line); };
        if (!process.Start()) throw new InvalidOperationException($"{node} did not start");
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        State = "running";
        try
        {
            await process.WaitForExitAsync(stoppingToken);
            State = "exited";
            _logger.LogWarning("Saved strategies live scan exited with code {Code}.", process.ExitCode);
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch { /* already gone */ }
            State = "stopped";
            throw;
        }
    }
}

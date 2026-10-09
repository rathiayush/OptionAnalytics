using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>StrategyTuningService - runs the tuning job (a stand-in script here) one at a time and keeps its result.</summary>
public sealed class StrategyTuningServiceTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "oa-tuning-" + Guid.NewGuid().ToString("n"));

    private sealed class FakeHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "Tests";
        public string ContentRootPath { get; set; } = "";
        public IFileProvider ContentRootFileProvider { get; set; } = null!;
    }

    private sealed class FakeServer : IServer
    {
        public FakeServer()
        {
            var addresses = new ServerAddressesFeature();
            addresses.Addresses.Add("http://127.0.0.1:5099");
            Features.Set<IServerAddressesFeature>(addresses);
        }
        public IFeatureCollection Features { get; } = new FeatureCollection();
        public void Dispose() { }
        public Task StartAsync<TContext>(IHttpApplication<TContext> application, CancellationToken cancellationToken) where TContext : notnull => Task.CompletedTask;
        public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    }

    private sealed class FakeLifetime : IHostApplicationLifetime
    {
        public CancellationToken ApplicationStarted => CancellationToken.None;
        public CancellationToken ApplicationStopping => CancellationToken.None;
        public CancellationToken ApplicationStopped => CancellationToken.None;
        public void StopApplication() { }
    }

    private StrategyTuningService Service(string script)
    {
        Directory.CreateDirectory(_dir);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Storage:ScannerRunnerPath"] = Path.Combine(_dir, "runner"),
            ["StrategyTuning:ScriptPath"] = script,
        }).Build();
        var env = new FakeHostEnvironment { ContentRootPath = _dir };
        return new StrategyTuningService(config, env, new FakeServer(), new ScannerRunnerKey(), new ScannerRunnerStore(env, config), new FakeLifetime(), NullLogger<StrategyTuningService>.Instance);
    }

    private string Script(string body)
    {
        Directory.CreateDirectory(_dir);
        var path = Path.Combine(_dir, $"fake-{Guid.NewGuid():n}.mjs");
        File.WriteAllText(path, body);
        return path;
    }

    private static async Task<TuningStatus> UntilDone(StrategyTuningService s)
    {
        for (var i = 0; i < 200 && s.Status().State == "running"; i++) await Task.Delay(50);
        return s.Status();
    }

    private static TuningJob Job(string u = "NIFTY") => new(u, JsonValue.Create("top3"), 30, false, 8);

    [Fact]
    public void AMissingScript_IsReported()
    {
        var error = Service(Path.Combine(_dir, "nope.mjs")).Start(Job());
        Assert.Contains("not on the server", error);
    }

    [Fact]
    public async Task AJobThatSucceeds_KeepsItsResult_AndPassesTheJobAndKey()
    {
        var script = Script("""
            import { writeFileSync } from 'node:fs'
            const job = JSON.parse(process.env.TUNE_JOB)
            console.log('PROGRESS ' + JSON.stringify({ stage: 'scan', done: 0, total: 1 }))
            writeFileSync(process.env.TUNE_OUT, JSON.stringify({ ok: true, underlying: job.underlying, key: process.env.RUNNER_KEY.length > 0, base: process.env.RUNNER_BASE_URL, days: job.days }))
            """);
        var s = Service(script);
        Assert.Null(s.Start(Job("SENSEX")));
        Assert.Contains("already running", s.Start(Job()) ?? "");
        var done = await UntilDone(s);
        Assert.Equal("done", done.State);
        var result = s.Result("SENSEX");
        Assert.NotNull(result);
        Assert.Equal("SENSEX", result!["underlying"]!.GetValue<string>());
        Assert.True(result["key"]!.GetValue<bool>());
        Assert.Equal("http://127.0.0.1:5099", result["base"]!.GetValue<string>());
        Assert.Equal(30, result["days"]!.GetValue<int>());
        Assert.Null(s.Result("NIFTY"));
        Assert.Equal(2, Directory.GetFiles(Path.Combine(_dir, "runner", "tuning"), "SENSEX-*.json").Length); // latest + a dated copy
    }

    [Fact]
    public async Task AJobThatFails_SaysWhy_AndLeavesTheLastResult()
    {
        var ok = Service(Script("import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.TUNE_OUT, JSON.stringify({ ok: true, underlying: 'NIFTY', n: 1 }))"));
        Assert.Null(ok.Start(Job()));
        await UntilDone(ok);
        var failing = Service(Script("import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.TUNE_OUT, JSON.stringify({ ok: false, error: 'no recorded past days' }))\nprocess.exit(1)"));
        Assert.Null(failing.Start(Job()));
        var status = await UntilDone(failing);
        Assert.Equal("failed", status.State);
        Assert.Equal("no recorded past days", status.Error);
        Assert.Equal(1, failing.Result("NIFTY")!["n"]!.GetValue<int>());
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, true); } catch { /* temp */ }
    }
}

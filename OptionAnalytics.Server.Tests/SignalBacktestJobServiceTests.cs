using System.Reflection;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Controllers;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>SignalBacktestJobService - the Signal backtest's background runs: queued (now or at a time), run one at a time
/// by the job script (a stand-in here), the report kept, Telegram at the end, each account's own, a restart queues a cut-off
/// run again, and what is asked for is checked.</summary>
public sealed class SignalBacktestJobServiceTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "oa-sbt-" + Guid.NewGuid().ToString("n"));
    private readonly List<SignalBacktestJobService> _services = new();
    // A Monday afternoon, IST: the days before it are past.
    private static readonly DateTimeOffset Now = new(2026, 10, 26, 10, 0, 0, TimeSpan.Zero);

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

    private SignalBacktestJobService Service(string script, List<string>? telegrams = null)
    {
        Directory.CreateDirectory(_dir);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Storage:ScannerRunnerPath"] = Path.Combine(_dir, "runner"),
            ["SignalBacktest:ScriptPath"] = script,
        }).Build();
        var env = new FakeHostEnvironment { ContentRootPath = _dir };
        var service = new SignalBacktestJobService(config, env, new FakeServer(), new ScannerRunnerKey(), new ScannerRunnerStore(env, config), new FakeLifetime(),
            NullLogger<SignalBacktestJobService>.Instance);
        service.NotifyOverride = (text, _) => { lock (telegrams ?? new List<string>()) telegrams?.Add(text); return Task.CompletedTask; };
        _services.Add(service);
        return service;
    }

    private string JobsDir => Path.Combine(_dir, "runner", "signal-backtests");

    private string Script(string body)
    {
        Directory.CreateDirectory(_dir);
        var path = Path.Combine(_dir, $"fake-{Guid.NewGuid():n}.mjs");
        File.WriteAllText(path, body);
        return path;
    }

    // Writes the report the real job writes (its numbers only), after echoing what it was given.
    private string GoodScript(int delayMs = 0) => Script($$"""
        import { writeFileSync } from 'node:fs'
        const job = JSON.parse(process.env.BACKTEST_JOB)
        console.log('PROGRESS ' + JSON.stringify({ stage: 'day', day: job.from, done: 0, total: 3, trades: 0, net: 0 }))
        await new Promise((r) => setTimeout(r, {{delayMs}}))
        writeFileSync(process.env.BACKTEST_OUT, JSON.stringify({ ok: true, settings: job, key: process.env.RUNNER_KEY.length,
          report: { all: { net: 123456.4, trades: 5, winRate: 60, profitFactor: 'Infinity' }, okDays: 3, failed: [{ date: '2026-10-21', reason: 'holiday' }], trades: [] } }))
        """);

    private static JsonObject Settings(string u = "NIFTY", string from = "2026-10-19", string to = "2026-10-23") =>
        new() { ["underlying"] = u, ["from"] = from, ["to"] = to, ["rule"] = new JsonObject { ["action"] = "buyCE" }, ["slPct"] = 30 };

    private static SignalBacktestRequest Request(JsonObject? settings = null, DateTimeOffset? startAt = null, bool telegram = true, string? name = "my run") =>
        new(settings ?? Settings(), name, startAt, telegram);

    private static async Task<SignalBacktestJob> UntilEnded(SignalBacktestJobService s, string id)
    {
        for (var i = 0; i < 300; i++)
        {
            var job = s.Get(id, null)!;
            if (job.State is not ("queued" or "running") && !s.IsBusy) return job;
            await Task.Delay(50);
        }
        return s.Get(id, null)!;
    }

    [Fact]
    public async Task A_run_is_queued_run_in_the_background_and_its_report_kept()
    {
        var telegrams = new List<string>();
        var s = Service(GoodScript(), telegrams);
        var (job, error) = s.Add("user@x.com", Request(), Now);
        Assert.Null(error);
        Assert.Equal("queued", job!.State);
        Assert.Equal(5, job.Days);
        Assert.Equal("my run", job.Name);
        Assert.True(File.Exists(Path.Combine(JobsDir, $"{job.Id}.json")));   // kept on disk from the start

        Assert.True(s.TryStartNext(Now));
        Assert.Equal("running", s.Get(job.Id, null)!.State);
        var done = await UntilEnded(s, job.Id);
        Assert.Equal("done", done.State);
        Assert.Equal(1, done.Attempts);
        Assert.Equal(123456.4, done.Summary!["net"]!.GetValue<double>());
        Assert.Equal(5, done.Summary["trades"]!.GetValue<double>());
        Assert.Equal(1, done.Summary["failedDays"]!.GetValue<double>());
        // The report is the file the job wrote - its settings the request's, the runner's key handed to it.
        var report = JsonNode.Parse(File.ReadAllText(s.ResultPath(job.Id, "user@x.com")!))!;
        Assert.Equal("NIFTY", report["settings"]!["underlying"]!.GetValue<string>());
        Assert.Equal(30, report["settings"]!["slPct"]!.GetValue<int>());
        Assert.True(report["key"]!.GetValue<int>() > 0);
        var message = Assert.Single(telegrams);
        Assert.Contains("Signal backtest done", message);
        Assert.Contains("₹1,23,456", message);
        Assert.Contains("5 trades", message);
        Assert.Contains("60% win", message);
        Assert.Contains("1 day(s) not run", message);
    }

    [Fact]
    public async Task One_run_at_a_time_in_the_order_queued()
    {
        var s = Service(GoodScript(delayMs: 400));
        var first = s.Add("a@x.com", Request(name: "first"), Now).Job!;
        var second = s.Add("a@x.com", Request(name: "second"), Now.AddSeconds(1)).Job!;
        Assert.True(s.TryStartNext(Now.AddSeconds(2)));
        Assert.False(s.TryStartNext(Now.AddSeconds(2)));      // the first is still running
        Assert.Equal("running", s.Get(first.Id, null)!.State);
        Assert.Equal("queued", s.Get(second.Id, null)!.State);
        await UntilEnded(s, first.Id);
        Assert.True(s.TryStartNext(Now.AddSeconds(3)));
        Assert.Equal("done", (await UntilEnded(s, second.Id)).State);
    }

    [Fact]
    public async Task A_run_set_for_later_waits_for_its_time()
    {
        var s = Service(GoodScript());
        var at = Now.AddHours(6);
        var job = s.Add("a@x.com", Request(startAt: at), Now).Job!;
        Assert.Equal(at, job.StartAtUtc);
        Assert.False(s.TryStartNext(Now));
        Assert.False(s.TryStartNext(at.AddSeconds(-1)));
        Assert.True(s.TryStartNext(at));
        Assert.Equal("done", (await UntilEnded(s, job.Id)).State);
        // A start time already past is "now".
        Assert.Null(s.Add("a@x.com", Request(startAt: Now.AddMinutes(-5)), Now).Job!.StartAtUtc);
    }

    [Fact]
    public async Task A_failed_run_says_why_and_a_stopped_one_is_cancelled()
    {
        var telegrams = new List<string>();
        var failing = Service(Script("""
            import { writeFileSync } from 'node:fs'
            writeFileSync(process.env.BACKTEST_OUT, JSON.stringify({ ok: false, error: 'no past weekdays in the range' }))
            process.exit(1)
            """), telegrams);
        var job = failing.Add("a@x.com", Request(), Now).Job!;
        failing.TryStartNext(Now);
        var failed = await UntilEnded(failing, job.Id);
        Assert.Equal("failed", failed.State);
        Assert.Equal("no past weekdays in the range", failed.Error);
        Assert.Null(failing.ResultPath(job.Id, null));
        Assert.Contains("Signal backtest failed", Assert.Single(telegrams));

        var slow = Service(GoodScript(delayMs: 20_000), telegrams);
        var running = slow.Add("a@x.com", Request(), Now).Job!;
        var waiting = slow.Add("a@x.com", Request(), Now).Job!;
        slow.TryStartNext(Now);
        Assert.True(slow.Cancel(running.Id, "a@x.com"));
        Assert.True(slow.Cancel(waiting.Id, "a@x.com"));
        Assert.Equal("cancelled", (await UntilEnded(slow, running.Id)).State);
        Assert.Equal("cancelled", slow.Get(waiting.Id, null)!.State);
        Assert.False(slow.TryStartNext(Now));                  // nothing left to run
        Assert.Single(telegrams);                              // no message for a stopped run
    }

    [Fact]
    public async Task Each_account_sees_its_own_runs_and_an_admin_all()
    {
        var s = Service(GoodScript());
        var mine = s.Add("me@x.com", Request(), Now).Job!;
        var theirs = s.Add("them@x.com", Request(), Now.AddSeconds(1)).Job!;
        Assert.Equal(new[] { mine.Id }, s.List("ME@x.com").Select(j => j.Id));
        Assert.Equal(2, s.List(null).Count);
        Assert.Null(s.Get(theirs.Id, "me@x.com"));
        Assert.False(s.Cancel(theirs.Id, "me@x.com"));
        Assert.False(s.Delete(theirs.Id, "me@x.com"));
        s.TryStartNext(Now.AddSeconds(2));
        await UntilEnded(s, mine.Id);
        Assert.Null(s.ResultPath(mine.Id, "them@x.com"));
        Assert.NotNull(s.ResultPath(mine.Id, "me@x.com"));
        Assert.NotNull(s.ResultPath(mine.Id, null));
        // Removing a run removes its report.
        var report = s.ResultPath(mine.Id, null)!;
        Assert.True(s.Delete(mine.Id, "me@x.com"));
        Assert.False(File.Exists(report));
        Assert.Empty(s.List("me@x.com"));
    }

    [Fact]
    public void A_restart_queues_a_cut_off_run_again_and_fails_it_after_three_starts()
    {
        var script = GoodScript();
        var s = Service(script);
        var job = s.Add("a@x.com", Request(), Now).Job!;
        // As the server left it when it stopped mid-run.
        var path = Path.Combine(JobsDir, $"{job.Id}.json");
        File.WriteAllText(path, File.ReadAllText(path).Replace("\"state\":\"queued\"", "\"state\":\"running\"").Replace("\"attempts\":0", "\"attempts\":1"));
        File.WriteAllText(Path.Combine(JobsDir, $"{job.Id}.result.json.running"), "{");
        var again = Service(script).Get(job.Id, null)!;
        Assert.Equal("queued", again.State);
        Assert.Equal(1, again.Attempts);
        Assert.Contains("restart", again.Note);
        Assert.False(File.Exists(Path.Combine(JobsDir, $"{job.Id}.result.json.running")));   // a half-written report is dropped

        File.WriteAllText(path, File.ReadAllText(path).Replace("\"state\":\"queued\"", "\"state\":\"running\"").Replace("\"attempts\":1", "\"attempts\":3"));
        var gaveUp = Service(script).Get(job.Id, null)!;
        Assert.Equal("failed", gaveUp.State);
        Assert.Contains("restart 3 times", gaveUp.Error);
    }

    [Fact]
    public void The_oldest_finished_runs_go_past_the_limit()
    {
        var s = Service(GoodScript());
        var first = s.Add("a@x.com", Request(), Now).Job!;
        s.Cancel(first.Id, null);
        for (var k = 1; k < SignalBacktestJobService.MaxJobs; k++)
        {
            var job = s.Add($"u{k % 5}@x.com", Request(), Now.AddMinutes(k)).Job!;
            s.Cancel(job.Id, null);
        }
        Assert.Equal(SignalBacktestJobService.MaxJobs, s.List(null).Count);
        s.Add("a@x.com", Request(), Now.AddDays(1));
        Assert.Equal(SignalBacktestJobService.MaxJobs, s.List(null).Count);
        Assert.Null(s.Get(first.Id, null));                     // the oldest finished one went
        Assert.False(File.Exists(Path.Combine(JobsDir, $"{first.Id}.json")));
    }

    [Fact]
    public void One_account_has_at_most_twenty_runs_waiting()
    {
        var s = Service(GoodScript());
        for (var k = 0; k < SignalBacktestJobService.MaxWaitingPerOwner; k++) Assert.NotNull(s.Add("a@x.com", Request(), Now).Job);
        var (job, error) = s.Add("a@x.com", Request(), Now);
        Assert.Null(job);
        Assert.Contains("already waiting", error);
        Assert.NotNull(s.Add("b@x.com", Request(), Now).Job);
    }

    [Fact]
    public void What_is_asked_for_is_checked()
    {
        string? Error(SignalBacktestRequest r) => SignalBacktestJobService.Validate(r, Now).Error;
        Assert.Contains("missing", Error(new SignalBacktestRequest(null)));
        Assert.Contains("NIFTY, BANKNIFTY or SENSEX", Error(Request(Settings(u: "FINNIFTY"))));
        Assert.Contains("from / to", Error(Request(Settings(from: "19-10-2026"))));
        Assert.Contains("no past weekday", Error(Request(Settings(from: "2026-10-26", to: "2026-10-30"))));   // today and after
        Assert.Contains("no past weekday", Error(Request(Settings(from: "2026-10-24", to: "2026-10-25"))));   // a weekend
        Assert.Contains("days ahead", Error(Request(startAt: Now.AddDays(15))));
        var big = Settings();
        big["rule"] = new string('x', SignalBacktestJobService.MaxSettingsBytes);
        Assert.Contains("too large", Error(Request(big)));

        var (plan, _) = SignalBacktestJobService.Validate(Request(Settings(u: " banknifty ", from: "2026-10-23", to: "2026-10-19"), name: "  "), Now);
        Assert.Equal("BANKNIFTY", plan!.Underlying);
        Assert.Equal(("2026-10-19", "2026-10-23"), (plan.From, plan.To));          // swapped into order
        Assert.Equal("BANKNIFTY", plan.Settings["underlying"]!.GetValue<string>());
        Assert.Equal("BANKNIFTY 19 Oct – 23 Oct", plan.Name);
        Assert.Equal(SignalBacktestJobService.MaxDays, SignalBacktestJobService.Validate(Request(Settings(from: "2024-01-01", to: "2026-10-25")), Now).Plan!.Days);   // the latest 300
        Assert.Equal(300, SignalBacktestJobService.MaxDays);
        Assert.Equal(212, SignalBacktestJobService.Validate(Request(Settings(from: "2026-01-01", to: "2026-10-25")), Now).Plan!.Days);   // a range under it: all of it
        Assert.Equal(1, SignalBacktestJobService.Validate(Request(Settings(from: "2026-10-23", to: "2026-10-30")), Now).Plan!.Days);   // before today only
    }

    [Fact]
    public void A_missing_job_script_fails_the_run_with_the_reason()
    {
        var s = Service(Path.Combine(_dir, "nope.mjs"));
        var job = s.Add("a@x.com", Request(), Now).Job!;
        Assert.False(s.TryStartNext(Now));
        var failed = s.Get(job.Id, null)!;
        Assert.Equal("failed", failed.State);
        Assert.Contains("npm run build:runner", failed.Error);
    }

    [Fact]
    public void Only_admin_and_user_accounts_reach_the_runs()
    {
        var roles = typeof(SignalBacktestController).GetCustomAttribute<AuthorizeAttribute>()!.Roles!.Split(',');
        Assert.Equal(new[] { AuthRoles.Admin, AuthRoles.User }, roles);   // not the server scanner's Runner key, not External
        Assert.DoesNotContain(ScannerRunnerKey.Role, roles);
    }

    public void Dispose()
    {
        foreach (var s in _services)
            foreach (var job in s.List(null).Where(j => j.State == "running")) s.Cancel(job.Id, null);
        Thread.Sleep(100);
        try { Directory.Delete(_dir, recursive: true); } catch { /* best effort */ }
    }
}

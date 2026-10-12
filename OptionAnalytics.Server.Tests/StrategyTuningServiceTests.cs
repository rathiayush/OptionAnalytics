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

    private StrategyTuningService Service(string script, int? maxResumes = null)
    {
        Directory.CreateDirectory(_dir);
        var settings = new Dictionary<string, string?>
        {
            ["Storage:ScannerRunnerPath"] = Path.Combine(_dir, "runner"),
            ["StrategyTuning:ScriptPath"] = script,
        };
        if (maxResumes is { } max) settings["StrategyTuning:MaxResumes"] = max.ToString();
        var config = new ConfigurationBuilder().AddInMemoryCollection(settings).Build();
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
        Assert.Null(s.Result("SENSEX", "spot")); // the spot + options mode keeps its own result
        Assert.NotEqual(s.ResultPath("SENSEX"), s.ResultPath("SENSEX", "spot"));
        Assert.EndsWith("SENSEX-spot-latest.json", s.ResultPath("sensex", "spot"));
        Assert.Equal(2, Directory.GetFiles(Path.Combine(_dir, "runner", "tuning"), "SENSEX-*.json").Length); // latest + a dated copy
    }

    [Fact]
    public async Task ARunByHand_IsOnTheScheduleToo_AndItsEndAndRunAreRecorded()
    {
        var s = Service(Script("import { writeFileSync } from 'node:fs'\nconsole.log('HISTORY NIFTY-futures-20261010-120000 (0 trades, 0 settings)')\nwriteFileSync(process.env.TUNE_OUT, JSON.stringify({ ok: true, underlying: 'NIFTY' }))"));
        var queue = new StrategyTuningQueue(s, NullLogger<StrategyTuningQueue>.Instance);
        Assert.Null(s.Start(Job()));
        var item = queue.AddStarted(Job(), DateTimeOffset.UtcNow);
        Assert.Equal(("running", "manual"), (item.State, item.Source));
        queue.Tick(DateTimeOffset.UtcNow); // still running: nothing else is started beside it
        await UntilDone(s);
        queue.Tick(DateTimeOffset.UtcNow);
        var done = queue.Items().Single(i => i.Id == item.Id);
        Assert.Equal(("done", "NIFTY-futures-20261010-120000", "manual"), (done.State, done.RunId, done.Source));
        // Kept across a restart of the server (queue.json).
        Assert.Contains(new StrategyTuningQueue(s, NullLogger<StrategyTuningQueue>.Instance).Items(), i => i.Id == item.Id && i.Source == "manual");
    }

    [Fact]
    public async Task DeletingAFinishedJob_RemovesItsRunResultAndCachedDays_AndNothingElse()
    {
        // A fake tuning job: writes its history run, a result naming it, its cached days (NIFTY's folder + an older file
        // with no index folder for one of its dates), and prints the run id as tune.mjs does. Another run and another
        // index's cache are there beside it and must stay.
        const string runId = "NIFTY-futures-20261010-153000";
        var script = Script($$"""
            import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
            import { join } from 'node:path'
            const h = process.env.TUNE_HISTORY_DIR, c = process.env.TUNE_CACHE_DIR
            mkdirSync(h, { recursive: true })
            writeFileSync(join(h, 'runs.csv'), 'run_id,finished_ist,index,data,from,to,first_day,last_day\nNIFTY-futures-20261001-100000,2026-10-01 10:00:00,NIFTY,futures,,,2026-09-01,2026-09-02\n{{runId}},2026-10-10 15:30:00,NIFTY,futures,,,2026-10-06,2026-10-07\n')
            for (const k of ['trades', 'settings', 'days']) writeFileSync(join(h, '{{runId}}-' + k + '.csv'), k === 'days' ? 'run_id,index,date,status\n{{runId}},NIFTY,2026-10-06,used\n{{runId}},NIFTY,2026-10-07,left out\n' : 'x\n1\n')
            writeFileSync(join(h, 'NIFTY-futures-20261001-100000-trades.csv'), 'x\n1\n')
            for (const [dir, name] of [['v1/NIFTY/2026-10', '2026-10-06-oi-a.json.gz'], ['v1/NIFTY/2026-10', '2026-10-07-flow-b.json.gz'], ['v1/NIFTY/2026-10', '2026-10-01-oi-c.json.gz'],
              ['v1/BANKNIFTY/2026-10', '2026-10-06-oi-d.json.gz'], ['v1/2026-10', '2026-10-06-oi-e.json.gz'], ['v1/2026-10', '2026-10-02-oi-f.json.gz']]) {
              mkdirSync(join(c, dir), { recursive: true }); writeFileSync(join(c, dir, name), 'x')
            }
            console.log('HISTORY {{runId}} (1 trades, 1 settings)')
            writeFileSync(process.env.TUNE_OUT, JSON.stringify({ ok: true, runId: '{{runId}}', underlying: 'NIFTY' }))
            """);
        var s = Service(script);
        var queue = new StrategyTuningQueue(s, NullLogger<StrategyTuningQueue>.Instance);
        var item = queue.Add(Job(), null, false);
        queue.Tick(DateTimeOffset.UtcNow);
        await UntilDone(s);
        queue.Tick(DateTimeOffset.UtcNow);
        var finished = queue.Items().Single(i => i.Id == item.Id);
        Assert.Equal(("done", runId), (finished.State, finished.RunId));
        var tuning = Path.Combine(_dir, "runner", "tuning");
        var cache = Path.Combine(tuning, "cache", "v1");
        // An older result of another run stays (it names its own run).
        File.WriteAllText(Path.Combine(tuning, "NIFTY-20261001-100000.json"), "{\"runId\":\"NIFTY-futures-20261001-100000\",\"underlying\":\"NIFTY\"}");

        var (deleted, error) = queue.Delete(item.Id);

        Assert.Null(error);
        Assert.Equal((3, 2, 3, true), (deleted!.HistoryFiles, deleted.ResultFiles, deleted.CacheFiles, deleted.RunRow)); // latest + dated copy; 2 NIFTY days + the older file of 06 Oct
        Assert.Empty(Directory.GetFiles(Path.Combine(tuning, "history"), runId + "*"));
        Assert.DoesNotContain(runId, File.ReadAllText(Path.Combine(tuning, "history", "runs.csv")));
        Assert.Contains("NIFTY-futures-20261001-100000", File.ReadAllText(Path.Combine(tuning, "history", "runs.csv")));
        Assert.True(File.Exists(Path.Combine(tuning, "history", "NIFTY-futures-20261001-100000-trades.csv")));
        Assert.True(File.Exists(Path.Combine(tuning, "NIFTY-20261001-100000.json")));
        Assert.Null(s.Result("NIFTY"));
        Assert.Equal(new[] { "2026-10-01-oi-c.json.gz" }, Directory.GetFiles(Path.Combine(cache, "NIFTY", "2026-10")).Select(Path.GetFileName));
        Assert.True(File.Exists(Path.Combine(cache, "BANKNIFTY", "2026-10", "2026-10-06-oi-d.json.gz"))); // another index's day stays
        Assert.Equal(new[] { "2026-10-02-oi-f.json.gz" }, Directory.GetFiles(Path.Combine(cache, "2026-10")).Select(Path.GetFileName));
        Assert.DoesNotContain(queue.Items(), i => i.Id == item.Id);
        // A queued job: just taken off; an unknown one: said so.
        var queued = queue.Add(Job(), DateTimeOffset.UtcNow.AddDays(1), false);
        Assert.Null(queue.Delete(queued.Id).Error);
        Assert.NotNull(queue.Delete("nope").Error);
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

    // ---- a job the server was stopped in the middle of: resumed, but not for ever ----------------

    private string CurrentJobPath => Path.Combine(_dir, "runner", "tuning", "current-job.json");

    [Fact]
    public async Task AnInterruptedJob_IsResumed_AndToldWhichAttemptItIs()
    {
        var s = Service(Script("import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.TUNE_OUT, JSON.stringify({ ok: true, underlying: 'NIFTY', attempt: JSON.parse(process.env.TUNE_JOB).attempt, resumed: JSON.parse(process.env.TUNE_JOB).resumed }))"));
        // A job the server was stopped in the middle of: its record left behind on disk.
        Directory.CreateDirectory(Path.GetDirectoryName(CurrentJobPath)!);
        File.WriteAllText(CurrentJobPath, """{"underlying":"NIFTY","strategies":"top3","days":30,"includeEstimated":false,"minTrades":8}""");

        Assert.Null(s.ResumeInterrupted());
        await UntilDone(s);

        var result = s.Result("NIFTY")!;
        Assert.Equal(1, result["attempt"]!.GetValue<int>());
        Assert.True(result["resumed"]!.GetValue<bool>());
    }

    [Fact]
    public void AResumedJobsOwnRecordKeepsTheAttemptCount_WhichIsWhatEndsARestartLoop()
    {
        // THE fault: Start rewrote the record from scratch each time, so the attempt count never
        // survived the restart that used it and a job that kept dying kept being started again.
        var s = Service(Script("setTimeout(() => {}, 30_000)")); // stays alive, so its record is still there to read
        Directory.CreateDirectory(Path.GetDirectoryName(CurrentJobPath)!);
        File.WriteAllText(CurrentJobPath, """{"underlying":"NIFTY","strategies":"top3","days":30,"includeEstimated":false,"minTrades":8,"attempt":1}""");

        Assert.Null(s.ResumeInterrupted());

        var kept = JsonNode.Parse(File.ReadAllText(CurrentJobPath))!;
        Assert.Equal(2, kept["attempt"]!.GetValue<int>());
        Assert.False(kept["resumed"]!.GetValue<bool>()); // the next start is its own, but it is the 2nd attempt
        s.Cancel(); // from the page: forgotten
        Assert.False(File.Exists(CurrentJobPath));
    }

    [Fact]
    public void AJobThatKeepsDyingIsGivenUpOn_NotStartedAgainForEver()
    {
        // The actual fault: Start used to rewrite the record with a clean slate, so a job that died
        // the moment it started was started again after EVERY restart, for ever.
        var s = Service(Script("process.exit(1)"), maxResumes: 2);
        Directory.CreateDirectory(Path.GetDirectoryName(CurrentJobPath)!);
        File.WriteAllText(CurrentJobPath, """{"underlying":"NIFTY","strategies":"top3","days":30,"includeEstimated":false,"minTrades":8,"attempt":2}""");

        var reason = s.ResumeInterrupted();

        Assert.NotNull(reason);
        Assert.Contains("is not being started again", reason);
        Assert.Contains("2 time(s) already", reason);
        Assert.Equal("failed", s.Status().State);
        Assert.Equal(reason, s.Status().Error);
        // The record is gone, so the NEXT restart does not try either.
        Assert.False(File.Exists(CurrentJobPath));
        Assert.Null(s.ResumeInterrupted());
    }

    [Fact]
    public void NoInterruptedJob_IsNothingToResume()
    {
        Assert.Null(Service(Script("process.exit(0)")).ResumeInterrupted());
    }

    [Fact]
    public async Task TheJobIsToldItsOwnTimeBudgetAndItsPerDayFetchLimit()
    {
        // Both hard stops reach the job as environment: a job with no budget is the fault being fixed.
        var s = Service(Script("import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.TUNE_OUT, JSON.stringify({ ok: true, underlying: 'NIFTY', budget: process.env.TUNE_JOB_BUDGET_MS, perDay: process.env.TUNE_MAX_FETCHES_PER_DAY }))"));
        Assert.Null(s.Start(Job()));
        await UntilDone(s);

        var result = s.Result("NIFTY")!;
        Assert.Equal((90 * 60_000).ToString(), result["budget"]!.GetValue<string>());
        Assert.Equal("3", result["perDay"]!.GetValue<string>());
    }

    // ---- the tuning HISTORY: every run kept as CSV (no database) -------------------------------------------------
    private void WriteRun(StrategyTuningService s, string runId, string index, string finished)
    {
        Directory.CreateDirectory(s.HistoryDirectory);
        var runs = Path.Combine(s.HistoryDirectory, "runs.csv");
        if (!File.Exists(runs)) File.WriteAllText(runs, "run_id,finished_ist,index,data,tuned,days_used,trades\n");
        File.AppendAllText(runs, $"{runId},{finished},{index},futures,both,6,1\n");
        File.WriteAllText(Path.Combine(s.HistoryDirectory, $"{runId}-trades.csv"),
            "run_id,date,entry_time_ist,index,strategy_id,setting,points,why\n" +
            $"{runId},2026-09-10,2026-09-10 10:16:00,{index},wallBreak,as written,45.0,\"OI: wall break, writers run · Tape: 63% buy\"\n");
        File.WriteAllText(Path.Combine(s.HistoryDirectory, $"{runId}-settings.csv"),
            "run_id,index,strategy_id,which,tradeSide,train_avg\n" + $"{runId},{index},wallBreak,fine-tuned,long,1.25\n");
    }

    [Fact]
    public void History_ListsTheRunsNewestFirst_AndReadsEachRunsTradesAndSettings()
    {
        var s = Service(Script("process.exit(0)"));
        Assert.Empty(s.HistoryRuns()); // nothing tuned yet
        WriteRun(s, "NIFTY-futures-20261009-103000", "NIFTY", "2026-10-09 10:30:00");
        WriteRun(s, "BANKNIFTY-futures-20261009-113000", "BANKNIFTY", "2026-10-09 11:30:00");

        Assert.Equal(new[] { "BANKNIFTY", "NIFTY" }, s.HistoryRuns().Select(r => r["index"]));
        var t = Assert.Single(s.HistoryRows("NIFTY-futures-20261009-103000", "trades")!);
        Assert.Equal(("2026-09-10", "NIFTY", "45.0"), (t["date"], t["index"], t["points"]));
        Assert.Equal("OI: wall break, writers run · Tape: 63% buy", t["why"]); // a quoted field keeps its commas
        Assert.Equal("fine-tuned", Assert.Single(s.HistoryRows("NIFTY-futures-20261009-103000", "settings")!)["which"]);
    }

    [Fact]
    public void History_RefusesARunIdThisServerDidNotWrite()
    {
        var s = Service(Script("process.exit(0)"));
        WriteRun(s, "NIFTY-futures-20261009-103000", "NIFTY", "2026-10-09 10:30:00");
        foreach (var bad in new[] { "../../appsettings", "NIFTY-futures-20261009-103000/../../secret", "..", "NIFTY-futures-2026", "" })
        {
            Assert.Null(s.HistoryPath(bad, "trades"));
            Assert.Null(s.HistoryRows(bad, "trades"));
        }
        Assert.Null(s.HistoryPath("NIFTY-futures-20261009-103000", "../runs")); // only trades / settings
        Assert.Null(s.HistoryPath("NIFTY-futures-20261009-999999", "trades")); // well formed, but no such run
        Assert.NotNull(s.HistoryPath("NIFTY-futures-20261009-103000", "trades"));
    }

    [Fact]
    public void History_PruningKeepsTheNewestRuns_AndTakesTheOldOnesFilesWithThem()
    {
        var s = Service(Script("process.exit(0)"));
        for (var i = 1; i <= 5; i++) WriteRun(s, $"NIFTY-futures-2026100{i}-103000", "NIFTY", $"2026-10-0{i} 10:30:00");
        s.PruneHistory(3);

        Assert.Equal(new[] { "2026-10-05 10:30:00", "2026-10-04 10:30:00", "2026-10-03 10:30:00" }, s.HistoryRuns().Select(r => r["finished_ist"]));
        Assert.Null(s.HistoryPath("NIFTY-futures-20261002-103000", "trades")); // the old run's files went with its row
        Assert.Single(s.HistoryRows("NIFTY-futures-20261005-103000", "trades")!);
        s.PruneHistory(10); // nothing left to drop
        Assert.Equal(3, s.HistoryRuns().Count);
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, true); } catch { /* temp */ }
    }

    // ---- The schedule: jobs run one at a time --------------------------------------------------------------------

    private string OkScript() => Script("import { writeFileSync } from 'node:fs'\nconst job = JSON.parse(process.env.TUNE_JOB)\nsetTimeout(() => writeFileSync(process.env.TUNE_OUT, JSON.stringify({ ok: true, underlying: job.underlying })), 200)");

    [Fact]
    public async Task TheSchedule_RunsItsJobsOneAtATime_InOrder_AndRecordsHowEachEnded()
    {
        var s = Service(OkScript());
        var queue = new StrategyTuningQueue(s, NullLogger<StrategyTuningQueue>.Instance);
        var now = DateTimeOffset.UtcNow;
        queue.Add(Job("NIFTY"), null, false);
        queue.Add(Job("BANKNIFTY"), null, false);
        queue.Add(Job("SENSEX"), now.AddHours(2), false); // not due yet

        queue.Tick(now);
        Assert.Equal(new[] { "running", "queued", "queued" }, queue.Items().Select(i => i.State));
        Assert.Equal("NIFTY", s.Status().Job?.Underlying);
        queue.Tick(now); // still running: nothing else starts
        Assert.Single(queue.Items(), i => i.State == "running");

        await UntilDone(s);
        queue.Tick(now);
        Assert.Equal(new[] { "done", "running", "queued" }, queue.Items().Select(i => i.State));
        Assert.Equal("BANKNIFTY", s.Status().Job?.Underlying);

        await UntilDone(s);
        queue.Tick(now);
        Assert.Equal(new[] { "done", "done", "queued" }, queue.Items().Select(i => i.State));
        queue.Tick(now.AddHours(3)); // now due
        Assert.Equal("running", queue.Items()[2].State);
        await UntilDone(s);

        // A restart keeps the schedule.
        var reloaded = new StrategyTuningQueue(s, NullLogger<StrategyTuningQueue>.Instance);
        Assert.Equal(3, reloaded.Items().Count);
        reloaded.Tick(now.AddHours(3));
        Assert.Equal("done", reloaded.Items()[2].State);
        reloaded.ClearFinished();
        Assert.Empty(reloaded.Items());
    }

    [Fact]
    public async Task ARepeatingJob_IsScheduledAgainForTheNextDay_AndAQueuedOneCanBeRemoved()
    {
        var s = Service(OkScript());
        var queue = new StrategyTuningQueue(s, NullLogger<StrategyTuningQueue>.Instance);
        var at = DateTimeOffset.UtcNow.AddMinutes(-1);
        queue.Add(Job("NIFTY") with { From = "2026-09-01", To = "2026-09-30" }, at, repeatDaily: true);
        var other = queue.Add(Job("SENSEX"), at.AddDays(5), false);
        queue.Tick(DateTimeOffset.UtcNow);
        await UntilDone(s);
        queue.Tick(DateTimeOffset.UtcNow);
        var next = queue.Items().Single(i => i.State == "queued" && i.Job.Underlying == "NIFTY");
        Assert.True(next.RepeatDaily);
        Assert.Equal(at.AddDays(1), next.RunAtUtc);
        Assert.Equal(("2026-09-02", "2026-10-01"), (next.Job.From, next.Job.To)); // the range moves with it
        Assert.True(queue.Remove(other.Id));
        Assert.DoesNotContain(queue.Items(), i => i.Id == other.Id);
    }

    [Fact]
    public async Task ClearingTheHistory_RemovesResultsAndRuns_ButKeepsTheSchedule_AndIsRefusedWhileRunning()
    {
        var s = Service(OkScript());
        var queue = new StrategyTuningQueue(s, NullLogger<StrategyTuningQueue>.Instance);
        queue.Add(Job("NIFTY"), DateTimeOffset.UtcNow.AddDays(1), false);
        Assert.Null(s.Start(Job("NIFTY")));
        Assert.NotNull(s.ClearHistory(alsoCache: false)); // running
        await UntilDone(s);
        Directory.CreateDirectory(s.HistoryDirectory);
        File.WriteAllText(Path.Combine(s.HistoryDirectory, "runs.csv"), "run_id\n");
        Directory.CreateDirectory(s.CacheDirectory);
        File.WriteAllText(Path.Combine(s.CacheDirectory, "day.json"), "{}");

        Assert.Null(s.ClearHistory(alsoCache: false));
        Assert.Null(s.Result("NIFTY"));
        Assert.False(Directory.Exists(s.HistoryDirectory));
        Assert.True(File.Exists(Path.Combine(s.CacheDirectory, "day.json")), "the cache stays unless asked");
        Assert.Single(new StrategyTuningQueue(s, NullLogger<StrategyTuningQueue>.Instance).Items());

        Assert.Null(s.ClearHistory(alsoCache: true));
        Assert.False(Directory.Exists(s.CacheDirectory));
    }

    // ---- Strategy performance across every run -------------------------------------------------------------------

    [Fact]
    public void Performance_GivesRAndRiskRewardForTheIndexAndBothOptions_EvenFromRowsWithoutTheRColumns()
    {
        var runs = new List<Dictionary<string, string>> { new() { ["run_id"] = "NIFTY-futures-20261010-100000", ["index"] = "NIFTY", ["data"] = "futures" } };
        var rows = new List<Dictionary<string, string>>
        {
            // An older row: no bought_r / sold_r columns - R comes from the points over the SL.
            new() { ["index"] = "NIFTY", ["strategy_id"] = "x", ["setting"] = "as written", ["date"] = "2026-10-07", ["entry_time_ist"] = "2026-10-07 10:00:00",
                ["points"] = "40", ["r"] = "2", ["sl_points"] = "20", ["target_points"] = "40",
                ["bought_points"] = "30", ["bought_sl"] = "20", ["bought_target"] = "30", ["sold_points"] = "-20", ["sold_sl"] = "20", ["sold_target"] = "30" },
            // A newer row with the columns.
            new() { ["index"] = "NIFTY", ["strategy_id"] = "x", ["setting"] = "as written", ["date"] = "2026-10-08", ["entry_time_ist"] = "2026-10-08 10:00:00",
                ["points"] = "-20", ["r"] = "-1", ["sl_points"] = "20", ["target_points"] = "40",
                ["bought_points"] = "-20", ["bought_sl"] = "20", ["bought_target"] = "30", ["bought_r"] = "-1", ["sold_points"] = "10", ["sold_sl"] = "20", ["sold_target"] = "30", ["sold_r"] = "0.5" },
        };
        var s = TuningPerformance.Build(runs, (id, kind) => kind == "trades" ? rows : null).Rows.Single().All;

        Assert.Equal((2, 1.0, 40.0, 2.0), (s.Futures.Trades, s.Futures.TotalR, s.Futures.Risked, s.Futures.AvgRiskReward!.Value));
        Assert.Equal((1.5 - 1, 10.0, 40.0, 1.5), (s.Bought.TotalR, s.Bought.Points, s.Bought.Risked, s.Bought.AvgRiskReward!.Value));
        Assert.Equal(-1 + 0.5, s.Sold.TotalR, 6);
        Assert.Equal(-0.25, s.Sold.AvgR!.Value, 6);
        Assert.Equal(0, s.Option.Trades); // no tuned option trade in these rows
    }

    [Fact]
    public void PerformanceDays_ListsUsedAndLeftOutDaysPerIndex_AndTheDaysScanned()
    {
        static Dictionary<string, string> D(string date, string status, string role = "", string reason = "") =>
            new() { ["index"] = "NIFTY", ["date"] = date, ["status"] = status, ["role"] = role, ["reason"] = reason };
        var runs = new List<Dictionary<string, string>>
        {
            new() { ["run_id"] = "NIFTY-futures-20261010-100000", ["index"] = "NIFTY", ["data"] = "futures" },        // newest first
            new() { ["run_id"] = "NIFTY-futures-20261008-100000", ["index"] = "NIFTY", ["data"] = "futures" },
            // Written before the day list existed: only its count and range are known.
            new() { ["run_id"] = "BANKNIFTY-futures-20261001-100000", ["index"] = "BANKNIFTY", ["data"] = "futures", ["days_used"] = "40", ["first_day"] = "2026-09-30", ["last_day"] = "2026-08-01" },
        };
        var files = new Dictionary<string, List<Dictionary<string, string>>>
        {
            ["NIFTY-futures-20261010-100000:days"] = new() { D("2026-10-05", "used", "train"), D("2026-10-06", "used", "test"), D("2026-10-07", "left out", reason: "no data") },
            // The older run could not use 05 Oct (the newer one did) and also left out 07 Oct for another reason.
            ["NIFTY-futures-20261008-100000:days"] = new() { D("2026-10-05", "left out", reason: "busy"), D("2026-10-07", "left out", reason: "holiday") },
        };
        var (coverage, days) = TuningPerformance.Days(runs, (id, kind) => files.GetValueOrDefault($"{id}:{kind}"), "futures");

        Assert.Equal(3, days.Count);
        var d5 = days.Single(d => d.Date == "2026-10-05");
        Assert.Equal(("used", (string?)null, 2, 1, 0), (d5.Status, d5.Reason, d5.Runs, d5.TrainRuns, d5.TestRuns));
        Assert.Equal(1, days.Single(d => d.Date == "2026-10-06").TestRuns);
        var d7 = days.Single(d => d.Date == "2026-10-07");
        Assert.Equal(("left out", "no data"), (d7.Status, d7.Reason)); // the newest run's reason

        var nifty = coverage.Single(c => c.Index == "NIFTY");
        Assert.Equal((2, 1, 1, "2026-10-05", "2026-10-06", 2, false), (nifty.Scanned, nifty.LeftOut, nifty.TestDays, nifty.FirstDay, nifty.LastDay, nifty.Runs, nifty.AtLeast));
        var bank = coverage.Single(c => c.Index == "BANKNIFTY");
        Assert.Equal((40, 1, true, "2026-08-01", "2026-09-30"), (bank.Scanned, bank.OlderRuns, bank.AtLeast, bank.FirstDay, bank.LastDay));

        Assert.Empty(TuningPerformance.Days(runs, (id, kind) => files.GetValueOrDefault($"{id}:{kind}"), "spot").Coverage);
    }

    [Fact]
    public void Performance_AddsUpEveryRunPerStrategy_CountingAnOverlappingTradeOnce()
    {
        static Dictionary<string, string> T(string run, string index, string id, string setting, string date, string time, string points, string r, string closedBy = "Target hit") => new()
        {
            ["run_id"] = run, ["index"] = index, ["strategy_id"] = id, ["strategy_no"] = "15", ["strategy"] = "IB breakout", ["setting"] = setting,
            ["date"] = date, ["entry_time_ist"] = $"{date} {time}", ["points"] = points, ["r"] = r, ["closed_by"] = closedBy, ["sold_points"] = "4",
        };
        var runs = new List<Dictionary<string, string>>
        {
            new() { ["run_id"] = "NIFTY-futures-20261010-100000", ["index"] = "NIFTY", ["data"] = "futures" },        // newest first
            new() { ["run_id"] = "BANKNIFTY-futures-20261009-100000", ["index"] = "BANKNIFTY", ["data"] = "futures" },
            new() { ["run_id"] = "NIFTY-futures-20261008-100000", ["index"] = "NIFTY", ["data"] = "futures" },
        };
        var files = new Dictionary<string, List<Dictionary<string, string>>>
        {
            ["NIFTY-futures-20261010-100000:trades"] = new() { T("NIFTY-futures-20261010-100000", "NIFTY", "ibBreakout", "as written", "2026-10-07", "10:20:00", "40", "2"),
                                                           T("NIFTY-futures-20261010-100000", "NIFTY", "ibBreakout", "fine-tuned", "2026-10-07", "10:20:00", "30", "1.5") },
            ["BANKNIFTY-futures-20261009-100000:trades"] = new() { T("BANKNIFTY-futures-20261009-100000", "BANKNIFTY", "ibBreakout", "as written", "2026-10-06", "11:00:00", "-90", "-1", "Stop loss hit") },
            // The older NIFTY run scanned the same 07 Oct trade again (counted once) and an older day.
            ["NIFTY-futures-20261008-100000:trades"] = new() { T("NIFTY-futures-20261008-100000", "NIFTY", "ibBreakout", "as written", "2026-10-07", "10:20:00", "40", "2"),
                                                           T("NIFTY-futures-20261008-100000", "NIFTY", "ibBreakout", "as written", "2026-10-05", "10:30:00", "20", "1") },
            ["NIFTY-futures-20261010-100000:settings"] = new() { new() { ["which"] = "fine-tuned", ["strategy_id"] = "ibBreakout", ["index"] = "NIFTY", ["tradeSide"] = "long", ["run_id"] = "NIFTY-futures-20261010-100000" } },
            ["NIFTY-futures-20261008-100000:settings"] = new() { new() { ["which"] = "fine-tuned", ["strategy_id"] = "ibBreakout", ["index"] = "NIFTY", ["tradeSide"] = "short", ["run_id"] = "NIFTY-futures-20261008-100000" } },
        };
        var (rows, usedRuns, trades) = TuningPerformance.Build(runs, (id, kind) => files.GetValueOrDefault($"{id}:{kind}"));

        Assert.Equal(3, usedRuns);
        Assert.Equal(4, trades); // 5 rows, one of them the same trade twice
        var asWritten = rows.Single(r => r.Setting == "as written");
        Assert.Equal((3, 2, 1, 1), (asWritten.All.Trades, asWritten.All.Wins, asWritten.All.Losses, asWritten.All.SlHits));
        Assert.Equal(-30, asWritten.All.Points, 6);
        Assert.Equal(2.0 / 3, asWritten.All.AvgR!.Value, 6);
        Assert.Equal(12, asWritten.All.SoldPoints, 6);
        Assert.Equal((2, 1), (asWritten.ByIndex["NIFTY"].Trades, asWritten.ByIndex["BANKNIFTY"].Trades));
        Assert.Equal(("2026-10-05", "2026-10-07"), (asWritten.All.FirstDay, asWritten.All.LastDay));
        var tuned = rows.Single(r => r.Setting == "fine-tuned");
        Assert.Equal(1, tuned.All.Trades);
        // The newest run's fine-tuned setting per index.
        Assert.Equal("long", asWritten.LatestTuned["NIFTY"]["tradeSide"]);
        Assert.False(asWritten.LatestTuned.ContainsKey("BANKNIFTY"));

        Assert.Empty(TuningPerformance.Build(runs, (id, kind) => files.GetValueOrDefault($"{id}:{kind}"), "spot").Rows);

        // Every trade of the strategy, each once, oldest first; by setting and by index.
        var all = TuningPerformance.Trades(runs, (id, kind) => files.GetValueOrDefault($"{id}:{kind}"), "futures", "ibBreakout");
        Assert.Equal(4, all.Count);
        Assert.Equal(new[] { "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-07" }, all.Select(t => t["date"]));
        Assert.Equal(3, TuningPerformance.Trades(runs, (id, kind) => files.GetValueOrDefault($"{id}:{kind}"), "futures", "ibBreakout", "as written").Count);
        Assert.Single(TuningPerformance.Trades(runs, (id, kind) => files.GetValueOrDefault($"{id}:{kind}"), "futures", "ibBreakout", "as written", "BANKNIFTY"));
    }

    [Fact]
    public void AllTrades_EveryStrategy_OneStreamByDateAndTime_EachCountedOnce_WithTotals()
    {
        static Dictionary<string, string> T(string index, string id, string no, string setting, string date, string time, string points, string r) => new()
        {
            ["index"] = index, ["strategy_id"] = id, ["strategy_no"] = no, ["setting"] = setting, ["date"] = date, ["entry_time_ist"] = $"{date} {time}",
            ["points"] = points, ["r"] = r, ["sold_points"] = "2",
        };
        var runs = new List<Dictionary<string, string>>
        {
            new() { ["run_id"] = "R2", ["index"] = "NIFTY", ["data"] = "futures" }, // newest first
            new() { ["run_id"] = "R1", ["index"] = "NIFTY", ["data"] = "futures" },
        };
        var files = new Dictionary<string, List<Dictionary<string, string>>>
        {
            ["R2:trades"] = new() { T("NIFTY", "b", "2", "as written", "2026-10-06", "10:00:00", "20", "1"), T("NIFTY", "a", "1", "fine-tuned", "2026-10-06", "10:00:00", "-10", "-0.5") },
            // The older run scanned 06 Oct's "b" again (counted once) and an older day; another index the same minute.
            ["R1:trades"] = new() { T("NIFTY", "b", "2", "as written", "2026-10-06", "10:00:00", "20", "1"), T("NIFTY", "a", "1", "as written", "2026-10-05", "11:30:00", "15", "0.75"),
                                    T("BANKNIFTY", "a", "1", "as written", "2026-10-06", "10:00:00", "40", "1") },
        };
        var all = TuningPerformance.Trades(runs, (id, kind) => files.GetValueOrDefault($"{id}:{kind}"), "futures", null);
        // Oldest first by date and time, then index, then strategy number.
        Assert.Equal(new[] { "05 a NIFTY", "06 a BANKNIFTY", "06 a NIFTY", "06 b NIFTY" },
            all.Select(t => $"{t["date"][8..]} {t["strategy_id"]} {t["index"]}"));
        Assert.Equal(2, TuningPerformance.Trades(runs, (id, kind) => files.GetValueOrDefault($"{id}:{kind}"), "futures", null, "as written", "NIFTY").Count);
        var totals = TuningPerformance.Totals(all);
        Assert.Equal((4, 3, 1, 2.25, 65.0, 8.0, 2, "2026-10-05", "2026-10-06"),
            (totals.Trades, totals.Wins, totals.Losses, totals.TotalR, totals.Points, totals.SoldPoints, totals.Days, totals.FirstDay, totals.LastDay));

        // Per index (points only add up within one): captured / lost / net for the index trade and each option leg, and the
        // options' net after the costs a trade (3 premium points on NIFTY, 5 on BANKNIFTY here).
        var withCosts = TuningPerformance.Totals(all, u => u == "NIFTY" ? 3 : 5);
        Assert.Equal(new[] { "BANKNIFTY", "NIFTY" }, withCosts.ByIndex.Select(x => x.Index));
        var nifty = withCosts.ByIndex.Single(x => x.Index == "NIFTY");
        Assert.Equal(3, nifty.Trades);
        Assert.Equal((3, 2, 1, 35.0, -10.0, 25.0), (nifty.Points.Trades, nifty.Points.Wins, nifty.Points.Losses, nifty.Points.Captured, nifty.Points.Lost, nifty.Points.Net));
        Assert.Null(nifty.Points.NetAfterCosts); // the index trade's points are not premium points
        Assert.Equal((3, 6.0, 6.0 - 3 * 3), (nifty.Sold.Trades, nifty.Sold.Net, nifty.Sold.NetAfterCosts!.Value));
        Assert.Equal(0, nifty.Bought.Trades); // no bought premiums in these rows
        Assert.Equal((40.0, 2.0 - 5), (withCosts.ByIndex[0].Points.Net, withCosts.ByIndex[0].Sold.NetAfterCosts!.Value));
    }

    [Fact]
    public void ALongRange_IsSplitIntoConsecutivePieces_OldestFirst()
    {
        var pieces = OptionAnalytics.Server.Controllers.StrategyTuningController.Chunks("2026-07-01", "2026-08-14", 15);
        Assert.Equal(new[] { ("2026-07-01", "2026-07-15"), ("2026-07-16", "2026-07-30"), ("2026-07-31", "2026-08-14") }, pieces);
        Assert.Equal(new[] { ("2026-07-01", "2026-07-03") }, OptionAnalytics.Server.Controllers.StrategyTuningController.Chunks("2026-07-01", "2026-07-03", 30));
        Assert.Empty(OptionAnalytics.Server.Controllers.StrategyTuningController.Chunks("2026-07-10", "2026-07-01", 15));
    }

    [Fact]
    public void TheTunedSettings_OfEveryRun_AreScoredTogether_AndTheBestRecommendedOneIsMarked()
    {
        static Dictionary<string, string> S(string run, string side, string rec, string testN, string testAvg, string trainN = "20", string trainAvg = "0.5") => new()
        {
            ["run_id"] = run, ["which"] = "fine-tuned", ["strategy_id"] = "ibBreakout", ["index"] = "NIFTY", ["recommended"] = rec, ["unit"] = "R",
            ["test_trades"] = testN, ["test_avg"] = testAvg, ["train_trades"] = trainN, ["train_avg"] = trainAvg, ["points_net"] = "10",
            ["tradeSide"] = side, ["tradeFrom"] = "930", ["setting_text"] = $"{side} only",
        };
        var runs = new[] { "R3", "R2", "R1" }.Select(r => new Dictionary<string, string> { ["run_id"] = r, ["data"] = "futures", ["index"] = "NIFTY" }).ToList();
        var files = new Dictionary<string, List<Dictionary<string, string>>>
        {
            // "long" chosen by two runs (6 + 4 unseen trades, avg 0.5 and 0.25 -> 0.4 over 10); "short" by one, +1R but on only 2.
            ["R3:settings"] = new() { S("R3", "long", "yes", "6", "0.5") },
            ["R2:settings"] = new() { S("R2", "short", "yes", "2", "1.0") },
            ["R1:settings"] = new() { S("R1", "long", "no", "4", "0.25") },
            ["R3:trades"] = new() { new() { ["strategy_id"] = "ibBreakout", ["setting"] = "fine-tuned", ["index"] = "NIFTY", ["date"] = "2026-10-01", ["entry_time_ist"] = "x", ["points"] = "5", ["r"] = "1" } },
            ["R2:trades"] = new(), ["R1:trades"] = new(),
        };
        var row = TuningPerformance.Build(runs, (id, kind) => files.GetValueOrDefault($"{id}:{kind}")).Rows.Single();
        var tuned = row.TunedSettings["NIFTY"];
        Assert.Equal(2, tuned.Count);
        var longSetting = tuned[0];
        Assert.Equal("long", longSetting.Row["tradeSide"]);
        Assert.Equal((2, 1, 10), (longSetting.Runs, longSetting.Recommended, longSetting.TestTrades));
        Assert.Equal(0.4, longSetting.TestAvg!.Value, 6);
        Assert.Equal(0.4 * 10 / 20, longSetting.Score!.Value, 6); // shrunk for few trades: beats "short"'s 1.0 x 2 / 12
        Assert.True(longSetting.Best);
        Assert.False(tuned[1].Best);
        Assert.Equal("R3", longSetting.Row["run_id"]); // the newest run's row is what Apply sends
    }

    [Fact]
    public void SettingsTunedOnDifferentMonths_AreJudgedOnEachOthersUnseenDays_AndTheOneThatKeepsWinningIsBest()
    {
        // September tuned -> "long" (R1); October tuned -> "short" (R2). Each run's cross-check measures every setting
        // found so far on its own days that setting was not chosen on.
        static Dictionary<string, string> S(string run, string side) => new()
        {
            ["run_id"] = run, ["which"] = "fine-tuned", ["strategy_id"] = "ibBreakout", ["index"] = "NIFTY", ["recommended"] = "yes", ["unit"] = "R",
            ["test_trades"] = "2", ["test_avg"] = "0.8", ["train_trades"] = "20", ["train_avg"] = "0.5", ["tradeSide"] = side, ["tradeFrom"] = "930",
            ["tradeOiWindow"] = "", ["setting_text"] = $"{side} only",
        };
        static Dictionary<string, string> C(string run, string side, string date, int n, double total, int baseN, double baseTotal) => new()
        {
            ["run_id"] = run, ["index"] = "NIFTY", ["data"] = "futures", ["strategy_id"] = "ibBreakout", ["unit"] = "R", ["date"] = date,
            ["n"] = n.ToString(), ["total"] = total.ToString(System.Globalization.CultureInfo.InvariantCulture), ["wins"] = "0",
            ["base_n"] = baseN.ToString(), ["base_total"] = baseTotal.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["tradeSide"] = side, ["tradeFrom"] = "930", ["tradeWallRoom"] = "", // a column the older settings file did not have
        };
        var runs = new[] { "R2", "R1" }.Select(r => new Dictionary<string, string> { ["run_id"] = r, ["data"] = "futures", ["index"] = "NIFTY" }).ToList();
        List<TuningPerformance.TunedSetting> Rank(List<Dictionary<string, string>> octChecks)
        {
            var files = new Dictionary<string, List<Dictionary<string, string>>>
            {
                ["R1:settings"] = new() { S("R1", "long") },
                ["R2:settings"] = new() { S("R2", "short") },
                ["R1:trades"] = new() { new() { ["strategy_id"] = "ibBreakout", ["setting"] = "as written", ["index"] = "NIFTY", ["date"] = "2026-09-25", ["entry_time_ist"] = "x", ["r"] = "1" } },
                ["R2:trades"] = new(),
                // September's run: "long" on its own held-back day.
                ["R1:checks"] = new() { C("R1", "long", "2026-09-25", 3, 1.5, 3, 0.3) },
                ["R2:checks"] = octChecks,
            };
            return TuningPerformance.Build(runs, (id, kind) => files.GetValueOrDefault($"{id}:{kind}")).Rows.Single().TunedSettings["NIFTY"];
        }

        // 1. "long" keeps winning in October (every October day is unseen for it); "short" won its own held-back days only.
        var keeps = Rank(new()
        {
            C("R2", "long", "2026-10-05", 4, 2.0, 4, -0.4),
            C("R2", "long", "2026-10-06", 3, 1.0, 3, 0.3),
            C("R2", "short", "2026-10-20", 2, 1.6, 2, 0.2),
            C("R2", "long", "2026-09-25", 3, 9.9, 3, 9.9), // the same day checked again by a newer run: counted once (the newer row)
        });
        var lng = keeps.Single(t => t.Row["tradeSide"] == "long");
        var sht = keeps.Single(t => t.Row["tradeSide"] == "short");
        Assert.Equal((10, 2, 2, 1), (lng.TestTrades, lng.Periods, lng.PeriodsWon, lng.CheckedRuns));
        Assert.Equal((2.0 + 1.0 + 9.9) / 10, lng.TestAvg!.Value, 6);
        Assert.Equal((-0.4 + 0.3 + 9.9) / 10, lng.BaseAvg!.Value, 6);
        Assert.True(lng.Best, "proven over two months on days it was not chosen on");
        Assert.False(sht.Best, "one month's held-back days - higher average, far less proof");
        Assert.Equal((2, 1, 0), (sht.TestTrades, sht.Periods, sht.CheckedRuns));

        // 2. "long" LOSES in October: it fitted September. "short" is best now.
        var fitted = Rank(new()
        {
            C("R2", "long", "2026-10-05", 6, -3.0, 6, 0.6),
            C("R2", "long", "2026-10-06", 4, -1.0, 4, 0.2),
            C("R2", "short", "2026-10-20", 2, 1.6, 2, 0.2),
        });
        Assert.False(fitted.Single(t => t.Row["tradeSide"] == "long").Best);
        Assert.True(fitted.Single(t => t.Row["tradeSide"] == "short").Best);
        Assert.Equal("short", fitted[0].Row["tradeSide"]); // ranked first too: "long" is below 0 on its unseen days

        // 3. Making money is not enough: it must beat the strategy as written on the same days.
        var notBetter = Rank(new()
        {
            C("R2", "long", "2026-10-05", 6, 0.6, 6, 6.0),
            C("R2", "short", "2026-10-20", 2, -0.4, 2, 0.2),
        });
        Assert.DoesNotContain(notBetter, t => t.Best);
        // ...and it says which rule it misses, in plain words.
        Assert.Contains(notBetter.Single(t => t.Row["tradeSide"] == "long").NotBestBecause, w => w.StartsWith("no better than the strategy as written"));
        Assert.Contains(notBetter.Single(t => t.Row["tradeSide"] == "short").NotBestBecause, w => w.StartsWith("loses on its unseen days"));
        Assert.Empty(keeps.Single(t => t.Row["tradeSide"] == "long").NotBestBecause);
        Assert.Contains("Re-check", TuningPerformance.WhyNotBest(lng with { TestTrades = 0, TestAvg = null, Score = null }).Single());
        Assert.Contains(TuningPerformance.WhyNotBest(lng with { Periods = 1, PeriodsWon = 1, Recommended = 0 }), w => w.StartsWith("checked in only one month"));
        Assert.Contains(TuningPerformance.WhyNotBest(lng with { Periods = 3, PeriodsWon = 1 }), w => w == "won in only 1 of 3 months");

        // 4. Two months, won in only one of them and down overall: never best.
        Assert.False(TuningPerformance.CanBeBest(lng with { Score = -0.1, PeriodsWon = 1 }));
        Assert.False(TuningPerformance.CanBeBest(lng with { Periods = 3, PeriodsWon = 1 }));
        Assert.True(TuningPerformance.CanBeBest(lng with { Periods = 4, PeriodsWon = 2 }));
    }
}

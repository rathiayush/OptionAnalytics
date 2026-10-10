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
}

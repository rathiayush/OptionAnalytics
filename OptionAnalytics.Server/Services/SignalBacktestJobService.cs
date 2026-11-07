using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Hosting.Server;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Telegram;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// The Signal backtest in the BACKGROUND: a queue of runs the Signal backtest page hands over - now, or at a time picked on
/// the page - worked through ONE AT A TIME, each in its own Node process (scanner-runner/signal-backtest.mjs, the page's own
/// code - signalBacktestJob.js) with the runner's key, so the browser can be closed. Each run is a file
/// ({Storage:ScannerRunnerPath}/signal-backtests/{id}.json - its settings, state and progress) and its report another
/// ({id}.result.json), so the queue and the reports survive a restart / deploy: a run the restart cut off is queued again
/// (and failed after <see cref="MaxAttempts"/> tries). Telegram when a run ends, if asked. Read-only: a run places nothing,
/// changes no setting and feeds no strategy or alert; its Dhan calls are the page's (each past day once - the cache keeps it).
/// A run is one of two <see cref="Kinds"/>: "backtest" (the rule's report) or "features" - the page's FEATURE FINDER over the
/// days (featureFinder.js: every reading at every candle against what came next, its report for each label in the result and
/// the whole table as a CSV beside it, {id}.features.csv).
/// </summary>
public sealed class SignalBacktestJobService : BackgroundService
{
    /// <summary>Runs kept - past it the oldest finished ones go (their reports with them).</summary>
    public const int MaxJobs = 60;
    /// <summary>Runs one account may have waiting or running.</summary>
    public const int MaxWaitingPerOwner = 20;
    /// <summary>Starts a run gets: one cut off by a restart this many times is failed, not started again.</summary>
    public const int MaxAttempts = 3;
    /// <summary>The furthest ahead a run can be set to start.</summary>
    public static readonly TimeSpan MaxStartAhead = TimeSpan.FromDays(14);
    public const int MaxSettingsBytes = 64 * 1024;
    public static readonly string[] Underlyings = { "NIFTY", "BANKNIFTY", "SENSEX" };
    /// <summary>MAX_BACKGROUND_DAYS - the job runs the latest 300 weekdays of a longer range.</summary>
    public const int MaxDays = 300;
    /// <summary>What a run is: the rule's backtest, or the Feature finder's table and report.</summary>
    public static readonly string[] Kinds = { "backtest", "features" };
    /// <summary>The Feature finder's labels (featureFinder.js LABELS) - each one's report is in a features run's result.</summary>
    internal static readonly (string Key, string Name)[] FeatureTargets =
        { ("ceBuy", "CE buy"), ("peBuy", "PE buy"), ("fwd15", "spot 15m"), ("fwd30", "spot 30m"), ("fwd60", "spot 60m") };

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = false };

    private readonly IConfiguration _configuration;
    private readonly IHostEnvironment _environment;
    private readonly IServer _server;
    private readonly ScannerRunnerKey _key;
    private readonly IHostApplicationLifetime _lifetime;
    private readonly TelegramAlertService? _telegram;
    private readonly ILogger<SignalBacktestJobService> _logger;
    private readonly object _lock = new();
    private readonly Dictionary<string, SignalBacktestJob> _jobs = new();
    private readonly SemaphoreSlim _wake = new(0);
    private readonly string _dir;
    private Process? _process;
    private string? _runningId;
    private volatile bool _stopping;

    /// <summary>Tests: what a Telegram message would do (the real one is TelegramAlertService).</summary>
    internal Func<string, CancellationToken, Task>? NotifyOverride { get; set; }

    public SignalBacktestJobService(IConfiguration configuration, IHostEnvironment environment, IServer server, ScannerRunnerKey key,
        ScannerRunnerStore store, IHostApplicationLifetime lifetime, ILogger<SignalBacktestJobService> logger, TelegramAlertService? telegram = null)
    {
        _configuration = configuration;
        _environment = environment;
        _server = server;
        _key = key;
        _lifetime = lifetime;
        _telegram = telegram;
        _logger = logger;
        _dir = Path.Combine(store.DataDirectory, "signal-backtests");
        Directory.CreateDirectory(_dir);
        Load();
        lifetime.ApplicationStopping.Register(StopForShutdown);
    }

    // ---- The queue -----------------------------------------------------------------------------------------------------

    /// <summary>The runs, newest first - every account's for an admin (<paramref name="owner"/> null), else that account's.</summary>
    public IReadOnlyList<SignalBacktestJob> List(string? owner)
    {
        lock (_lock)
            return _jobs.Values.Where(j => owner is null || Same(j.Owner, owner)).OrderByDescending(j => j.CreatedUtc).ThenByDescending(j => j.Id).ToList();
    }

    public SignalBacktestJob? Get(string id, string? owner)
    {
        lock (_lock) return _jobs.TryGetValue(id, out var j) && (owner is null || Same(j.Owner, owner)) ? j : null;
    }

    /// <summary>Queues a run for <paramref name="owner"/>; the run, or why not.</summary>
    public (SignalBacktestJob? Job, string? Error) Add(string owner, SignalBacktestRequest request, DateTimeOffset now)
    {
        var (plan, error) = Validate(request, now);
        if (plan is null) return (null, error);
        SignalBacktestJob job;
        lock (_lock)
        {
            if (_jobs.Values.Count(j => Same(j.Owner, owner) && j.State is "queued" or "running") >= MaxWaitingPerOwner)
                return (null, $"{MaxWaitingPerOwner} runs are already waiting - cancel one or let them finish first");
            job = plan with { Id = NewId(now), Owner = owner, CreatedUtc = now };
            _jobs[job.Id] = job;
            Save(job);
            Trim();
        }
        _logger.LogInformation("Signal backtest {Id} queued by {Owner}: {Name}{When}.", job.Id, owner, job.Name, job.StartAtUtc is { } at ? $" (starts {at:u})" : "");
        _wake.Release();
        return (job, null);
    }

    /// <summary>Stops a run that is waiting or running (it stays listed, cancelled).</summary>
    public bool Cancel(string id, string? owner)
    {
        lock (_lock)
        {
            if (!_jobs.TryGetValue(id, out var job) || (owner is not null && !Same(job.Owner, owner))) return false;
            if (job.State is not ("queued" or "running")) return true;
            if (job.State == "running" && _runningId == id && _process is { } process)
            {
                try { process.Kill(entireProcessTree: true); } catch { /* already gone */ }
            }
            Put(job with { State = "cancelled", FinishedUtc = DateTimeOffset.UtcNow });
        }
        _wake.Release();
        return true;
    }

    /// <summary>Removes a run and its report (a running one is stopped first).</summary>
    public bool Delete(string id, string? owner)
    {
        if (Get(id, owner) is null) return false;
        Cancel(id, owner);
        lock (_lock)
        {
            _jobs.Remove(id);
            foreach (var path in new[] { JobPath(id), ResultFile(id), ResultFile(id) + ".running", ResultFile(id) + ".running.tmp",
                         FeaturesFile(id), FeaturesFile(id) + ".running", FeaturesFile(id) + ".running.tmp" })
                TryDelete(path);
        }
        return true;
    }

    /// <summary>The report file of a finished run (null when there is none, or the run is not the account's).</summary>
    public string? ResultPath(string id, string? owner)
    {
        var job = Get(id, owner);
        if (job is null || job.State != "done") return null;
        var path = ResultFile(id);
        return File.Exists(path) ? path : null;
    }

    /// <summary>The dataset CSV of a finished Feature finder run (null when there is none, or the run is not the account's).</summary>
    public string? FeaturesPath(string id, string? owner)
    {
        var job = Get(id, owner);
        if (job is null || job.State != "done" || job.Kind != "features") return null;
        var path = FeaturesFile(id);
        return File.Exists(path) ? path : null;
    }

    /// <summary>Starts the next run that is due (waiting, its start time reached - the earliest first) when none is running.
    /// True when one was started.</summary>
    public bool TryStartNext(DateTimeOffset now)
    {
        lock (_lock)
        {
            if (_process is not null || _stopping) return false;
            var next = _jobs.Values.Where(j => j.State == "queued" && (j.StartAtUtc is null || j.StartAtUtc <= now))
                .OrderBy(j => j.StartAtUtc ?? j.CreatedUtc).ThenBy(j => j.CreatedUtc).ThenBy(j => j.Id).FirstOrDefault();
            if (next is null) return false;

            var script = ScriptPath();
            if (!File.Exists(script))
            {
                Put(next with { State = "failed", FinishedUtc = now, Error = $"{Path.GetFileName(script)} is not on the server (build it with `npm run build:runner`)" });
                return false;
            }
            var output = ResultFile(next.Id);
            TryDelete(output + ".running");
            var csv = next.Kind == "features" ? FeaturesFile(next.Id) : null;
            if (csv is not null) TryDelete(csv + ".running");
            var node = _configuration["ScannerRunner:NodePath"] is { Length: > 0 } n ? n : "node";
            var info = new ProcessStartInfo(node)
            {
                RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(script)!,
            };
            info.ArgumentList.Add(script);
            info.Environment["RUNNER_BASE_URL"] = ScannerRunnerHostedService.BaseUrlOf(_server);
            info.Environment["RUNNER_KEY"] = _key.Value;
            info.Environment["BACKTEST_JOB"] = next.Settings.ToJsonString();
            info.Environment["BACKTEST_OUT"] = output + ".running";
            info.Environment["BACKTEST_KIND"] = next.Kind;
            if (csv is not null) info.Environment["BACKTEST_CSV"] = csv + ".running";
            var process = new Process { StartInfo = info, EnableRaisingEvents = true };
            var id = next.Id;
            process.OutputDataReceived += (_, e) => OnOutput(id, e.Data);
            process.ErrorDataReceived += (_, e) => { if (e.Data is { Length: > 0 } line) _logger.LogWarning("[signal-backtest {Id}] {Line}", id, line); };
            try
            {
                if (!process.Start())
                {
                    process.Dispose();
                    Put(next with { State = "failed", FinishedUtc = now, Error = $"{node} did not start" });
                    return false;
                }
            }
            catch (Exception ex)
            {
                process.Dispose();
                Put(next with { State = "failed", FinishedUtc = now, Error = $"{node} could not be started: {ex.Message}" });
                return false;
            }
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            _process = process;
            _runningId = id;
            Put(next with { State = "running", StartedUtc = now, FinishedUtc = null, Error = null, Progress = null, Attempts = next.Attempts + 1 });
            _logger.LogInformation("Signal backtest {Id} started ({Name}, pid {Pid}).", id, next.Name, process.Id);
            _ = WatchAsync(process, id, output, csv);
            return true;
        }
    }

    /// <summary>Whether a run is running now.</summary>
    public bool IsBusy { get { lock (_lock) return _process is not null; } }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // The job's first call is to this server: only once it listens.
        var started = new TaskCompletionSource();
        using (_lifetime.ApplicationStarted.Register(() => started.TrySetResult()))
        using (stoppingToken.Register(() => started.TrySetCanceled()))
        {
            try { await started.Task; } catch (OperationCanceledException) { return; }
        }
        // No Dhan call is made here - the job's requests are the runner's (background) ones; held to the rule all the same.
        using var background = MarketHours.BackgroundScope();
        while (!stoppingToken.IsCancellationRequested)
        {
            try { TryStartNext(DateTimeOffset.UtcNow); }
            catch (Exception ex) { _logger.LogWarning(ex, "Signal backtest queue: a run could not be started."); }
            try { await _wake.WaitAsync(TimeSpan.FromSeconds(15), stoppingToken); }
            catch (OperationCanceledException) { return; }
        }
    }

    // ---- What a run says -----------------------------------------------------------------------------------------------

    private void OnOutput(string id, string? line)
    {
        if (string.IsNullOrEmpty(line)) return;
        if (line.StartsWith("PROGRESS ", StringComparison.Ordinal))
        {
            try
            {
                var p = JsonNode.Parse(line["PROGRESS ".Length..]);
                lock (_lock)
                    if (_jobs.TryGetValue(id, out var job) && job.State == "running") _jobs[id] = job with { Progress = p };
            }
            catch (JsonException) { /* not ours */ }
            return;
        }
        _logger.LogInformation("[signal-backtest {Id}] {Line}", id, line);
    }

    private async Task WatchAsync(Process process, string id, string output, string? csv)
    {
        SignalBacktestJob? ended = null;
        try
        {
            await process.WaitForExitAsync();
            if (_stopping) return;   // the server is stopping: the run stays "running" on disk and is queued again at the start
            var running = output + ".running";
            string? error = null;
            JsonNode? summary = null;
            if (File.Exists(running))
            {
                try
                {
                    var body = JsonNode.Parse(File.ReadAllText(running));
                    if (body?["ok"]?.GetValue<bool>() == true)
                    {
                        // A Feature finder run's table is written before its report: no table, no run.
                        if (csv is not null && !File.Exists(csv + ".running")) error = "the run wrote no dataset";
                        else
                        {
                            summary = SummaryOf(body);
                            if (csv is not null) File.Move(csv + ".running", csv, overwrite: true);
                            File.Move(running, output, overwrite: true);
                        }
                    }
                    else error = body?["error"]?.GetValue<string>() ?? "the run failed";
                }
                catch (Exception ex) when (ex is JsonException or InvalidOperationException or FormatException) { error = $"its report could not be read ({ex.Message})"; }
            }
            else error = process.ExitCode != 0 ? $"the run exited with code {process.ExitCode}" : "the run wrote no report";
            TryDelete(running);
            if (csv is not null) TryDelete(csv + ".running");
            lock (_lock)
            {
                if (_jobs.TryGetValue(id, out var job) && job.State == "running")
                {
                    ended = job with { State = error is null ? "done" : "failed", FinishedUtc = DateTimeOffset.UtcNow, Error = error, Summary = summary };
                    Put(ended);
                }
            }
            _logger.LogInformation("Signal backtest {Id} finished: {Result}.", id, error ?? "done");
        }
        catch (Exception ex)
        {
            lock (_lock)
            {
                if (_jobs.TryGetValue(id, out var job) && job.State == "running")
                {
                    ended = job with { State = "failed", FinishedUtc = DateTimeOffset.UtcNow, Error = ex.Message };
                    Put(ended);
                }
            }
        }
        finally
        {
            lock (_lock)
            {
                if (_runningId == id) { _process = null; _runningId = null; }
            }
            process.Dispose();
            if (!_stopping) _wake.Release();
        }
        if (ended is { Telegram: true }) await NotifyAsync(TelegramText(ended));
    }

    /// <summary>The run's numbers for the list - the report's "Both" row (net, trades, win %) and the days run / not run; a
    /// Feature finder run's: its candles, days, and for each label how many readings held on the later days and the best of
    /// them (its report lists what holds first).</summary>
    internal static JsonNode SummaryOf(JsonNode body)
    {
        double? Num(JsonNode? n) => n is JsonValue v && v.TryGetValue<double>(out var d) && double.IsFinite(d) ? d : null;
        if ((body["kind"] as JsonValue)?.TryGetValue<string>(out var kind) == true && kind == "features")
        {
            var f = body["features"];
            var reports = f?["reports"];
            var held = new JsonObject();
            var best = new JsonObject();
            foreach (var (key, _) in FeatureTargets)
            {
                var list = (reports?[key]?["features"] as JsonArray)?.Where(x => (x?["holds"] as JsonValue)?.TryGetValue<bool>(out var h) == true && h).ToList() ?? new();
                held[key] = list.Count;
                if (list.FirstOrDefault()?["name"] is JsonValue name && name.TryGetValue<string>(out var n)) best[key] = n;
            }
            return new JsonObject
            {
                ["kind"] = "features",
                ["rows"] = Num(f?["rows"]),
                ["okDays"] = Num(f?["okDays"]),
                ["failedDays"] = (double)((f?["failed"] as JsonArray)?.Count ?? 0),
                ["split"] = (reports?["fwd30"]?["split"] as JsonValue)?.TryGetValue<bool>(out var split) == true && split,
                ["held"] = held,
                ["best"] = best,
            };
        }
        var report = body["report"];
        var all = report?["all"];
        return new JsonObject
        {
            ["net"] = Num(all?["net"]),
            ["trades"] = Num(all?["trades"]),
            ["winRate"] = Num(all?["winRate"]),
            ["okDays"] = Num(report?["okDays"]),
            ["failedDays"] = (double)((report?["failed"] as JsonArray)?.Count ?? 0),
        };
    }

    /// <summary>The Telegram message when a run ends (HTML - the name is escaped).</summary>
    internal static string TelegramText(SignalBacktestJob job)
    {
        var name = WebUtility.HtmlEncode(job.Name);
        var what = job.Kind == "features" ? "Feature finder" : "Signal backtest";
        if (job.State != "done") return $"⚠️ <b>{what} failed</b> - {name}\n{WebUtility.HtmlEncode(job.Error ?? "unknown error")}";
        var s = job.Summary;
        double? Num(string key) => s?[key] is JsonValue v && v.TryGetValue<double>(out var d) ? d : null;
        if (job.Kind == "features")
        {
            var notRun = Num("failedDays") is > 0 and var nr ? $" · {nr:0} day(s) not run" : "";
            var head = $"🔬 <b>Feature finder done</b> - {name}\n{(Num("rows") ?? 0):0} candles · {(Num("okDays") ?? 0):0} days{notRun}";
            if (s?["split"] is not JsonValue sv || !sv.TryGetValue<bool>(out var split) || !split)
                return $"{head}\nToo few days for the earlier / later check - open it on the page, download the dataset CSV.";
            int Held(string key) => s?["held"]?[key] is JsonValue v && v.TryGetValue<int>(out var c) ? c : 0;
            var lines = string.Join(" · ", FeatureTargets.Where(t => t.Key is "ceBuy" or "peBuy" or "fwd30").Select(t => $"{t.Name} {Held(t.Key)}"));
            var best = FeatureTargets.Where(t => t.Key is "ceBuy" or "peBuy")
                .Select(t => s?["best"]?[t.Key] is JsonValue b && b.TryGetValue<string>(out var bn) ? $"\nBest for {t.Name}: {WebUtility.HtmlEncode(bn)}" : "");
            return $"{head}\nReadings that held on the later days: {lines}{string.Concat(best)}";
        }
        var net = Num("net") ?? 0;
        var india = CultureInfo.GetCultureInfo("en-IN");
        var rupees = $"{(net < 0 ? "−" : "")}₹{Math.Abs(Math.Round(net)).ToString("N0", india)}";
        var win = Num("winRate") is { } w ? $" · {w:0}% win" : "";
        var failed = Num("failedDays") is > 0 and var f ? $" · {f:0} day(s) not run" : "";
        return $"📊 <b>Signal backtest done</b> - {name}\nNet {rupees} · {(Num("trades") ?? 0):0} trades{win} · {(Num("okDays") ?? 0):0} days{failed}";
    }

    private async Task NotifyAsync(string text)
    {
        try
        {
            if (NotifyOverride is { } notify) await notify(text, CancellationToken.None);
            else if (_telegram is not null) await _telegram.SendAsync(text, CancellationToken.None);
        }
        catch (Exception ex) { _logger.LogWarning(ex, "Signal backtest: the Telegram message could not be sent."); }
    }

    // ---- The request -----------------------------------------------------------------------------------------------------

    /// <summary>A run as asked for, checked: the index, the range (past weekdays - the latest <see cref="MaxDays"/>), the
    /// start time (none or in the past = now; at most <see cref="MaxStartAhead"/> ahead) and the settings' size. The job
    /// itself holds every number to the page's range.</summary>
    internal static (SignalBacktestJob? Plan, string? Error) Validate(SignalBacktestRequest? request, DateTimeOffset now)
    {
        if (request?.Settings is not JsonObject settings) return (null, "The run's settings are missing.");
        var text = settings.ToJsonString();
        if (text.Length > MaxSettingsBytes) return (null, "The run's settings are too large.");
        var underlying = (settings["underlying"] as JsonValue)?.TryGetValue<string>(out var u) == true ? u.Trim().ToUpperInvariant() : "";
        if (!Underlyings.Contains(underlying)) return (null, "The index must be NIFTY, BANKNIFTY or SENSEX.");
        if (!TryDate(settings["from"], out var from) || !TryDate(settings["to"], out var to)) return (null, "Pick the days to run (from / to).");
        if (from > to) (from, to) = (to, from);
        var today = DateOnly.FromDateTime(now.ToOffset(IstClock.Offset).DateTime);
        var days = Weekdays(from, to).Count(d => d < today);
        if (days == 0) return (null, "There is no past weekday in that range - a backtest runs days before today.");
        var startAt = request.StartAtUtc is { } at && at > now ? at : (DateTimeOffset?)null;
        if (startAt > now + MaxStartAhead) return (null, $"A run can be set to start at most {MaxStartAhead.TotalDays:0} days ahead.");
        var clean = (JsonObject)settings.DeepClone();
        clean["underlying"] = underlying;
        clean["from"] = from.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        clean["to"] = to.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var kind = string.IsNullOrWhiteSpace(request.Kind) ? "backtest" : request.Kind.Trim().ToLowerInvariant();
        if (!Kinds.Contains(kind)) return (null, "A run is a backtest or the Feature finder.");
        var name = (request.Name ?? "").Trim();
        if (name.Length > 80) name = name[..80];
        if (name.Length == 0) name = $"{underlying} {from.ToString("d MMM", CultureInfo.InvariantCulture)} – {to.ToString("d MMM", CultureInfo.InvariantCulture)}";
        return (new SignalBacktestJob
        {
            Id = "", Owner = "", Name = name, Kind = kind, Settings = clean, Underlying = underlying,
            From = (string)clean["from"]!, To = (string)clean["to"]!, Days = Math.Min(days, MaxDays),
            Telegram = request.Telegram, StartAtUtc = startAt, State = "queued",
        }, null);
    }

    private static bool TryDate(JsonNode? node, out DateOnly date)
    {
        date = default;
        return node is JsonValue v && v.TryGetValue<string>(out var s) && DateOnly.TryParseExact(s, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out date);
    }

    private static IEnumerable<DateOnly> Weekdays(DateOnly from, DateOnly to)
    {
        for (var d = from; d <= to; d = d.AddDays(1))
            if (d.DayOfWeek is not (DayOfWeek.Saturday or DayOfWeek.Sunday)) yield return d;
    }

    // ---- Files -----------------------------------------------------------------------------------------------------------

    private string ScriptPath() => _configuration["SignalBacktest:ScriptPath"] is { Length: > 0 } configured
        ? Path.GetFullPath(configured, _environment.ContentRootPath)
        : Path.Combine(_environment.ContentRootPath, "scanner-runner", "signal-backtest.mjs");

    private string JobPath(string id) => Path.Combine(_dir, $"{id}.json");
    private string ResultFile(string id) => Path.Combine(_dir, $"{id}.result.json");
    private string FeaturesFile(string id) => Path.Combine(_dir, $"{id}.features.csv");

    private static string NewId(DateTimeOffset now) => $"{now:yyyyMMdd-HHmmss}-{Guid.NewGuid().ToString("n")[..6]}";

    private static bool Same(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

    /// <summary>Sets a run and saves it (under the lock).</summary>
    private void Put(SignalBacktestJob job)
    {
        _jobs[job.Id] = job;
        Save(job);
    }

    private void Save(SignalBacktestJob job)
    {
        var path = JobPath(job.Id);
        try
        {
            File.WriteAllText(path + ".tmp", JsonSerializer.Serialize(job with { Progress = null }, Json));
            File.Move(path + ".tmp", path, overwrite: true);
        }
        catch (Exception ex) { _logger.LogWarning(ex, "Signal backtest {Id} could not be saved.", job.Id); }
    }

    /// <summary>The runs kept on disk; one a stop or restart cut off is queued again - or failed after MaxAttempts starts.</summary>
    private void Load()
    {
        foreach (var path in Directory.EnumerateFiles(_dir, "*.json"))
        {
            if (path.EndsWith(".result.json", StringComparison.OrdinalIgnoreCase)) continue;
            try
            {
                var job = JsonSerializer.Deserialize<SignalBacktestJob>(File.ReadAllText(path), Json);
                if (job is null || string.IsNullOrEmpty(job.Id)) continue;
                if (job.State == "running")
                {
                    job = job.Attempts >= MaxAttempts
                        ? job with { State = "failed", FinishedUtc = DateTimeOffset.UtcNow, Error = $"stopped by a server restart {job.Attempts} times" }
                        : job with { State = "queued", Note = "queued again after a server restart" };
                    Save(job);
                }
                _jobs[job.Id] = job;
            }
            catch (Exception ex) { _logger.LogWarning(ex, "Signal backtest run {Path} could not be read.", path); }
        }
        foreach (var stale in Directory.EnumerateFiles(_dir, "*.running*")) TryDelete(stale);
    }

    /// <summary>Over <see cref="MaxJobs"/>: the oldest finished runs go (under the lock).</summary>
    private void Trim()
    {
        var extra = _jobs.Count - MaxJobs;
        if (extra <= 0) return;
        foreach (var job in _jobs.Values.Where(j => j.State is not ("queued" or "running")).OrderBy(j => j.CreatedUtc).Take(extra).ToList())
        {
            _jobs.Remove(job.Id);
            TryDelete(JobPath(job.Id));
            TryDelete(ResultFile(job.Id));
            TryDelete(FeaturesFile(job.Id));
        }
    }

    private void StopForShutdown()
    {
        _stopping = true;
        lock (_lock)
        {
            if (_process is { } process)
            {
                try { process.Kill(entireProcessTree: true); } catch { /* already gone */ }
            }
        }
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { /* best effort */ }
    }
}

/// <summary>A run asked for by the Signal backtest page: its settings (the page's - index, from / to, the rule, levels,
/// timeframe), a name, when to start (null = now), whether to send Telegram when it ends and what it is
/// (<see cref="SignalBacktestJobService.Kinds"/> - null = a backtest).</summary>
public sealed record SignalBacktestRequest(JsonNode? Settings, string? Name = null, DateTimeOffset? StartAtUtc = null, bool Telegram = true, string? Kind = null);

/// <summary>A background run: what was asked, its state (queued / running / done / failed / cancelled), its progress
/// (the day it is on, the trades and net so far) and, once done, the report's numbers.</summary>
public sealed record SignalBacktestJob
{
    public required string Id { get; init; }
    public required string Owner { get; init; }
    public required string Name { get; init; }
    /// <summary>"backtest" (the rule's report) or "features" (the Feature finder) - a run saved before kinds is a backtest.</summary>
    public string Kind { get; init; } = "backtest";
    public required JsonNode Settings { get; init; }
    public required string Underlying { get; init; }
    public required string From { get; init; }
    public required string To { get; init; }
    public int Days { get; init; }
    public bool Telegram { get; init; }
    public DateTimeOffset CreatedUtc { get; init; }
    public DateTimeOffset? StartAtUtc { get; init; }
    public string State { get; init; } = "queued";
    public DateTimeOffset? StartedUtc { get; init; }
    public DateTimeOffset? FinishedUtc { get; init; }
    public string? Error { get; init; }
    public string? Note { get; init; }
    public JsonNode? Progress { get; init; }
    public JsonNode? Summary { get; init; }
    public int Attempts { get; init; }
}

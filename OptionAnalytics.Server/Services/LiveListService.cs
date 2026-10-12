using System.Globalization;
using System.Text.Json;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// The LIVE LIST per index: the strategies the server scanner may place real orders for when the index is Live today
/// (ServerLiveService). Every other strategy still alerts and paper-trades, so it keeps being measured and can earn its
/// place. Worked out afresh from two records, so it keeps learning as both grow:
///  - the strategy tuning's trades on that index (TuningPerformance, "as written": the strategy's own rules, never
///    fitted), measured on the option the index trades (Trade settings: buy -> the option bought, else sold) AFTER
///    costs: 2 x the index's slippage + the charges in premium points per trade;
///  - the server scanner's own trades on that index (server-trades.csv: paper and live, with the settings in force,
///    net of charges) - the live record. Once it has MinLiveTrades closed trades it decides: losing there takes a
///    strategy off however good its history looked.
/// On the list = at least MinTrades tuning trades, average R after costs above 0 and a win rate of at least MinWinPct
/// (and the live record, once long enough, not losing); or added by hand. Taken off by hand wins over everything.
/// Score (best first) orders the list: when two strategies fire together, the better one gets the one open slot.
/// Rules and the by-hand changes are kept in {data}/live-list.json.
/// </summary>
public sealed class LiveListService
{
    private readonly StrategyTuningService? _tuning;
    private readonly ScannerLogStore? _log;
    private readonly ScannerRunnerStore? _runner;
    private readonly TradeSettingsStore _trade;
    private readonly ILogger<LiveListService> _logger;
    private readonly string _path;
    private readonly object _lock = new();
    private State _state;
    private (DateTimeOffset At, Dictionary<string, List<LiveListEntry>> Lists)? _cache;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public LiveListService(StrategyTuningService tuning, ScannerLogStore log, TradeSettingsStore trade, IHostEnvironment environment, IConfiguration configuration, ILogger<LiveListService> logger, ScannerRunnerStore runner)
        : this(tuning, log, trade, PathOf(environment, configuration), logger, runner) { }

    internal LiveListService(StrategyTuningService? tuning, ScannerLogStore? log, TradeSettingsStore trade, string path, ILogger<LiveListService> logger, ScannerRunnerStore? runner = null)
    {
        _tuning = tuning;
        _log = log;
        _runner = runner;
        _trade = trade;
        _path = path;
        _logger = logger;
        _state = Load();
    }

    private static string PathOf(IHostEnvironment environment, IConfiguration configuration)
    {
        var configured = configuration["Storage:LiveListPath"];
        var path = string.IsNullOrWhiteSpace(configured) ? "live-list.json" : configured;
        return Path.IsPathRooted(path) ? path : Path.Combine(environment.ContentRootPath, path);
    }

    public LiveListRules Rules() { lock (_lock) return _state.Rules; }

    /// <summary>Every index's list (on it or not, each with its numbers and why) - kept for a minute.</summary>
    public Dictionary<string, List<LiveListEntry>> Lists()
    {
        lock (_lock) if (_cache is { } c && DateTimeOffset.UtcNow - c.At < TimeSpan.FromMinutes(1)) return c.Lists;
        var runs = _tuning?.HistoryRuns() ?? new List<Dictionary<string, string>>();
        var perf = _tuning is null ? new List<TuningPerformance.Row>() : PerfOf(runs, _tuning.HistoryRows);
        var live = _log?.PathOf("server-trades") is { } p ? ScannerLogStore.Read(p).ToList() : new List<Dictionary<string, string>>();
        State state;
        lock (_lock) state = _state;
        // Which tuned setting is applied to each strategy on each index (the `_tuned` the Apply buttons store with it).
        var applied = _runner?.Config()["filtersByIndex"] as System.Text.Json.Nodes.JsonObject;
        string? AppliedOf(string u, string id) =>
            applied?[u]?[id]?["_tuned"] is System.Text.Json.Nodes.JsonValue v && v.TryGetValue<string>(out var sig) && sig.Length > 0 ? sig : null;
        var lists = TradeSettingsStore.Underlyings.ToDictionary(u => u, u => Compute(u, perf, live, _trade.Get(u), state, id => AppliedOf(u, id)));
        lock (_lock) _cache = (DateTimeOffset.UtcNow, lists);
        return lists;
    }

    /// <summary>The tuning record the list is judged on: the futures strategies' runs, and the spot + options strategies'
    /// own runs ("Spot + options only") - each strategy is tuned in one of the two, and the server scanner trades both.</summary>
    internal static List<TuningPerformance.Row> PerfOf(IReadOnlyList<Dictionary<string, string>> runs, Func<string, string, List<Dictionary<string, string>>?> readRows)
    {
        var futures = TuningPerformance.Build(runs, readRows, "futures").Rows;
        var seen = futures.Select(r => (r.StrategyId, r.Setting)).ToHashSet();
        return futures.Concat(TuningPerformance.Build(runs, readRows, "spot").Rows.Where(r => !seen.Contains((r.StrategyId, r.Setting)))).ToList();
    }

    /// <summary>Why a live order for this strategy on this index must not go out (not on its list), else null.</summary>
    public string? BlockReason(string underlying, string strategyId)
    {
        var entry = Lists().GetValueOrDefault(underlying)?.FirstOrDefault(e => e.StrategyId == strategyId);
        if (entry is null) return $"#{strategyId} has no record on {underlying} yet - not on its live list, paper only";
        return entry.OnList ? null : $"#{entry.StrategyNo} {entry.Strategy} is not on {underlying}'s live list ({entry.Why}) - paper only";
    }

    /// <summary>Changes the rules and / or a strategy's by-hand place on an index's list ("include", "exclude" or "auto").</summary>
    public string? Set(LiveListRules? rules, string? underlying, string? strategyId, string? mode)
    {
        lock (_lock)
        {
            if (rules is not null)
            {
                if (rules.MinTrades is < 1 or > 1000 || rules.MinWinPct is < 0 or > 100 || rules.ChargesPoints is < 0 or > 100 || rules.MinLiveTrades is < 1 or > 1000)
                    return "Rules out of range (min trades 1-1000, win % 0-100, charges 0-100 pts, live trades 1-1000).";
                _state.Rules = rules;
            }
            if (underlying is not null && strategyId is not null)
            {
                var u = underlying.Trim().ToUpperInvariant();
                if (!TradeSettingsStore.Underlyings.Contains(u)) return $"Unknown index {underlying}.";
                var key = $"{u}|{strategyId}";
                _state.Include.Remove(key);
                _state.Exclude.Remove(key);
                if (mode == "include") _state.Include.Add(key);
                else if (mode == "exclude") _state.Exclude.Add(key);
                else if (mode != "auto") return "Mode must be include, exclude or auto.";
            }
            _cache = null;
            Save();
        }
        return null;
    }

    /// <summary>One index's list - pure, for the tests. <paramref name="appliedTuned"/>: strategy id -> the signature of the
    /// fine-tuned setting applied to it on this index (null = none).</summary>
    internal static List<LiveListEntry> Compute(string u, IReadOnlyList<TuningPerformance.Row> perf, IReadOnlyList<Dictionary<string, string>> liveTrades, TradeSettings trade, State state,
        Func<string, string?>? appliedTuned = null)
    {
        var rules = state.Rules;
        var sold = trade.AutoTrade != "buy";
        var cost = 2 * (double)trade.SlippagePoints + rules.ChargesPoints;
        var entries = new Dictionary<string, LiveListEntry>();
        foreach (var row in perf.Where(r => r.Setting == "as written"))
        {
            if (!row.ByIndex.TryGetValue(u, out var s)) continue;
            var leg = sold ? s.Sold : s.Bought;
            if (leg.Trades == 0) continue;
            // R after costs: each trade gives up `cost` points of its SL (the average SL of the trades).
            var avgSl = leg.RTrades > 0 && leg.Risked > 0 ? leg.Risked / leg.RTrades : (double?)null;
            double? avgR = leg.RTrades > 0 ? (leg.TotalR - (avgSl is { } sl ? cost * leg.RTrades / sl : 0)) / leg.RTrades : null;
            var netPts = leg.Points - cost * leg.Trades;
            entries[row.StrategyId] = new LiveListEntry(row.StrategyId, row.StrategyNo, row.Strategy, sold ? "option sold" : "option bought",
                leg.Trades, leg.WinRate is { } w ? Math.Round(w * 100, 1) : null, avgR is { } r ? Math.Round(r, 3) : null, Math.Round(netPts, 1), Math.Round(cost, 2),
                0, null, null, false, false, false, "", 0);
        }
        // The server scanner's own closed trades on this index (paper and live) - the live record.
        foreach (var g in liveTrades.Where(t => t.GetValueOrDefault("underlying") == u && !string.IsNullOrEmpty(t.GetValueOrDefault("exit_time_ist")) && !string.IsNullOrEmpty(t.GetValueOrDefault("strategy_id")))
                     .GroupBy(t => t["strategy_id"]))
        {
            var nets = g.Select(t => Num(t, "net_per_lot") ?? Num(t, "rupees")).Where(v => v is not null).Select(v => v!.Value).ToList();
            var e = entries.GetValueOrDefault(g.Key) ?? new LiveListEntry(g.Key, g.First().GetValueOrDefault("strategy_no", ""), g.Key, sold ? "option sold" : "option bought", 0, null, null, null, Math.Round(cost, 2), 0, null, null, false, false, false, "", 0);
            entries[g.Key] = e with { LiveTrades = nets.Count, LiveWinPct = nets.Count > 0 ? Math.Round(100.0 * nets.Count(v => v > 0) / nets.Count, 1) : null, LiveNetPerLot = nets.Count > 0 ? Math.Round(nets.Sum(), 0) : null };
        }
        // A strategy FINE-TUNED and applied on this index runs with that setting, not as written - so that setting's own
        // record counts too: its trades on days it was never chosen on (TuningPerformance's cross-check), proven when it
        // can be called best there (made money, beat the strategy as written on the same days, won in at least half the
        // months) over at least the minimum trades; a setting in option premium points must also clear the costs.
        if (appliedTuned is not null)
        {
            foreach (var row in perf.Where(r => r.Setting == "fine-tuned"))
            {
                if (appliedTuned(row.StrategyId) is not { } sig) continue;
                var t = row.TunedSettings.GetValueOrDefault(u)?.FirstOrDefault(x => TuningPerformance.SignatureOf(x.Row) == sig);
                var e = entries.GetValueOrDefault(row.StrategyId) ?? new LiveListEntry(row.StrategyId, row.StrategyNo, row.Strategy, sold ? "option sold" : "option bought",
                    0, null, null, null, Math.Round(cost, 2), 0, null, null, false, false, false, "", 0);
                if (t is null) { entries[row.StrategyId] = e with { Tuned = "applied setting not in the tuning history" }; continue; }
                var avgNet = t.Unit == "pts" && t.TestAvg is { } a ? a - cost : t.TestAvg;
                // Each rule it does not meet yet, in plain words - so "not proven yet" says what is missing.
                var missing = TuningPerformance.WhyNotBest(t);
                if (t.TestTrades > 0 && t.TestTrades < rules.MinTrades) missing.Add($"{t.TestTrades} unseen trade(s) - the live list needs {rules.MinTrades}");
                if (t.Unit == "pts" && t.TestAvg is > 0 && !(avgNet > 0)) missing.Add($"{t.TestAvg:+0.00} pts a trade does not clear the {cost:0.##} pts of costs");
                entries[row.StrategyId] = e with
                {
                    Tuned = t.Row.GetValueOrDefault("setting_text", ""), TunedTrades = t.TestTrades, TunedAvg = avgNet is { } x ? Math.Round(x, 3) : null,
                    TunedUnit = t.Unit, TunedPeriods = t.Periods, TunedPeriodsWon = t.PeriodsWon, TunedProven = missing.Count == 0, TunedMissing = missing,
                };
            }
        }
        var list = new List<LiveListEntry>();
        foreach (var e in entries.Values)
        {
            var key = $"{u}|{e.StrategyId}";
            var forcedIn = state.Include.Contains(key);
            var forcedOut = state.Exclude.Contains(key);
            var liveDecides = e.LiveTrades >= rules.MinLiveTrades;
            string? fail = null;
            if (liveDecides && e.LiveNetPerLot is <= 0) fail = $"losing in the live record: ₹{e.LiveNetPerLot:N0} a lot over {e.LiveTrades} trades";
            else if (e.Trades < rules.MinTrades) fail = $"{e.Trades} tuning trade(s) - needs {rules.MinTrades}";
            else if (!(e.AvgR > 0)) fail = $"average {e.AvgR:0.00}R after costs";
            else if (e.WinPct < rules.MinWinPct) fail = $"win rate {e.WinPct:0.#}% under {rules.MinWinPct}%";
            // As written it fails, but its applied fine-tuned setting is proven (the live record, when long enough, still decides).
            var byTuned = fail is not null && e.TunedProven && !(liveDecides && e.LiveNetPerLot is <= 0);
            var tunedText = $"its applied fine-tuned setting is proven: {e.TunedAvg:+0.00;-0.00}{(e.TunedUnit == "pts" ? " pts after costs" : "R")} a trade over {e.TunedTrades} unseen trades, won {e.TunedPeriodsWon} of {e.TunedPeriods} month(s)";
            if (byTuned) fail = null;
            else if (fail is not null && e.Tuned is { Length: > 0 } && !e.TunedProven && e.TunedMissing.Count > 0) fail += $"; its applied fine-tuned setting is not proven yet: {string.Join("; ", e.TunedMissing)}";
            var on = forcedOut ? false : forcedIn || fail is null;
            var proven = byTuned ? tunedText : "proven: enough trades, positive R after costs, win rate met";
            var why = forcedOut ? "taken off by hand" : forcedIn ? (fail is null ? $"{proven}, and added by hand" : $"added by hand ({fail})") : fail ?? proven;
            // Best first: the average R after costs, shrunk for few trades (n / (n + 20)) - plus the live record's say. On
            // the list by its fine-tuned setting: that record's (in R; a premium-points one counts as a small plus).
            var baseScore = byTuned
                ? (e.TunedUnit == "pts" ? 0.1 : e.TunedAvg ?? 0) * e.TunedTrades / (e.TunedTrades + 20.0)
                : (e.AvgR ?? -1) * e.Trades / (e.Trades + 20.0);
            var score = baseScore + (e.LiveTrades > 0 && e.LiveNetPerLot is { } net ? Math.Sign(net) * Math.Min(1, e.LiveTrades / (double)rules.MinLiveTrades) * 0.2 : 0);
            list.Add(e with { OnList = on, ForcedIn = forcedIn, ForcedOut = forcedOut, Why = why, Score = Math.Round(score, 4) });
        }
        return list.OrderByDescending(e => e.OnList).ThenByDescending(e => e.Score).ToList();
    }

    private static double? Num(Dictionary<string, string> row, string key) =>
        row.TryGetValue(key, out var s) && double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : null;

    private State Load()
    {
        try { return File.Exists(_path) ? JsonSerializer.Deserialize<State>(File.ReadAllText(_path), Json) ?? new State() : new State(); }
        catch (Exception ex) { _logger.LogWarning(ex, "{Path} could not be read - the live list starts from its default rules.", _path); return new State(); }
    }

    private void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(_path))!);
            var temp = _path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(_state, Json));
            File.Move(temp, _path, overwrite: true);
        }
        catch (Exception ex) { _logger.LogWarning(ex, "{Path} could not be saved.", _path); }
    }

    internal sealed class State
    {
        public LiveListRules Rules { get; set; } = new();
        public HashSet<string> Include { get; set; } = new();
        public HashSet<string> Exclude { get; set; } = new();
    }
}

/// <summary>What puts a strategy on an index's live list.</summary>
public sealed record LiveListRules(int MinTrades = 20, double MinWinPct = 45, double ChargesPoints = 1, int MinLiveTrades = 10);

/// <summary>One strategy on one index: the tuning record (on the option the index trades, after costs), the live
/// record, whether it is on the list and why.</summary>
public sealed record LiveListEntry(string StrategyId, string StrategyNo, string Strategy, string Measured,
    int Trades, double? WinPct, double? AvgR, double? NetPoints, double CostPoints,
    int LiveTrades, double? LiveWinPct, double? LiveNetPerLot, bool OnList, bool ForcedIn, bool ForcedOut, string Why, double Score)
{
    /// <summary>The fine-tuned setting applied to it on this index (its text), and that setting's record on unseen days:
    /// trades, average (R, or premium points after costs), months won - Proven when it puts the strategy on the list.</summary>
    public string? Tuned { get; init; }
    public int TunedTrades { get; init; }
    public double? TunedAvg { get; init; }
    public string? TunedUnit { get; init; }
    public int TunedPeriods { get; init; }
    public int TunedPeriodsWon { get; init; }
    public bool TunedProven { get; init; }
    /// <summary>What the applied fine-tuned setting still misses to be proven (empty when it is).</summary>
    public List<string> TunedMissing { get; init; } = new();
}

public sealed record LiveListSetRequest(LiveListRules? Rules, string? Underlying, string? StrategyId, string? Mode);

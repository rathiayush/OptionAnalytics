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
    private readonly TradeSettingsStore _trade;
    private readonly ILogger<LiveListService> _logger;
    private readonly string _path;
    private readonly object _lock = new();
    private State _state;
    private (DateTimeOffset At, Dictionary<string, List<LiveListEntry>> Lists)? _cache;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public LiveListService(StrategyTuningService tuning, ScannerLogStore log, TradeSettingsStore trade, IHostEnvironment environment, IConfiguration configuration, ILogger<LiveListService> logger)
        : this(tuning, log, trade, PathOf(environment, configuration), logger) { }

    internal LiveListService(StrategyTuningService? tuning, ScannerLogStore? log, TradeSettingsStore trade, string path, ILogger<LiveListService> logger)
    {
        _tuning = tuning;
        _log = log;
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
        var perf = _tuning is null ? new List<TuningPerformance.Row>() : TuningPerformance.Build(runs, _tuning.HistoryRows, "futures").Rows;
        var live = _log?.PathOf("server-trades") is { } p ? ScannerLogStore.Read(p).ToList() : new List<Dictionary<string, string>>();
        State state;
        lock (_lock) state = _state;
        var lists = TradeSettingsStore.Underlyings.ToDictionary(u => u, u => Compute(u, perf, live, _trade.Get(u), state));
        lock (_lock) _cache = (DateTimeOffset.UtcNow, lists);
        return lists;
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

    /// <summary>One index's list - pure, for the tests.</summary>
    internal static List<LiveListEntry> Compute(string u, IReadOnlyList<TuningPerformance.Row> perf, IReadOnlyList<Dictionary<string, string>> liveTrades, TradeSettings trade, State state)
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
            var on = forcedOut ? false : forcedIn || fail is null;
            var why = forcedOut ? "taken off by hand" : forcedIn ? (fail is null ? "proven, and added by hand" : $"added by hand ({fail})") : fail ?? "proven: enough trades, positive R after costs, win rate met";
            // Best first: the average R after costs, shrunk for few trades (n / (n + 20)) - plus the live record's say.
            var score = (e.AvgR ?? -1) * e.Trades / (e.Trades + 20.0) + (e.LiveTrades > 0 && e.LiveNetPerLot is { } net ? Math.Sign(net) * Math.Min(1, e.LiveTrades / (double)rules.MinLiveTrades) * 0.2 : 0);
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
    int LiveTrades, double? LiveWinPct, double? LiveNetPerLot, bool OnList, bool ForcedIn, bool ForcedOut, string Why, double Score);

public sealed record LiveListSetRequest(LiveListRules? Rules, string? Underlying, string? StrategyId, string? Mode);

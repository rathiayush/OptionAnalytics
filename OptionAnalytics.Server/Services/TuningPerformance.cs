using System.Globalization;
using System.Text.Json.Serialization;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Every tuning run's trades added up per strategy - across all indices and all runs - so the strategies that do best
/// stand out (the Trades page's Strategy performance). Runs overlap (the same day scanned by two runs), so a trade is
/// counted once: the same index, data, strategy, setting, day and entry time is the same trade, taken from the newest
/// run. "as written" and "fine-tuned" are kept apart; for each strategy and index the newest fine-tuned setting is
/// returned too, so it can be applied to the scanner from there.
/// </summary>
public static class TuningPerformance
{
    public sealed class Stats
    {
        public int Trades { get; set; }
        public int Wins { get; set; }
        public int Losses { get; set; }
        public int SlHits { get; set; }
        public double Points { get; set; }
        public double Captured { get; set; }
        public double Lost { get; set; }
        public double TotalR { get; set; }
        public int RTrades { get; set; }
        public double BoughtPoints { get; set; }
        public int BoughtTrades { get; set; }
        public double SoldPoints { get; set; }
        public int SoldTrades { get; set; }
        public double OptionPoints { get; set; }
        public int OptionTrades { get; set; }
        [JsonIgnore] public HashSet<string> Days { get; } = new();
        [JsonIgnore] public HashSet<string> Runs { get; } = new();
        public string? FirstDay { get; set; }
        public string? LastDay { get; set; }

        public double? WinRate => Trades > 0 ? (double)Wins / Trades : null;
        public double? AvgR => RTrades > 0 ? TotalR / RTrades : null;
        public int DayCount => Days.Count;
        public int RunCount => Runs.Count;

        internal void Add(Dictionary<string, string> t)
        {
            Trades++;
            var p = Num(t, "points");
            if (p is { } pts)
            {
                Points += pts;
                if (pts > 0) { Wins++; Captured += pts; } else if (pts < 0) { Losses++; Lost += pts; }
            }
            if (Num(t, "r") is { } r) { TotalR += r; RTrades++; }
            var closed = t.GetValueOrDefault("closed_by", "");
            if (closed.Contains("stop", StringComparison.OrdinalIgnoreCase) || closed.Contains("SL", StringComparison.Ordinal)) SlHits++;
            if (Num(t, "bought_points") is { } b) { BoughtPoints += b; BoughtTrades++; }
            if (Num(t, "sold_points") is { } s) { SoldPoints += s; SoldTrades++; }
            if (Num(t, "option_points") is { } o) { OptionPoints += o; OptionTrades++; }
            var day = t.GetValueOrDefault("date", "");
            Days.Add($"{t.GetValueOrDefault("index", "")}|{day}");
            Runs.Add(t.GetValueOrDefault("run_id", ""));
            if (day.Length > 0)
            {
                if (FirstDay is null || string.CompareOrdinal(day, FirstDay) < 0) FirstDay = day;
                if (LastDay is null || string.CompareOrdinal(day, LastDay) > 0) LastDay = day;
            }
        }
    }

    public sealed record Row(string Data, string StrategyId, string StrategyNo, string Strategy, string Setting,
        Stats All, IReadOnlyDictionary<string, Stats> ByIndex, IReadOnlyDictionary<string, Dictionary<string, string>> LatestTuned)
    {
        /// <summary>Per index: every distinct fine-tuned setting the runs found for this strategy, scored across all of them,
        /// best first (see TunedSetting).</summary>
        public IReadOnlyDictionary<string, List<TunedSetting>> TunedSettings { get; init; } = new Dictionary<string, List<TunedSetting>>();
    }

    /// <summary>One fine-tuned setting (the same parameters) across every run that chose it: how many runs, how many of them
    /// recommended it, and its scores added up - Test is the days each run held back and never chose on (the honest
    /// number), Train the days it was chosen on. Score = the test average shrunk toward 0 for few trades
    /// (avg x n / (n + 10)), so a setting proven over many unseen trades beats a lucky one. Row = the newest run's row,
    /// which is what Apply sends to the scanner.</summary>
    public sealed record TunedSetting(Dictionary<string, string> Row, int Runs, int Recommended, int TestTrades, double? TestAvg,
        int TrainTrades, double? TrainAvg, double PointsNet, string Unit, double? Score, bool Best);

    private sealed class TunedAcc
    {
        public Dictionary<string, string> Row = null!;
        public int Runs, Recommended, TestTrades, TrainTrades;
        public double TestSum, TrainSum, PointsNet;
    }

    /// <summary>The parameters of a settings row (every trade* / opt* column) - two runs that chose the same setting share it.</summary>
    private static string SignatureOf(Dictionary<string, string> row) =>
        string.Join('|', row.Where(kv => kv.Key.StartsWith("trade", StringComparison.Ordinal) || kv.Key.StartsWith("opt", StringComparison.Ordinal))
            .OrderBy(kv => kv.Key, StringComparer.Ordinal).Select(kv => $"{kv.Key}={kv.Value}"));

    private static double? Num(Dictionary<string, string> row, string key) =>
        row.TryGetValue(key, out var s) && double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : null;

    /// <summary>The cumulative rows. <paramref name="runs"/>: runs.csv rows, newest first; <paramref name="readRows"/>:
    /// a run's trades / settings rows (null when missing).</summary>
    public static (List<Row> Rows, int Runs, int Trades) Build(IReadOnlyList<Dictionary<string, string>> runs,
        Func<string, string, List<Dictionary<string, string>>?> readRows, string? data = null)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var groups = new Dictionary<(string Data, string Id, string Setting), (Dictionary<string, string> First, Stats All, Dictionary<string, Stats> ByIndex)>();
        var latestTuned = new Dictionary<(string Data, string Id), Dictionary<string, Dictionary<string, string>>>();
        var tuned = new Dictionary<(string Data, string Id), Dictionary<string, Dictionary<string, TunedAcc>>>();
        var usedRuns = 0;
        var trades = 0;
        foreach (var run in runs) // newest first: a trade seen in a newer run is not counted again from an older one
        {
            var runId = run.GetValueOrDefault("run_id", "");
            var runData = run.GetValueOrDefault("data", "futures");
            if (data is not null && runData != data) continue;
            var rows = readRows(runId, "trades");
            if (rows is null) continue;
            usedRuns++;
            foreach (var t in rows)
            {
                var index = t.GetValueOrDefault("index", run.GetValueOrDefault("index", ""));
                var id = t.GetValueOrDefault("strategy_id", "");
                var setting = t.GetValueOrDefault("setting", "as written");
                if (id.Length == 0) continue;
                if (!seen.Add($"{runData}|{index}|{id}|{setting}|{t.GetValueOrDefault("date", "")}|{t.GetValueOrDefault("entry_time_ist", "")}")) continue;
                var key = (runData, id, setting);
                if (!groups.TryGetValue(key, out var g)) groups[key] = g = (t, new Stats(), new Dictionary<string, Stats>());
                g.All.Add(t);
                if (!g.ByIndex.TryGetValue(index, out var s)) g.ByIndex[index] = s = new Stats();
                s.Add(t);
                trades++;
            }
            foreach (var st in readRows(runId, "settings") ?? new())
            {
                if (st.GetValueOrDefault("which") != "fine-tuned") continue;
                var key = (runData, st.GetValueOrDefault("strategy_id", ""));
                if (!latestTuned.TryGetValue(key, out var byIndex)) latestTuned[key] = byIndex = new();
                var index = st.GetValueOrDefault("index", "");
                if (!byIndex.ContainsKey(index)) byIndex[index] = st; // newest run first
                if (!tuned.TryGetValue(key, out var tunedByIndex)) tuned[key] = tunedByIndex = new();
                if (!tunedByIndex.TryGetValue(index, out var bySig)) tunedByIndex[index] = bySig = new();
                var sig = SignatureOf(st);
                if (!bySig.TryGetValue(sig, out var acc)) bySig[sig] = acc = new TunedAcc { Row = st }; // newest run's row
                acc.Runs++;
                if (st.GetValueOrDefault("recommended") == "yes") acc.Recommended++;
                var testN = (int)(Num(st, "test_trades") ?? 0);
                var trainN = (int)(Num(st, "train_trades") ?? 0);
                acc.TestTrades += testN; acc.TestSum += (Num(st, "test_avg") ?? 0) * testN;
                acc.TrainTrades += trainN; acc.TrainSum += (Num(st, "train_avg") ?? 0) * trainN;
                acc.PointsNet += Num(st, "points_net") ?? 0;
            }
        }
        var tunedOut = tuned.ToDictionary(kv => kv.Key, kv => (IReadOnlyDictionary<string, List<TunedSetting>>)kv.Value.ToDictionary(x => x.Key, x => Rank(x.Value.Values)));
        var result = groups
            .Select(kv => new Row(kv.Key.Data, kv.Key.Id, kv.Value.First.GetValueOrDefault("strategy_no", ""), kv.Value.First.GetValueOrDefault("strategy", kv.Key.Id),
                kv.Key.Setting, kv.Value.All, kv.Value.ByIndex,
                latestTuned.TryGetValue((kv.Key.Data, kv.Key.Id), out var lt) ? lt : new Dictionary<string, Dictionary<string, string>>())
            {
                TunedSettings = tunedOut.TryGetValue((kv.Key.Data, kv.Key.Id), out var ts) ? ts : new Dictionary<string, List<TunedSetting>>(),
            })
            .OrderByDescending(r => r.All.AvgR ?? double.MinValue).ThenByDescending(r => r.All.Points)
            .ToList();
        return (result, usedRuns, trades);
    }

    /// <summary>Every trade of one strategy across all runs - counted once like Build (the newest run's copy of a trade two
    /// runs both scanned) - optionally only one setting ("as written" / "fine-tuned") and one index; oldest first.</summary>
    public static List<Dictionary<string, string>> Trades(IReadOnlyList<Dictionary<string, string>> runs,
        Func<string, string, List<Dictionary<string, string>>?> readRows, string? data, string strategyId, string? setting = null, string? index = null)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var list = new List<Dictionary<string, string>>();
        foreach (var run in runs)
        {
            var runData = run.GetValueOrDefault("data", "futures");
            if (data is not null && runData != data) continue;
            foreach (var t in readRows(run.GetValueOrDefault("run_id", ""), "trades") ?? new())
            {
                if (t.GetValueOrDefault("strategy_id") != strategyId) continue;
                var s = t.GetValueOrDefault("setting", "as written");
                var i = t.GetValueOrDefault("index", run.GetValueOrDefault("index", ""));
                if (setting is not null && s != setting) continue;
                if (index is not null && i != index) continue;
                if (!seen.Add($"{runData}|{i}|{strategyId}|{s}|{t.GetValueOrDefault("date", "")}|{t.GetValueOrDefault("entry_time_ist", "")}")) continue;
                list.Add(t);
            }
        }
        return list.OrderBy(t => t.GetValueOrDefault("entry_time_ist", ""), StringComparer.Ordinal).ToList();
    }

    /// <summary>One day of one index across every run that looked at it: Status "used" when any run scanned it (else
    /// "left out", with the newest run's Reason); TrainRuns / TestRuns = in how many runs it was a day the settings were
    /// chosen on / a held-back day they were checked on.</summary>
    public sealed record DayRow(string Index, string Date, string Status, string? Reason, int Runs, int TrainRuns, int TestRuns, bool Estimated);

    /// <summary>The days scanned per index: Scanned = distinct days used, LeftOut = days no run could use, First / Last =
    /// the first and last day scanned. Runs written before the day list existed (OlderRuns) only give a count: AtLeast is
    /// then the most days one of them used, and Scanned is never below it.</summary>
    public sealed record DayCoverage(string Index, int Scanned, int LeftOut, int TestDays, string? FirstDay, string? LastDay, int Runs, int OlderRuns, bool AtLeast);

    public static (List<DayCoverage> Coverage, List<DayRow> Days) Days(IReadOnlyList<Dictionary<string, string>> runs,
        Func<string, string, List<Dictionary<string, string>>?> readRows, string? data = null)
    {
        var acc = new Dictionary<(string Index, string Date), (string? Status, string? Reason, int Runs, int Train, int Test, bool Est)>();
        var withList = new Dictionary<string, int>(StringComparer.Ordinal);
        var older = new Dictionary<string, (int Runs, int MaxUsed, string? First, string? Last)>(StringComparer.Ordinal);
        foreach (var run in runs) // newest first
        {
            var runData = run.GetValueOrDefault("data", "futures");
            if (data is not null && runData != data) continue;
            var runIndex = run.GetValueOrDefault("index", "");
            var rows = readRows(run.GetValueOrDefault("run_id", ""), "days");
            if (rows is null)
            {
                var o = older.GetValueOrDefault(runIndex);
                var used = (int)(Num(run, "days_used") ?? 0);
                string? first = run.GetValueOrDefault("first_day"), last = run.GetValueOrDefault("last_day");
                if (string.CompareOrdinal(first, last) > 0) (first, last) = (last, first);
                older[runIndex] = (o.Runs + 1, Math.Max(o.MaxUsed, used),
                    MinDay(o.First, first), MaxDay(o.Last, last));
                continue;
            }
            withList[runIndex] = withList.GetValueOrDefault(runIndex) + 1;
            foreach (var r in rows)
            {
                var key = (r.GetValueOrDefault("index", runIndex), r.GetValueOrDefault("date", ""));
                if (key.Item2.Length == 0) continue;
                var a = acc.GetValueOrDefault(key);
                var isUsed = r.GetValueOrDefault("status") == "used";
                var role = r.GetValueOrDefault("role");
                acc[key] = (
                    a.Status == "used" || isUsed ? "used" : "left out",
                    a.Reason ?? (isUsed ? null : r.GetValueOrDefault("reason")), // newest run's reason first
                    a.Runs + 1, a.Train + (isUsed && role == "train" ? 1 : 0), a.Test + (isUsed && role == "test" ? 1 : 0),
                    a.Est || (isUsed && r.GetValueOrDefault("estimated") == "yes"));
            }
        }
        var days = acc.Select(kv => new DayRow(kv.Key.Index, kv.Key.Date, kv.Value.Status!, kv.Value.Status == "used" ? null : kv.Value.Reason,
                kv.Value.Runs, kv.Value.Train, kv.Value.Test, kv.Value.Est))
            .OrderBy(d => d.Index, StringComparer.Ordinal).ThenBy(d => d.Date, StringComparer.Ordinal).ToList();
        var coverage = withList.Keys.Union(older.Keys).OrderBy(i => i, StringComparer.Ordinal).Select(index =>
        {
            var mine = days.Where(d => d.Index == index).ToList();
            var used = mine.Where(d => d.Status == "used").ToList();
            var o = older.GetValueOrDefault(index);
            var atLeast = o.Runs > 0 && o.MaxUsed > used.Count;
            return new DayCoverage(index, Math.Max(used.Count, o.MaxUsed), mine.Count - used.Count, used.Count(d => d.TestRuns > 0),
                MinDay(used.FirstOrDefault()?.Date, o.First), MaxDay(used.LastOrDefault()?.Date, o.Last),
                withList.GetValueOrDefault(index) + o.Runs, o.Runs, atLeast);
        }).ToList();
        return (coverage, days);
    }

    private static string? MinDay(string? a, string? b) =>
        string.IsNullOrEmpty(a) ? (string.IsNullOrEmpty(b) ? null : b) : string.IsNullOrEmpty(b) || string.CompareOrdinal(a, b) <= 0 ? a : b;
    private static string? MaxDay(string? a, string? b) =>
        string.IsNullOrEmpty(a) ? (string.IsNullOrEmpty(b) ? null : b) : string.IsNullOrEmpty(b) || string.CompareOrdinal(a, b) >= 0 ? a : b;

    /// <summary>The settings best first by Score; Best marks the top one any run recommended (else none).</summary>
    private static List<TunedSetting> Rank(IEnumerable<TunedAcc> accs)
    {
        var list = accs.Select(a =>
        {
            double? testAvg = a.TestTrades > 0 ? a.TestSum / a.TestTrades : null;
            double? score = testAvg is { } t ? t * a.TestTrades / (a.TestTrades + 10.0) : null;
            return new TunedSetting(a.Row, a.Runs, a.Recommended, a.TestTrades, testAvg, a.TrainTrades,
                a.TrainTrades > 0 ? a.TrainSum / a.TrainTrades : null, a.PointsNet, a.Row.GetValueOrDefault("unit", "R"), score, false);
        }).OrderByDescending(x => x.Score ?? double.MinValue).ThenByDescending(x => x.Runs).ToList();
        var best = list.FindIndex(x => x.Recommended > 0 && x.Score > 0);
        if (best >= 0) list[best] = list[best] with { Best = true };
        return list;
    }
}

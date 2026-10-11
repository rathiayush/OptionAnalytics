using System.Globalization;

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
        public HashSet<string> Days { get; } = new();
        public HashSet<string> Runs { get; } = new();
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
        Stats All, IReadOnlyDictionary<string, Stats> ByIndex, IReadOnlyDictionary<string, Dictionary<string, string>> LatestTuned);

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
            }
        }
        var result = groups
            .Select(kv => new Row(kv.Key.Data, kv.Key.Id, kv.Value.First.GetValueOrDefault("strategy_no", ""), kv.Value.First.GetValueOrDefault("strategy", kv.Key.Id),
                kv.Key.Setting, kv.Value.All, kv.Value.ByIndex,
                latestTuned.TryGetValue((kv.Key.Data, kv.Key.Id), out var lt) ? lt : new Dictionary<string, Dictionary<string, string>>()))
            .OrderByDescending(r => r.All.AvgR ?? double.MinValue).ThenByDescending(r => r.All.Points)
            .ToList();
        return (result, usedRuns, trades);
    }
}

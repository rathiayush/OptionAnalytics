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
        /// <summary>Each way of taking the trades - the index (futures / spot) and the option bought / sold (and the tuned
        /// option trade) - with its points, the points risked, R and the planned risk : reward.</summary>
        public Leg Futures { get; } = new();
        public Leg Bought { get; } = new();
        public Leg Sold { get; } = new();
        public Leg Option { get; } = new();
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
            Futures.Add(Num(t, "points"), Num(t, "sl_points"), Num(t, "target_points"), Num(t, "r"));
            Bought.Add(Num(t, "bought_points"), Num(t, "bought_sl"), Num(t, "bought_target"), Num(t, "bought_r"));
            Sold.Add(Num(t, "sold_points"), Num(t, "sold_sl"), Num(t, "sold_target"), Num(t, "sold_r"));
            // The tuned option trade: option_sl is its SL premium level; its distance from the entry is the risk.
            var optRisk = Num(t, "option_sl_points") ?? (Num(t, "option_in") is { } inP && Num(t, "option_sl") is { } slP ? Math.Abs(inP - slP) : null);
            var optReward = Num(t, "option_in") is { } inT && Num(t, "option_target") is { } tgP ? Math.Abs(tgP - inT) : (double?)null;
            Option.Add(Num(t, "option_points"), optRisk, optReward, Num(t, "option_r"));
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

    /// <summary>One way of taking the trades. R = the points made over the points risked (its SL distance) - a trade
    /// without a stop has no R; risk : reward = 1 : target / SL as planned. Worked out from the trade rows, so runs
    /// written before the r columns existed get it too (their SL / target / points are in the rows).</summary>
    public sealed class Leg
    {
        public int Trades { get; set; }
        public int Wins { get; set; }
        public double Points { get; set; }
        public int RTrades { get; set; }
        public double TotalR { get; set; }
        public double Risked { get; set; }
        public double RiskReward { get; set; }
        public int RiskRewardTrades { get; set; }
        public double? AvgR => RTrades > 0 ? TotalR / RTrades : null;
        public double? AvgRiskReward => RiskRewardTrades > 0 ? RiskReward / RiskRewardTrades : null;
        public double? WinRate => Trades > 0 ? (double)Wins / Trades : null;

        internal void Add(double? points, double? sl, double? target, double? r)
        {
            if (points is not { } p) return;
            Trades++;
            Points += p;
            if (p > 0) Wins++;
            var risk = sl is > 0 ? sl : null;
            var rr = r ?? (risk is { } k ? p / k : null);
            if (rr is { } x && risk is { } k2) { TotalR += x; RTrades++; Risked += k2; }
            else if (rr is { } y && risk is null) { TotalR += y; RTrades++; }
            if (risk is { } k3 && target is > 0) { RiskReward += target.Value / k3; RiskRewardTrades++; }
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
    /// recommended it, and its record on UNSEEN days - days it was never chosen on. That record is the CROSS-CHECK
    /// ({run}-checks.csv, scanner-runner/tuneChecks.mjs): every run measures every setting found so far for its index on
    /// its own days that setting was not chosen on, so a setting tuned on one month is also judged on every other month
    /// tuned (and on its own month's held-back days); a day two runs both checked counts once. Runs written before the
    /// cross-check add their held-back (test) days as before. Test = that unseen record; Train = the days it was chosen on.
    /// Periods / PeriodsWon = the months (an older run's test days: one period) it traded in on unseen days / made money
    /// in; BaseAvg = the strategy as written on the same unseen days (null when there are no cross-check days);
    /// CheckedRuns = how many runs other than the ones that chose it checked it. Score = the unseen average shrunk toward
    /// 0 for few trades (avg x n / (n + 10)), so a setting proven over many unseen trades beats a lucky one.
    /// Best (see Rank) = the highest score that is above 0, beats the strategy as written on the same days, and - once
    /// it has been checked over two or more months - won in at least half of them (with one month: recommended by its
    /// run). Row = the newest run's row, which is what Apply sends to the scanner.</summary>
    public sealed record TunedSetting(Dictionary<string, string> Row, int Runs, int Recommended, int TestTrades, double? TestAvg,
        int TrainTrades, double? TrainAvg, double PointsNet, string Unit, double? Score, bool Best,
        int Periods = 0, int PeriodsWon = 0, double? BaseAvg = null, int CheckedRuns = 0, double? CheckAvg = null)
    {
        /// <summary>Why it cannot be called best yet (WhyNotBest) - empty when it can.</summary>
        public List<string> NotBestBecause => WhyNotBest(this);
    }

    private sealed class TunedAcc
    {
        public Dictionary<string, string> Row = null!;
        public int Runs, Recommended, TestTrades, TrainTrades;
        public double TestSum, TrainSum, PointsNet;
        /// <summary>Held-back days of runs that have no cross-check file (counted as before), one period each.</summary>
        public int LegacyTrades;
        public double LegacySum;
        public List<double> LegacyPeriods = new();
        public HashSet<string> ChosenBy = new(StringComparer.Ordinal);
        public CheckAcc? Check;
    }

    /// <summary>A setting's cross-check rows added up (each day once - the newest run's row).</summary>
    private sealed class CheckAcc
    {
        public int N, Wins, BaseN;
        public double Sum, BaseSum;
        public Dictionary<string, (int N, double Sum)> Months = new(StringComparer.Ordinal);
        public HashSet<string> Runs = new(StringComparer.Ordinal);
    }

    /// <summary>The parameters of a settings row (every non-empty trade* / opt* column) - two runs that chose the same
    /// setting share it, whichever columns their files had; a cross-check row carries the same columns.</summary>
    public static string SignatureOf(Dictionary<string, string> row) =>
        string.Join('|', row.Where(kv => (kv.Key.StartsWith("trade", StringComparison.Ordinal) || kv.Key.StartsWith("opt", StringComparison.Ordinal)) && kv.Value.Length > 0)
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
        var checks = new Dictionary<(string Data, string Id, string Index, string Sig), CheckAcc>();
        var checkSeen = new HashSet<string>(StringComparer.Ordinal);
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
            // The cross-check: every setting found so far, per day of this run it was not chosen on. A day two runs both
            // checked counts once (the newest run's row - runs come newest first).
            var checkRows = readRows(runId, "checks");
            foreach (var c in checkRows ?? new())
            {
                var id = c.GetValueOrDefault("strategy_id", "");
                var index = c.GetValueOrDefault("index", run.GetValueOrDefault("index", ""));
                var date = c.GetValueOrDefault("date", "");
                if (id.Length == 0 || date.Length < 7) continue;
                var sig = SignatureOf(c);
                if (!checkSeen.Add($"{runData}|{index}|{id}|{sig}|{date}")) continue;
                var key = (runData, id, index, sig);
                if (!checks.TryGetValue(key, out var acc)) checks[key] = acc = new CheckAcc();
                var n = (int)(Num(c, "n") ?? 0);
                var total = Num(c, "total") ?? 0;
                acc.N += n; acc.Sum += total; acc.Wins += (int)(Num(c, "wins") ?? 0);
                acc.BaseN += (int)(Num(c, "base_n") ?? 0); acc.BaseSum += Num(c, "base_total") ?? 0;
                if (n > 0)
                {
                    var month = date[..7];
                    var m = acc.Months.GetValueOrDefault(month);
                    acc.Months[month] = (m.N + n, m.Sum + total);
                }
                acc.Runs.Add(runId);
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
                acc.ChosenBy.Add(runId);
                if (st.GetValueOrDefault("recommended") == "yes") acc.Recommended++;
                var testN = (int)(Num(st, "test_trades") ?? 0);
                var trainN = (int)(Num(st, "train_trades") ?? 0);
                // A run with a cross-check file has its own held-back days in it; an older run's count as they were.
                if (checkRows is null && testN > 0)
                {
                    var avg = Num(st, "test_avg") ?? 0;
                    acc.LegacyTrades += testN; acc.LegacySum += avg * testN; acc.LegacyPeriods.Add(avg);
                }
                acc.TrainTrades += trainN; acc.TrainSum += (Num(st, "train_avg") ?? 0) * trainN;
                acc.PointsNet += Num(st, "points_net") ?? 0;
            }
        }
        foreach (var ((d, id), byIndex) in tuned)
            foreach (var (index, bySig) in byIndex)
                foreach (var (sig, acc) in bySig)
                    acc.Check = checks.GetValueOrDefault((d, id, index, sig));
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

    /// <summary>Every trade of one strategy (null = EVERY strategy) across all runs - counted once like Build (the newest
    /// run's copy of a trade two runs both scanned) - optionally only one setting ("as written" / "fine-tuned") and one
    /// index; oldest first by date and time (then index, then strategy number).</summary>
    public static List<Dictionary<string, string>> Trades(IReadOnlyList<Dictionary<string, string>> runs,
        Func<string, string, List<Dictionary<string, string>>?> readRows, string? data, string? strategyId, string? setting = null, string? index = null)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var list = new List<Dictionary<string, string>>();
        foreach (var run in runs)
        {
            var runData = run.GetValueOrDefault("data", "futures");
            if (data is not null && runData != data) continue;
            foreach (var t in readRows(run.GetValueOrDefault("run_id", ""), "trades") ?? new())
            {
                var id = t.GetValueOrDefault("strategy_id", "");
                if (id.Length == 0 || (strategyId is not null && id != strategyId)) continue;
                var s = t.GetValueOrDefault("setting", "as written");
                var i = t.GetValueOrDefault("index", run.GetValueOrDefault("index", ""));
                if (setting is not null && s != setting) continue;
                if (index is not null && i != index) continue;
                if (!seen.Add($"{runData}|{i}|{id}|{s}|{t.GetValueOrDefault("date", "")}|{t.GetValueOrDefault("entry_time_ist", "")}")) continue;
                list.Add(t);
            }
        }
        return list.OrderBy(t => t.GetValueOrDefault("entry_time_ist", ""), StringComparer.Ordinal)
            .ThenBy(t => t.GetValueOrDefault("index", ""), StringComparer.Ordinal)
            .ThenBy(t => int.TryParse(t.GetValueOrDefault("strategy_no"), out var n) ? n : int.MaxValue)
            .ToList();
    }

    /// <summary>Totals over a list of trades: how many, wins / losses (by points), the R added up and the points of the
    /// index trade, the option bought and the option sold (points only add up within one index).</summary>
    public sealed record TradeTotals(int Trades, int Wins, int Losses, double TotalR, double Points, double BoughtPoints, double SoldPoints, int Days, string? FirstDay, string? LastDay);

    public static TradeTotals Totals(IReadOnlyList<Dictionary<string, string>> trades)
    {
        var p = trades.Select(t => Num(t, "points")).Where(v => v is not null).Select(v => v!.Value).ToList();
        var days = trades.Select(t => t.GetValueOrDefault("date", "")).Where(d => d.Length > 0).Distinct().OrderBy(d => d, StringComparer.Ordinal).ToList();
        return new TradeTotals(trades.Count, p.Count(x => x > 0), p.Count(x => x < 0), Math.Round(trades.Sum(t => Num(t, "r") ?? 0), 3), Math.Round(p.Sum(), 1),
            Math.Round(trades.Sum(t => Num(t, "bought_points") ?? 0), 1), Math.Round(trades.Sum(t => Num(t, "sold_points") ?? 0), 1), days.Count, days.FirstOrDefault(), days.LastOrDefault());
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

    /// <summary>The settings best first by Score (on unseen days, every run's cross-check added up); Best marks the top one
    /// that can be trusted (CanBeBest), else none.</summary>
    private static List<TunedSetting> Rank(IEnumerable<TunedAcc> accs)
    {
        var list = accs.Select(a =>
        {
            var c = a.Check;
            var n = (c?.N ?? 0) + a.LegacyTrades;
            var sum = (c?.Sum ?? 0) + a.LegacySum;
            double? unseenAvg = n > 0 ? sum / n : null;
            double? score = unseenAvg is { } t ? t * n / (n + 10.0) : null;
            var months = c?.Months.Values.Where(m => m.N > 0).ToList() ?? new();
            var periods = months.Count + a.LegacyPeriods.Count;
            var won = months.Count(m => m.Sum > 0) + a.LegacyPeriods.Count(x => x > 0);
            double? baseAvg = c is { BaseN: > 0 } ? c.BaseSum / c.BaseN : null;
            double? checkAvg = c is { N: > 0 } ? c.Sum / c.N : null;
            var checkedRuns = c?.Runs.Count(r => !a.ChosenBy.Contains(r)) ?? 0;
            return new TunedSetting(a.Row, a.Runs, a.Recommended, n, unseenAvg, a.TrainTrades,
                a.TrainTrades > 0 ? a.TrainSum / a.TrainTrades : null, a.PointsNet, a.Row.GetValueOrDefault("unit", "R"), score, false,
                periods, won, baseAvg, checkedRuns, checkAvg);
        }).OrderByDescending(x => x.Score ?? double.MinValue).ThenByDescending(x => x.Runs).ToList();
        var best = list.FindIndex(CanBeBest);
        if (best >= 0) list[best] = list[best] with { Best = true };
        return list;
    }

    /// <summary>A setting that can be called best: it made money on its unseen days (shrunk score above 0), it beat the
    /// strategy as written on the same cross-checked days, and it did not just fit one stretch - checked over two or more
    /// months, it won in at least half of them; with only one month, its own run recommended it.</summary>
    public static bool CanBeBest(TunedSetting x) => WhyNotBest(x).Count == 0;

    /// <summary>Each rule of CanBeBest the setting does not meet yet, in plain words with its numbers and what to do -
    /// empty when it can be best. Shown beside "not proven yet" (the Trades page and the live list).</summary>
    public static List<string> WhyNotBest(TunedSetting x)
    {
        var u = x.Unit == "pts" ? " pts" : "R";
        var why = new List<string>();
        if (x.TestTrades == 0)
        {
            why.Add("no trade yet on a day it was not chosen on - run a Re-check (Strategy tuning → Tune: Re-check settings) over other months, or tune another month");
            return why;
        }
        if (!(x.Score > 0)) why.Add($"loses on its unseen days ({x.TestAvg:+0.00;-0.00}{u} a trade over {x.TestTrades})");
        if (x.BaseAvg is { } b && x.CheckAvg is { } m && !(m > b)) why.Add($"no better than the strategy as written on the same days ({m:+0.00;-0.00}{u} vs {b:+0.00;-0.00}{u} a trade)");
        if (x.Periods >= 2 && x.PeriodsWon * 2 < x.Periods) why.Add($"won in only {x.PeriodsWon} of {x.Periods} months");
        if (x.Periods < 2 && x.Recommended == 0)
            why.Add($"checked in only {(x.Periods == 1 ? "one month" : "no full month")} and its run did not recommend it - a Re-check over other months (or tuning more months) gives it more unseen days");
        return why;
    }
}

using System.Globalization;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// What the live signals teach: for each strategy on each index, which order-flow conditions at the signal (the
/// mkt_* columns the scanner keeps with every signal - tape, big orders, the order book, delta, volume) went with
/// winning trades. For each condition the closed signals are split into "met" and "not met" (turned to the trade's
/// side: tape bought for a LONG, sold for a SHORT...), with each group's count, win rate and average R. A condition is
/// SUGGESTED only when both groups have at least MinSignals, it lifts the average R by at least MinLiftR, and it does so
/// on the older half of the signals AND the newer half (by date) - a pattern of one stretch of days is not a lesson.
/// Each condition is exactly one of the scanner's order-flow trade filters, so a suggestion can be applied as is.
/// Signals with the number blank (an estimated day) are left out of that condition.
/// </summary>
public static class LearningReport
{
    public const int MinSignals = 8;
    public const double MinLiftR = 0.15;

    /// <summary>One condition = one order-flow trade filter (TRADE_FILTERS in strategyEngine.js - flowGatePasses).</summary>
    public sealed record Condition(string Key, string Label, string Filter, string Mode, Func<Dictionary<string, string>, int, bool?> Met);

    public static readonly Condition[] Conditions =
    {
        new("tape", "Tape with the trade (55%+ my way, last minute)", "tradeTape", "with", (r, d) => Num(r, "mkt_tape60") is { } v ? d * (v - 50) >= 5 : null),
        new("tapeStrong", "Tape strongly with the trade (60%+)", "tradeTape", "strong", (r, d) => Num(r, "mkt_tape60") is { } v ? d * (v - 50) >= 10 : null),
        new("big", "Big orders net with the trade (last 5 min)", "tradeBig", "with", (r, d) => Num(r, "mkt_big_net") is { } v ? d * v > 0 : null),
        new("book", "Order book leaning my way (heatmap, 10%+)", "tradeBook", "with", (r, d) => Num(r, "mkt_book_imb") is { } v ? d * v >= 0.1 : null),
        new("cvd", "Delta of the last 15 min with the trade", "tradeCvd", "with", (r, d) => Num(r, "mkt_cvd15") is { } v ? d * v > 0 : null),
        new("volume", "Volume above the day's average (1.2x+)", "tradeVolume", "above", (r, _) => Num(r, "mkt_vol_x") is { } v ? v >= 1.2 : null),
        new("quiet", "Quiet volume (under the average)", "tradeVolume", "below", (r, _) => Num(r, "mkt_vol_x") is { } v ? v < 1 : null),
    };

    public sealed record Group(int Signals, double? WinPct, double? AvgR);

    public sealed record Finding(string Condition, string Label, string Filter, string Mode, Group Met, Group NotMet, double? LiftR,
        bool HeldOlder, bool HeldNewer, bool Suggested, string Why);

    public sealed record StrategyLearning(string Underlying, string StrategyId, string StrategyNo, string Strategy, int Signals, int WithMarket,
        double? WinPct, double? AvgR, List<Finding> Findings);

    /// <summary>The signals rows (both scanner records; the same signal twice counts once), every index and strategy.</summary>
    public static List<StrategyLearning> Build(IEnumerable<Dictionary<string, string>> signals)
    {
        var closed = signals
            .Where(r => r.GetValueOrDefault("status") is "win" or "loss" or "flat" && Num(r, "r") is not null)
            .GroupBy(r => $"{r.GetValueOrDefault("underlying")}|{r.GetValueOrDefault("strategy_id")}|{r.GetValueOrDefault("side")}|{r.GetValueOrDefault("time_ist")}")
            .Select(g => g.OrderByDescending(r => r.Keys.Count(k => k.StartsWith("mkt_", StringComparison.Ordinal) && r[k].Length > 0)).First())
            .ToList();
        var result = new List<StrategyLearning>();
        foreach (var g in closed.GroupBy(r => (U: r.GetValueOrDefault("underlying", ""), Id: r.GetValueOrDefault("strategy_id", ""))).OrderBy(g => g.Key.U).ThenBy(g => g.Key.Id))
        {
            var rows = g.OrderBy(r => r.GetValueOrDefault("time_ist", ""), StringComparer.Ordinal).ToList();
            var withMarket = rows.Count(r => r.GetValueOrDefault("mkt_tape60", "").Length > 0 || r.GetValueOrDefault("mkt_vol_x", "").Length > 0);
            var findings = Conditions.Select(c => Judge(c, rows)).Where(f => f is not null).Select(f => f!)
                .OrderByDescending(f => f.Suggested).ThenByDescending(f => f.LiftR ?? double.MinValue).ToList();
            var first = rows[0];
            var all = Of(rows);
            result.Add(new StrategyLearning(g.Key.U, g.Key.Id, first.GetValueOrDefault("strategy_no", ""), first.GetValueOrDefault("strategy", g.Key.Id),
                rows.Count, withMarket, all.WinPct, all.AvgR, findings));
        }
        return result;
    }

    private static Finding? Judge(Condition c, List<Dictionary<string, string>> rows)
    {
        var judged = rows.Select(r => (Row: r, Met: c.Met(r, r.GetValueOrDefault("side") == "SHORT" ? -1 : 1))).Where(x => x.Met is not null).ToList();
        if (judged.Count == 0) return null;
        var met = Of(judged.Where(x => x.Met == true).Select(x => x.Row).ToList());
        var not = Of(judged.Where(x => x.Met == false).Select(x => x.Row).ToList());
        double? lift = met.AvgR is { } a && not.AvgR is { } b ? Math.Round(a - b, 3) : null;
        // The same on the older half and the newer half of these signals (by time).
        var half = judged.Count / 2;
        bool Held(IEnumerable<(Dictionary<string, string> Row, bool? Met)> part)
        {
            var list = part.ToList();
            var m = Of(list.Where(x => x.Met == true).Select(x => x.Row).ToList());
            var n = Of(list.Where(x => x.Met == false).Select(x => x.Row).ToList());
            return m.Signals >= 3 && n.Signals >= 3 && m.AvgR > n.AvgR;
        }
        var older = Held(judged.Take(half));
        var newer = Held(judged.Skip(half));
        string why;
        var suggested = false;
        if (met.Signals < MinSignals || not.Signals < MinSignals) why = $"too few signals to tell ({met.Signals} met / {not.Signals} not - needs {MinSignals} each)";
        else if (!(lift >= MinLiftR)) why = lift > 0 ? $"only +{lift:0.00}R better - not enough to filter on" : "no better when met";
        else if (!older || !newer) why = $"+{lift:0.00}R better, but not on both the older and the newer signals - not steady yet";
        else { suggested = true; why = $"+{lift:0.00}R a trade better when met, on the older and the newer signals alike"; }
        return new Finding(c.Key, c.Label, c.Filter, c.Mode, met, not, lift, older, newer, suggested, why);
    }

    private static Group Of(List<Dictionary<string, string>> rows)
    {
        var rs = rows.Select(r => Num(r, "r")).Where(v => v is not null).Select(v => v!.Value).ToList();
        return new Group(rs.Count, rs.Count > 0 ? Math.Round(100.0 * rs.Count(v => v > 0) / rs.Count, 1) : null, rs.Count > 0 ? Math.Round(rs.Average(), 3) : null);
    }

    private static double? Num(Dictionary<string, string> row, string key) =>
        row.TryGetValue(key, out var s) && double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : null;
}

using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>What comparing one day fetched BOTH ways produced - the range endpoint's own proof,
/// meant to be run for real (GET /api/oi-replay/{u}/range-check) before a long job trusts the fast
/// path, not only in tests. Match is true only when every OI point lines up: the same strikes, the
/// same minutes, the same open interest, the same premium, on both sides. Differences names what
/// did not, at most MaxDifferencesReported of them (a wholesale mismatch would otherwise produce
/// thousands of near-identical lines); Counts gives the two sides' sizes either way.</summary>
public sealed record OiReplayDayComparison(
    bool Match,
    DateOnly Date,
    int RangeCePoints,
    int RangePePoints,
    int PerDayCePoints,
    int PerDayPePoints,
    IReadOnlyList<string> Differences);

/// <summary>
/// The runtime check behind the range endpoint: does a day cut out of a multi-day window fetch hold
/// EXACTLY the same OI as the same day fetched one day at a time (OiReplayService.RunAsync, the path
/// this app has always used)? Nothing about the range path is worth having if the answer is ever no -
/// these numbers price real trades through the strategy tuning job.
///
/// Compared point by point, not by summary statistics: every (strike, minute) pair on each side must
/// exist on the other side with the same open interest and the same premium. A missing minute, an
/// extra strike, a different OI value - each one is reported by name. Deliberately strict: the whole
/// design claim is "the same data, fetched in fewer calls", so anything other than equality is a
/// difference worth seeing, and the caller's own job is to go back to the per-day path when it sees
/// one.
/// </summary>
public static class OiReplayDayComparer
{
    /// <summary>How many individual differences are listed before the rest are summarised as a
    /// count - a genuinely mismatched day can differ in thousands of points, and the first handful
    /// plus the total is what actually tells a person what went wrong.</summary>
    internal const int MaxDifferencesReported = 20;

    /// <summary>Compares the two fetches of one day. Both are expected to be successful results for
    /// the SAME date; a failed or mismatched-date side is itself reported as a difference rather than
    /// quietly treated as "nothing to compare" (an unsuccessful range day that the caller then
    /// believed was equal would be the worst possible outcome of this check).</summary>
    public static OiReplayDayComparison Compare(DateOnly date, OiReplayResult range, OiReplayResult perDay)
    {
        var differences = new List<string>();
        var truncated = 0;
        void Report(string difference)
        {
            if (differences.Count < MaxDifferencesReported) differences.Add(difference);
            else truncated++;
        }

        if (!range.Success) Report($"the range fetch did not succeed: {range.Error ?? "no reason given"}");
        if (!perDay.Success) Report($"the per-day fetch did not succeed: {perDay.Error ?? "no reason given"}");
        if (range.Date != date) Report($"the range result is for {range.Date:yyyy-MM-dd}, not {date:yyyy-MM-dd}");
        if (perDay.Date != date) Report($"the per-day result is for {perDay.Date:yyyy-MM-dd}, not {date:yyyy-MM-dd}");

        ComparePoints("CALL", range.CePoints, perDay.CePoints, Report);
        ComparePoints("PUT", range.PePoints, perDay.PePoints, Report);

        // A strike whose own fetch failed is reported by both paths (OptionErrors) - a day that is
        // incomplete on one side only is a real difference, not a cosmetic one: it means the two
        // paths disagree about what is missing.
        var rangeErrors = range.OptionErrors.Count;
        var perDayErrors = perDay.OptionErrors.Count;
        if (rangeErrors != perDayErrors)
            Report($"{rangeErrors} strike series failed on the range fetch, {perDayErrors} on the per-day fetch");

        if (truncated > 0) differences.Add($"...and {truncated} more difference(s)");

        return new OiReplayDayComparison(differences.Count == 0, date,
            range.CePoints.Count, range.PePoints.Count, perDay.CePoints.Count, perDay.PePoints.Count, differences);
    }

    /// <summary>One side (CE or PE) of the ladder, keyed by (strike, minute) - the same key the OI
    /// Replay page's own context looks a point up by, so equality here is equality of everything a
    /// strategy can actually read.</summary>
    private static void ComparePoints(string side, IReadOnlyList<OiReplayPoint> range, IReadOnlyList<OiReplayPoint> perDay, Action<string> report)
    {
        var rangeByKey = Index(range);
        var perDayByKey = Index(perDay);

        foreach (var (key, point) in perDayByKey.OrderBy(p => p.Key.Strike).ThenBy(p => p.Key.Minute))
        {
            if (!rangeByKey.TryGetValue(key, out var fromRange))
            {
                report($"{side} {key.Strike} at {Ist(key.Minute)} is missing from the range fetch");
                continue;
            }

            if (fromRange.OpenInterest != point.OpenInterest)
                report($"{side} {key.Strike} at {Ist(key.Minute)}: open interest {Show(fromRange.OpenInterest)} from the range fetch, {Show(point.OpenInterest)} per-day");
            if (fromRange.Price != point.Price)
                report($"{side} {key.Strike} at {Ist(key.Minute)}: premium {fromRange.Price} from the range fetch, {point.Price} per-day");
            if (fromRange.ImpliedVolatility != point.ImpliedVolatility)
                report($"{side} {key.Strike} at {Ist(key.Minute)}: IV {Show(fromRange.ImpliedVolatility)} from the range fetch, {Show(point.ImpliedVolatility)} per-day");
            if (fromRange.High != point.High || fromRange.Low != point.Low || fromRange.Open != point.Open)
                report($"{side} {key.Strike} at {Ist(key.Minute)}: the minute's own OHLC differs (range O/H/L {Show(fromRange.Open)}/{Show(fromRange.High)}/{Show(fromRange.Low)}, per-day {Show(point.Open)}/{Show(point.High)}/{Show(point.Low)})");
        }

        foreach (var (key, _) in rangeByKey.OrderBy(p => p.Key.Strike).ThenBy(p => p.Key.Minute))
            if (!perDayByKey.ContainsKey(key))
                report($"{side} {key.Strike} at {Ist(key.Minute)} is in the range fetch but not in the per-day fetch");
    }

    /// <summary>Keyed by strike and minute. A duplicate key keeps the FIRST point, exactly as the
    /// page's own lookup would see it, so a duplicate on one side alone still shows up as a
    /// difference in the values rather than being silently reconciled.</summary>
    private static Dictionary<(decimal Strike, DateTimeOffset Minute), OiReplayPoint> Index(IReadOnlyList<OiReplayPoint> points)
    {
        var byKey = new Dictionary<(decimal, DateTimeOffset), OiReplayPoint>();
        foreach (var point in points) byKey.TryAdd((point.Strike, point.Time), point);
        return byKey;
    }

    /// <summary>The minute as a person reads it - IST, the market's own clock (the points' own
    /// timestamps are absolute instants).</summary>
    private static string Ist(DateTimeOffset time) => time.ToOffset(IstClock.Offset).ToString("HH:mm");

    private static string Show(long? value) => value?.ToString() ?? "(none)";
    private static string Show(decimal? value) => value?.ToString() ?? "(none)";
}

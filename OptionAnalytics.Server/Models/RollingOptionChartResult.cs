namespace OptionAnalytics.Server.Models;

/// <summary>One bar of ExpiredOptionBacktestService.GetRollingChartAsync's raw fetch - the RAW
/// series (before TrimToLargestSegment would trim it for a real backtest run), so a page inspecting
/// this data can see literally every bar Dhan's rolling-option endpoint returned, corrupt or not -
/// the same "see everything, not just what a strategy would use" philosophy StrikeDataPage already
/// applies to a live-tracked contract. ResolvedStrike is the ABSOLUTE strike Dhan itself resolved
/// this bar's "ATM+-K" request to (null if its response omitted the field) - the one piece of data
/// that can directly prove a wrong-contract resolution rather than just a surprising premium.</summary>
public sealed record RollingOptionChartBar(
    DateTimeOffset Time, decimal Open, decimal High, decimal Low, decimal Close, long Volume, decimal? ResolvedStrike);

/// <summary>What GetRollingChartAsync hands back - the raw rolling-option series for one relative
/// strike/side plus the splices this app's own DetectPossibleSplices already found in it, so a page
/// built to just LOOK at this data (rather than run a strategy against it) can show exactly what a
/// real Expired Backtest run would have fetched and let a splice/anomaly be inspected directly rather
/// than only inferred from a trade's own surprising exit price.
///
/// RequestedAbsoluteStrike echoes back the caller's own GetRollingChartAsync absoluteStrike (null
/// when the caller used a plain otmSteps offset instead) - the one fixed number to compare each
/// bar's own ResolvedStrike against. A resolved-strike RANGE spanning far from this value across the
/// window is meaningful either way: Dhan's rolling endpoint resolves "ATM+-K" AS OF EACH DAY in the
/// range (its own docs' wording, not a one-time pick against a single reference), so the SAME
/// requested token can legitimately land on a different absolute strike on an earlier day if spot
/// itself was far from where it is on the day the offset was computed against - and a page showing
/// that drift is what lets a caller tell "this is really several different real strikes stitched
/// together" apart from "one contract quietly repriced a lot".</summary>
public sealed record RollingOptionChartResult(
    bool Success,
    string? Error,
    string StrikeToken,
    string OptionType,
    int EffectiveLookbackDays,
    IReadOnlyList<RollingOptionChartBar> Bars,
    IReadOnlyList<PossibleSplice> Splices,
    decimal? RequestedAbsoluteStrike)
{
    public static RollingOptionChartResult Failed(string error) =>
        new(false, error, "", "", 0, Array.Empty<RollingOptionChartBar>(), Array.Empty<PossibleSplice>(), null);
}

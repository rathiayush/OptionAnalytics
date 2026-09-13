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
/// than only inferred from a trade's own surprising exit price.</summary>
public sealed record RollingOptionChartResult(
    bool Success,
    string? Error,
    string StrikeToken,
    string OptionType,
    int EffectiveLookbackDays,
    IReadOnlyList<RollingOptionChartBar> Bars,
    IReadOnlyList<PossibleSplice> Splices)
{
    public static RollingOptionChartResult Failed(string error) =>
        new(false, error, "", "", 0, Array.Empty<RollingOptionChartBar>(), Array.Empty<PossibleSplice>());
}

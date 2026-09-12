namespace OptionAnalytics.Server.Models;

/// <summary>What ExpiredOptionBacktestService.RunAsync hands back - the trades/signals a strategy
/// produced, plus enough of how the request was actually resolved (ExpiryCode - now always 1, see
/// that class's own doc comment for why - the two relative strike tokens, each side's own Dhan
/// error) that the page can show WHY a run came back empty rather than just an empty table.
///
/// EffectiveLookbackDays is how many days back of the target contract's own life the run actually
/// used, after being clamped to ExpiredOptionBacktestService.MaxLookbackDays - lower than what was
/// requested whenever that request exceeded the cadence's own safe cap, which the page should show
/// so a smaller-than-asked-for window doesn't read as a bug.
///
/// CeSpliceTimes/PeSpliceTimes (see ExpiredOptionBacktestService.DetectPossibleSplices) are the
/// timestamps of any suspiciously large premium jump found in that side's own series - now a
/// defensive backstop rather than an expected occurrence, since EffectiveLookbackDays' own clamping
/// is what should normally prevent the window from ever reaching a second contract at all. Any
/// splice found here is stronger evidence something is still off than it used to be.
///
/// Ce/PeResolvedStrike are the ACTUAL absolute strike Dhan itself reported resolving "ATM+-K" to
/// (null if Dhan's response omitted the "strike" field entirely); Ce/PeExpectedStrike are what this
/// app itself computed from its own real spot history for the same leg. These should land within one
/// strike step of each other - a wider gap means Dhan's own contract resolution landed somewhere
/// this app did not ask for, which is the direct, checkable explanation for an implausible premium
/// (e.g. a "near-ATM" option priced in the thousands) rather than that premium being a genuine, just
/// surprising, price.
///
/// SpotChartBars is the underlying's own spot candle series for the page's chart - deliberately
/// WIDER than [fromDay,toDay] (see ExpiredOptionBacktestService.ChartPaddingDays), a few days of
/// spot history on each side of the actual lookback window purely so a signal sitting right at the
/// window's own edge has visible context around it, not because the strategy itself saw any of that
/// padding.</summary>
public sealed record ExpiredBacktestResult(
    bool Success,
    string? Error,
    IReadOnlyList<BacktestTrade> Trades,
    IReadOnlyList<BacktestSignal> Signals,
    int ExpiryCode,
    string CeStrike,
    string PeStrike,
    string? CeError,
    string? PeError,
    int SpotBarCount,
    int CeBarCount,
    int PeBarCount,
    IReadOnlyList<DateTimeOffset> CeSpliceTimes,
    IReadOnlyList<DateTimeOffset> PeSpliceTimes,
    decimal? CeResolvedStrike,
    decimal? PeResolvedStrike,
    decimal CeExpectedStrike,
    decimal PeExpectedStrike,
    int EffectiveLookbackDays,
    IReadOnlyList<Candle> SpotChartBars)
{
    public static ExpiredBacktestResult Failed(string error) =>
        new(false, error, Array.Empty<BacktestTrade>(), Array.Empty<BacktestSignal>(), 0, "", "", null, null, 0, 0, 0,
            Array.Empty<DateTimeOffset>(), Array.Empty<DateTimeOffset>(), null, null, 0, 0, 0, Array.Empty<Candle>());
}

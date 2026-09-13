namespace OptionAnalytics.Server.Models;

/// <summary>What ExpiredOptionBacktestService.RunAsync hands back - the trades/signals a strategy
/// produced, plus enough of how the request was actually resolved (ExpiryCode - the NEAREST fetch
/// segment's own code, always 1; see ExpiredOptionBacktestService.BuildFetchSegments for why an
/// OLDER segment, if one was needed, uses a different code not reflected here - the two relative
/// strike tokens, each side's own Dhan error) that the page can show WHY a run came back empty
/// rather than just an empty table.
///
/// EffectiveLookbackDays is how many days back of the target contract's own life the run actually
/// used - lower than what was requested whenever that request reached further back than this app
/// could safely anchor a fetch segment against (however far back real prior expiries of the SAME
/// cadence actually reach - see BuildFetchSegments), which the page should show so a smaller-than-
/// asked-for window doesn't read as a bug.
///
/// CeSplices/PeSplices (see ExpiredOptionBacktestService.DetectPossibleSplices and
/// PossibleSplice's own doc comment) are any suspiciously large premium jump found in that side's
/// own series, with the actual prices either side of it - a defensive backstop against a wrong
/// contract resolution rather than an expected occurrence for a SINGLE-segment run, but genuinely
/// possible (not yet confirmed either way) at the boundary between a run's two fetch segments, if
/// it used two - see BuildFetchSegments's own doc comment. A splice found anywhere else is stronger
/// evidence something is still off than it used to be.
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
/// padding.
///
/// Ce/PeLiveMismatch (see LiveDataMismatch's own doc comment) is the largest disagreement found
/// against CdvHostedService's live-tracked candles for the same real contract - null whenever there
/// was nothing live to compare against (an already-expired target, the ordinary case) or every
/// shared timestamp agreed within tolerance. Only ever possible for a not-yet-expired target this
/// app is also tracking live right now.</summary>
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
    IReadOnlyList<PossibleSplice> CeSplices,
    IReadOnlyList<PossibleSplice> PeSplices,
    decimal? CeResolvedStrike,
    decimal? PeResolvedStrike,
    decimal CeExpectedStrike,
    decimal PeExpectedStrike,
    int EffectiveLookbackDays,
    IReadOnlyList<Candle> SpotChartBars,
    LiveDataMismatch? CeLiveMismatch,
    LiveDataMismatch? PeLiveMismatch)
{
    public static ExpiredBacktestResult Failed(string error) =>
        new(false, error, Array.Empty<BacktestTrade>(), Array.Empty<BacktestSignal>(), 0, "", "", null, null, 0, 0, 0,
            Array.Empty<PossibleSplice>(), Array.Empty<PossibleSplice>(), null, null, 0, 0, 0, Array.Empty<Candle>(), null, null);
}

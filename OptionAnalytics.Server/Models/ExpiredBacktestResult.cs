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
/// BandRadiusSteps is how many relative-strike tokens either side of the band's own center this run
/// actually fetched (ExpiredOptionBacktestService.StrikeBandSteps for an ordinary run, FlowChainRadius
/// for one needing the wide flow chain - see needsFlowChain) - carried through so the page can state
/// the real band width it used directly, rather than a copy of the backend constant hardcoded into the
/// page's own text that would silently go stale the next time that constant changes.
///
/// SpotChartBars is the underlying's own spot candle series for the page's chart - deliberately
/// WIDER than [fromDay,toDay] (see ExpiredOptionBacktestService.ChartPaddingDays), a few days of
/// spot history on each side of the actual lookback window purely so a signal sitting right at the
/// window's own edge has visible context around it, not because the strategy itself saw any of that
/// padding.
///
/// SpotChartBarsOneMinute is that exact same widened window at NATIVE 1-minute resolution, before
/// SpotChartBars' own BacktestUtil.AggregateCandles bucketing to the run's page timeframe - what the
/// frontend's own S/R overlay needs (see BacktestPage.jsx's srLevelLine, mirrored here), since a
/// strategy's own rolling support/resistance channel is computed off the real minute bars
/// independently of whatever timeframe the chart itself displays, never off an already-bucketed
/// series a second time.
///
/// SpotVolumeChartBars/SpotVwapSeries are the same widened window's own volume (real index volume,
/// not synthetic - see DhanHistoricalDataService's own doc comment) and the session VWAP computed
/// off it (VwapCalculator) - always populated, at zero extra Dhan cost, since both are built from
/// spot bars this run already fetches for SpotChartBars regardless of strategy.
///
/// ObvCeSeries/ObvPeSeries/CdvCeSeries/CdvPeSeries are the SAME order-flow series the strategy
/// itself was run against (see BacktestStrategyContext) - empty unless EmaCrossAtmFlowStrategy was
/// selected, or the caller passed includeObvCdv=true to opt a DIFFERENT strategy into computing them
/// anyway purely so the page can plot them for a visual sanity check. See
/// ExpiredOptionBacktestService.RunAsync's own doc comment on why that is opt-in: reconstructing
/// these needs a much wider option-chain fetch than an ordinary run.</summary>
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
    int BandRadiusSteps,
    int EffectiveLookbackDays,
    IReadOnlyList<Candle> SpotChartBars,
    IReadOnlyList<Candle> SpotChartBarsOneMinute,
    IReadOnlyList<CandleWithVolume> SpotVolumeChartBars,
    IReadOnlyList<ObvPoint> SpotVwapSeries,
    IReadOnlyList<ObvPoint> ObvCeSeries,
    IReadOnlyList<ObvPoint> ObvPeSeries,
    IReadOnlyList<ObvPoint> CdvCeSeries,
    IReadOnlyList<ObvPoint> CdvPeSeries)
{
    public static ExpiredBacktestResult Failed(string error) =>
        new(false, error, Array.Empty<BacktestTrade>(), Array.Empty<BacktestSignal>(), 0, "", "", null, null, 0, 0, 0,
            Array.Empty<PossibleSplice>(), Array.Empty<PossibleSplice>(), null, null, 0, 0, 0, 0, Array.Empty<Candle>(),
            Array.Empty<Candle>(), Array.Empty<CandleWithVolume>(), Array.Empty<ObvPoint>(), Array.Empty<ObvPoint>(), Array.Empty<ObvPoint>(),
            Array.Empty<ObvPoint>(), Array.Empty<ObvPoint>());
}

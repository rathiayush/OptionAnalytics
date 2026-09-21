using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Backs the OI Replay page: pick a date and timeframe, click Start, and watch the day play back
/// candle by candle with an OI/IV ladder (every strike in the fetched band, not just the single
/// heaviest one - see the page's own "there could be multiple [support/resistance levels]" request)
/// updating alongside it, at whatever speed the page's own playback control is set to.
///
/// DELIBERATELY, ENTIRELY STORED-DATA-ONLY - unlike ExpiredOptionBacktestService's useStoredData
/// (which only ever PREFERS stored data and falls back to a live Dhan call when the window isn't
/// fully covered), this service has NO live Dhan client injected at all, so there is no fallback
/// path to accidentally take: a gap in NiftyDataCollector's own backfill for the requested date
/// simply comes back as "no data for that date" rather than ever reaching out to Dhan. Both
/// StoredSpotDataService and StoredRollingOptionDataService already need no Dhan security id either
/// (they key everything off the underlying's own NAME against NiftyDataCollector's own TimescaleDB
/// tables), so this service needs no DhanSpotInstrumentMaster/scrip-master resolution at all.
///
/// NEAREST EXPIRY ONLY (expiryCode fixed at 1) - the user's own explicit choice: "at any given point
/// of time it will show nearest expiry OI", matching what NiftyDataCollector's own rolling-option
/// collector actively tracks as "the current cycle" for a live position, rather than a further-out
/// cycle a trader wouldn't usually be reading OI from day to day.
/// </summary>
public sealed class OiReplayService
{
    /// <summary>Same ATM+-10 band width every other strike-band fetch in this app uses (see
    /// ExpiredOptionBacktestService.StrikeBandSteps/FlowChainRadius) - also NiftyDataCollector's own
    /// default CollectorOptions.StrikesEachSide, so a band this wide is exactly what a normal local
    /// collector setup has actually backfilled.</summary>
    private const int StrikeBandSteps = 10;

    /// <summary>The only expiry cycle this page ever reads - see this class's own doc comment.</summary>
    private const int NearestExpiryCode = 1;

    private readonly StoredSpotDataService _storedSpot;
    private readonly StoredRollingOptionDataService _storedRollingOption;

    public OiReplayService(StoredSpotDataService storedSpot, StoredRollingOptionDataService storedRollingOption)
    {
        _storedSpot = storedSpot;
        _storedRollingOption = storedRollingOption;
    }

    public async Task<OiReplayResult> RunAsync(
        string underlying, DateOnly date, int timeframeMinutes, string expiryFlag, CancellationToken cancellationToken)
    {
        var timeframe = Math.Max(1, timeframeMinutes);

        if (!_storedSpot.IsConfigured)
            return OiReplayResult.Failed(underlying, date, timeframe,
                "Stored data is not configured on this server (no NiftyDataCollector database connection) - see ConnectionStrings:NiftyDataCollectorTimescale.");

        if (!ExpiredOptionBacktestService.StrikeStepByUnderlying.TryGetValue(underlying, out var step))
            return OiReplayResult.Failed(underlying, date, timeframe, $"'{underlying}' is not supported - only NIFTY and BANKNIFTY.");

        if (string.Equals(underlying, "BANKNIFTY", StringComparison.OrdinalIgnoreCase) && string.Equals(expiryFlag, "WEEK", StringComparison.OrdinalIgnoreCase))
            return OiReplayResult.Failed(underlying, date, timeframe, "BANKNIFTY has no weekly expiry - NSE discontinued it. Use Monthly instead.");

        var (spotBarsRaw, spotError) = await _storedSpot.GetSpotCandlesAsync(underlying, date, date, cancellationToken);
        if (spotBarsRaw.Count == 0)
            return OiReplayResult.Failed(underlying, date, timeframe,
                spotError ?? $"No stored spot data for {underlying} on {date:dd MMM yyyy} - has NiftyDataCollector backfilled this date yet?");

        var spotBars1m = spotBarsRaw.Select(b => b.ToCandle()).ToList();

        // Every strike NiftyDataCollector might plausibly have backfilled (ATM+-StrikeBandSteps at
        // the time it collected, per underlying) - a strike this page asks for that the collector
        // never tracked just comes back with zero rows, contributing no points, not an error; the
        // frontend's own ladder simply has nothing to show at that level.
        var cePoints = new List<OiReplayPoint>();
        var pePoints = new List<OiReplayPoint>();

        for (var steps = -StrikeBandSteps; steps <= StrikeBandSteps; steps++)
        {
            var token = ExpiredOptionBacktestService.StrikeToken(steps);

            var (ceBars, _) = await _storedRollingOption.GetRollingOptionCandlesAsync(
                underlying, 0, expiryFlag, NearestExpiryCode, token, "CALL", date, date, 1, cancellationToken);
            foreach (var bar in ceBars)
                if (bar.Strike is { } strike)
                    cePoints.Add(new OiReplayPoint(bar.Bar.Time, strike, bar.OpenInterest, bar.ImpliedVolatility));

            var (peBars, _) = await _storedRollingOption.GetRollingOptionCandlesAsync(
                underlying, 0, expiryFlag, NearestExpiryCode, token, "PUT", date, date, 1, cancellationToken);
            foreach (var bar in peBars)
                if (bar.Strike is { } strike)
                    pePoints.Add(new OiReplayPoint(bar.Bar.Time, strike, bar.OpenInterest, bar.ImpliedVolatility));
        }

        var spotCandlesTf = BacktestUtil.AggregateCandles(spotBars1m, timeframe);

        return new OiReplayResult(true, null, underlying, date, timeframe, step, expiryFlag, NearestExpiryCode,
            spotCandlesTf, cePoints, pePoints);
    }
}

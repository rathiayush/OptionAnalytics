using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Backs the OI Replay page: pick a date and timeframe, click Start, and watch the day play back
/// candle by candle with an OI/IV ladder (every strike in the fetched band, not just the single
/// heaviest one - see the page's own "there could be multiple [support/resistance levels]" request)
/// updating alongside it, at whatever speed the page's own playback control is set to.
///
/// STORED-DATA-FIRST, with a live Dhan fallback that's OFF during local development and ON
/// otherwise (see AppEnvironment.IsLocal) - this page was originally built deliberately
/// stored-data-only (no Dhan client injected at all), per the user's own explicit "no live call
/// please on this page". That held fine for replaying a past, fully-closed day, where the stored
/// data is either complete or genuinely missing (and a live re-fetch of the identical already-closed
/// window wouldn't fix a real backfill gap anyway). It falls down for TODAY specifically:
/// NiftyDataCollector's own rolling-option backfill polls on its own cadence
/// (RollingOption:PollIntervalMinutes, an hour by default), so replaying the CURRENT, still-forming
/// session will routinely find the stored data trailing "now" by up to that whole interval - not a
/// bug, just the natural lag of a periodic background poll. It ALSO covers a deployed instance that
/// simply has no database configured at all (ConnectionStrings:NiftyDataCollectorTimescale blank) -
/// StoredSpotDataService/StoredRollingOptionDataService's own IsConfigured guards mean this service
/// just skips straight to Dhan for every series in that case, rather than ever needing the database
/// to be present for this page to work on a deployed environment.
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

    /// <summary>How far behind "now" today's own stored data is allowed to trail before a live Dhan
    /// call is worth making for it - short enough that a genuinely stale series (an hourly poll that
    /// simply hasn't run yet) gets topped up, long enough that this doesn't fire on the ordinary few
    /// seconds of lag between a fresh collector write and this request landing.</summary>
    private static readonly TimeSpan LiveFreshnessWindow = TimeSpan.FromMinutes(10);

    private readonly StoredSpotDataService _storedSpot;
    private readonly StoredRollingOptionDataService _storedRollingOption;
    private readonly DhanSpotInstrumentMaster _instrumentMaster;
    private readonly DhanHistoricalDataService _historicalData;
    private readonly DhanRollingOptionDataService _rollingOption;
    private readonly bool _allowLiveDataFallback;

    public OiReplayService(
        StoredSpotDataService storedSpot, StoredRollingOptionDataService storedRollingOption,
        DhanSpotInstrumentMaster instrumentMaster, DhanHistoricalDataService historicalData, DhanRollingOptionDataService rollingOption,
        AppEnvironment appEnvironment)
    {
        _storedSpot = storedSpot;
        _storedRollingOption = storedRollingOption;
        _instrumentMaster = instrumentMaster;
        _historicalData = historicalData;
        _rollingOption = rollingOption;
        _allowLiveDataFallback = !appEnvironment.IsLocal;
    }

    public async Task<OiReplayResult> RunAsync(
        string underlying, DateOnly date, int timeframeMinutes, string expiryFlag, CancellationToken cancellationToken)
    {
        var timeframe = Math.Max(1, timeframeMinutes);

        if (!_storedSpot.IsConfigured && !_allowLiveDataFallback)
            return OiReplayResult.Failed(underlying, date, timeframe,
                "Stored data is not configured on this server (no NiftyDataCollector database connection) - see ConnectionStrings:NiftyDataCollectorTimescale.");

        if (!ExpiredOptionBacktestService.StrikeStepByUnderlying.TryGetValue(underlying, out var step))
            return OiReplayResult.Failed(underlying, date, timeframe, $"'{underlying}' is not supported - only NIFTY and BANKNIFTY.");

        if (string.Equals(underlying, "BANKNIFTY", StringComparison.OrdinalIgnoreCase) && string.Equals(expiryFlag, "WEEK", StringComparison.OrdinalIgnoreCase))
            return OiReplayResult.Failed(underlying, date, timeframe, "BANKNIFTY has no weekly expiry - NSE discontinued it. Use Monthly instead.");

        // Resolved lazily, at most once per request, only if a live call actually ends up being
        // needed below - a past day whose stored data is already complete never touches Dhan at all.
        DhanSpotInstrument? instrument = null;
        var instrumentResolveAttempted = false;

        async Task<DhanSpotInstrument?> ResolveInstrumentAsync()
        {
            if (instrumentResolveAttempted) return instrument;
            instrumentResolveAttempted = true;
            await _instrumentMaster.EnsureLoadedAsync(cancellationToken);
            instrument = _instrumentMaster.FindSpot(underlying);
            return instrument;
        }

        var spotBarsRaw = _storedSpot.IsConfigured
            ? (await _storedSpot.GetSpotCandlesAsync(underlying, date, date, cancellationToken)).Bars
            : Array.Empty<CandleWithVolume>();
        var spotError = (string?)null;

        if (_allowLiveDataFallback && !IsFreshEnough(date, spotBarsRaw.Count > 0 ? spotBarsRaw[^1].Time : null))
        {
            var liveInstrument = await ResolveInstrumentAsync();
            if (liveInstrument is not null)
            {
                var (liveSpotBars, liveSpotError) = await _historicalData.GetIntradayCandlesAsync(
                    liveInstrument.SecurityId, liveInstrument.DhanSegment, date, date, 1, cancellationToken);
                // Only trust the live call over whatever's already stored if it actually found
                // something - a live error (auth, market holiday) should never blank out a
                // perfectly good, merely slightly-stale stored result.
                if (liveSpotBars.Count > 0) spotBarsRaw = liveSpotBars;
                else spotError = liveSpotError;
            }
        }

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

            var ceBars = await GetSeriesAsync(underlying, expiryFlag, token, "CALL", date, ResolveInstrumentAsync, cancellationToken);
            foreach (var bar in ceBars)
                if (bar.Strike is { } strike)
                    cePoints.Add(new OiReplayPoint(bar.Bar.Time, strike, bar.OpenInterest, bar.ImpliedVolatility, bar.Bar.Close));

            var peBars = await GetSeriesAsync(underlying, expiryFlag, token, "PUT", date, ResolveInstrumentAsync, cancellationToken);
            foreach (var bar in peBars)
                if (bar.Strike is { } strike)
                    pePoints.Add(new OiReplayPoint(bar.Bar.Time, strike, bar.OpenInterest, bar.ImpliedVolatility, bar.Bar.Close));
        }

        var spotCandlesTf = BacktestUtil.AggregateCandles(spotBars1m, timeframe);

        return new OiReplayResult(true, null, underlying, date, timeframe, step, expiryFlag, NearestExpiryCode,
            spotCandlesTf, spotBars1m, cePoints, pePoints);
    }

    /// <summary>One CE or PE series for one relative strike: stored first (when configured), then a
    /// live Dhan call over it ONLY when live fallback is allowed and the stored result isn't fresh
    /// enough (see IsFreshEnough) - the exact same "prefer stored, fall through when it's not good
    /// enough" shape as ExpiredOptionBacktestService's own useStoredData handling, just decided per
    /// series here instead of once per whole request, since different strikes' own stored rows can
    /// in principle lag by different amounts.</summary>
    private async Task<IReadOnlyList<(CandleWithVolume Bar, decimal? Strike, decimal? Spot, long? OpenInterest, decimal? ImpliedVolatility)>> GetSeriesAsync(
        string underlying, string expiryFlag, string strikeToken, string drvOptionType, DateOnly date,
        Func<Task<DhanSpotInstrument?>> resolveInstrument, CancellationToken cancellationToken)
    {
        var storedBars = _storedRollingOption.IsConfigured
            ? (await _storedRollingOption.GetRollingOptionCandlesAsync(underlying, 0, expiryFlag, NearestExpiryCode, strikeToken, drvOptionType, date, date, 1, cancellationToken)).Bars
            : Array.Empty<(CandleWithVolume, decimal?, decimal?, long?, decimal?)>();

        if (!_allowLiveDataFallback) return storedBars;

        var latest = storedBars.Count > 0 ? storedBars[^1].Item1.Time : (DateTimeOffset?)null;
        if (IsFreshEnough(date, latest)) return storedBars;

        var instrument = await resolveInstrument();
        if (instrument is null) return storedBars;

        var (liveBars, _) = await _rollingOption.GetRollingOptionCandlesAsync(
            underlying, instrument.SecurityId, expiryFlag, NearestExpiryCode, strikeToken, drvOptionType, date, date, 1, cancellationToken);
        return liveBars.Count > 0 ? liveBars : storedBars;
    }

    /// <summary>Whether a stored result for `date` is trustworthy enough to skip a live Dhan
    /// fallback for it. A genuinely past (fully-closed) day: non-empty is good enough - a real gap
    /// there is a backfill problem a live re-fetch of the SAME already-closed window would only
    /// paper over identically, not actually fix. Today (still in progress): only trustworthy if its
    /// last stored point is within LiveFreshnessWindow of right now - anything older just means the
    /// background poll (RollingOption:PollIntervalMinutes defaults to an hour) hasn't caught up yet,
    /// which is exactly when a live call earns its cost.</summary>
    private static bool IsFreshEnough(DateOnly date, DateTimeOffset? latestStoredTime)
    {
        if (latestStoredTime is null) return false;
        if (date < IstClock.Today()) return true;
        return DateTimeOffset.UtcNow - latestStoredTime.Value <= LiveFreshnessWindow;
    }
}

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
///
/// FUTURES ARE DIFFERENT FROM ALL OF THE ABOVE - always a live Dhan call, in every environment
/// including local development, with no stored source and no AppEnvironment.IsLocal gate at all -
/// see GetFuturesAsync's own doc comment. NiftyDataCollector's database has no futures data
/// whatsoever, so there is nothing to prefer over Dhan the way spot/options do.
///
/// SENSEX IS LIVE-ONLY TOO, LIKE FUTURES - the user's own explicit "sensex will always be fetch
/// from live dhan call": NiftyDataCollector's database has never collected SENSEX at all (see
/// HistoricalSpotDataPrefetchHostedService's own doc comment), so spot AND options for SENSEX skip
/// the stored path entirely and always call Dhan directly, in every environment, the same shape
/// futures already uses (see AlwaysLiveUnderlyings below). This is a DIFFERENT reason than
/// ExpiredOptionBacktestService's own StrikeStepByUnderlying excluding SENSEX (uncertainty over
/// whether Dhan's rolling-option endpoint even accepts a BSE exchange segment) - that uncertainty
/// still applies here too (see DhanRollingOptionDataService.ResolveFnoSegment's own doc comment),
/// just accepted now at the user's own explicit request rather than left unsupported.
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

    /// <summary>How many strike/side fetches (out of the 42 the ATM+-10 band needs - 21 strikes x
    /// CE/PE) run concurrently, when they end up needing a live Dhan call. This used to be a plain
    /// sequential loop - correct, but on a deployed environment with no stored database configured
    /// (see ConnectionStrings:NiftyDataCollectorTimescale, deliberately blank there - this class's
    /// own top-of-file doc comment), EVERY one of the 42 calls falls through to Dhan, one at a time,
    /// so the page's own load time is 42x a single call's network round trip with zero overlap - the
    /// dominant, previously-unaddressed cause of "OI Replay takes forever to load" on a real
    /// deployment. A modest, bounded concurrency (not unbounded - Dhan's own per-connection/rate
    /// limits for this endpoint aren't documented, and DhanRollingOptionDataService's own
    /// RateLimitRetryDelay/MaxRateLimitRetries already give a graceful fallback if this guess turns
    /// out too aggressive) cuts wall-clock time by roughly this factor without leaning on an
    /// undocumented limit.</summary>
    private const int MaxConcurrentStrikeFetches = 4;

    /// <summary>Strike step per underlying THIS PAGE supports - deliberately its own dictionary
    /// rather than reusing ExpiredOptionBacktestService.StrikeStepByUnderlying, which excludes
    /// SENSEX for a reason specific to ITS OWN stored/prefetch pipeline (see that dictionary's own
    /// doc comment) that does not apply here - OI Replay never touches NiftyDataCollector's database
    /// for SENSEX at all (see AlwaysLiveUnderlyings below and this class's own top-of-file doc
    /// comment), so there is nothing stored to be uncertain about. 100 matches SENSEX's own real
    /// strike spacing, the same value CdvHostedService/SpotFeedHostedService already use for it.
    /// Also read by OiReplayLiveFeedService for the same reason.</summary>
    internal static readonly Dictionary<string, int> StrikeStepByUnderlying = new(StringComparer.OrdinalIgnoreCase)
    {
        ["NIFTY"] = 50,
        ["BANKNIFTY"] = 100,
        ["SENSEX"] = 100,
    };

    /// <summary>Underlyings with no stored source to prefer at all - see this class's own top-of-file
    /// doc comment ("SENSEX IS LIVE-ONLY TOO"). RunAsync/GetSeriesAsync skip NiftyDataCollector's
    /// database entirely for these and always call Dhan directly, for spot AND options, regardless
    /// of AppEnvironment.IsLocal or freshness - exactly like GetFuturesAsync already does for every
    /// underlying.</summary>
    private static readonly HashSet<string> AlwaysLiveUnderlyings = new(StringComparer.OrdinalIgnoreCase) { "SENSEX" };

    /// <summary>How far behind "now" today's own stored data is allowed to trail before a live Dhan
    /// call is worth making for it - short enough that a genuinely stale series (an hourly poll that
    /// simply hasn't run yet) gets topped up, long enough that this doesn't fire on the ordinary few
    /// seconds of lag between a fresh collector write and this request landing.</summary>
    private static readonly TimeSpan LiveFreshnessWindow = TimeSpan.FromMinutes(10);

    private readonly StoredSpotDataService _storedSpot;
    private readonly StoredRollingOptionDataService _storedRollingOption;
    private readonly DhanSpotInstrumentMaster _instrumentMaster;
    private readonly DhanFuturesInstrumentMaster _futuresInstrumentMaster;
    private readonly DhanHistoricalDataService _historicalData;
    private readonly DhanRollingOptionDataService _rollingOption;
    private readonly bool _allowLiveDataFallback;

    public OiReplayService(
        StoredSpotDataService storedSpot, StoredRollingOptionDataService storedRollingOption,
        DhanSpotInstrumentMaster instrumentMaster, DhanFuturesInstrumentMaster futuresInstrumentMaster,
        DhanHistoricalDataService historicalData, DhanRollingOptionDataService rollingOption,
        AppEnvironment appEnvironment)
    {
        _storedSpot = storedSpot;
        _storedRollingOption = storedRollingOption;
        _instrumentMaster = instrumentMaster;
        _futuresInstrumentMaster = futuresInstrumentMaster;
        _historicalData = historicalData;
        _rollingOption = rollingOption;
        _allowLiveDataFallback = !appEnvironment.IsLocal;
    }

    public async Task<OiReplayResult> RunAsync(
        string underlying, DateOnly date, int timeframeMinutes, string expiryFlag, CancellationToken cancellationToken, bool forceLive = false)
    {
        var timeframe = Math.Max(1, timeframeMinutes);
        // forceLive folds into the SAME isAlwaysLive treatment SENSEX already gets (skip stored
        // entirely, always call Dhan, ignore AppEnvironment.IsLocal) - used by the Live OI Dashboard
        // page, which (unlike OI Replay reviewing a past day, where stored-first is the right
        // default) has no scenario where preferring possibly-stale stored data over a live call ever
        // makes sense: it only ever asks for today, and its whole point is to never lag behind "now"
        // the way OI Replay's own local-dev "stored only, no live top-up" rule otherwise would.
        var isAlwaysLive = forceLive || AlwaysLiveUnderlyings.Contains(underlying);

        if (!isAlwaysLive && !_storedSpot.IsConfigured && !_allowLiveDataFallback)
            return OiReplayResult.Failed(underlying, date, timeframe,
                "Stored data is not configured on this server (no NiftyDataCollector database connection) - see ConnectionStrings:NiftyDataCollectorTimescale.");

        if (!StrikeStepByUnderlying.TryGetValue(underlying, out var step))
            return OiReplayResult.Failed(underlying, date, timeframe, $"'{underlying}' is not supported - only NIFTY, BANKNIFTY, and SENSEX.");

        if (string.Equals(underlying, "BANKNIFTY", StringComparison.OrdinalIgnoreCase) && string.Equals(expiryFlag, "WEEK", StringComparison.OrdinalIgnoreCase))
            return OiReplayResult.Failed(underlying, date, timeframe, "BANKNIFTY has no weekly expiry - NSE discontinued it. Use Monthly instead.");

        // Resolved once, eagerly, up front - not lazily via a memoizing closure the way this used to
        // work. A lazy "resolve on first use, cache the result" closure is fine for a purely
        // sequential caller, but the strike-band loop below now fires its (up to) 42 fetches
        // concurrently (see MaxConcurrentStrikeFetches), and multiple concurrent callers could all
        // observe "not yet resolved" before any one of them finishes resolving it - a real race, not
        // just a redundant-work inefficiency. Resolving once here, before any concurrent work starts,
        // sidesteps that entirely. EnsureLoadedAsync/FindSpot are a cached in-memory dictionary
        // lookup once the scrip master has loaded, not a network call, so paying for this even on a
        // request that ends up needing no live call at all (a fully-fresh stored day, local dev) is a
        // non-issue - and in the one environment this actually matters for (a deployed instance with
        // no stored database at all), isAlwaysLive/_allowLiveDataFallback is unconditionally true
        // anyway, so this was always going to be resolved regardless.
        DhanSpotInstrument? instrument = null;
        if (isAlwaysLive || _allowLiveDataFallback)
        {
            await _instrumentMaster.EnsureLoadedAsync(cancellationToken);
            instrument = _instrumentMaster.FindSpot(underlying);
        }
        Task<DhanSpotInstrument?> ResolveInstrumentAsync() => Task.FromResult(instrument);

        var spotBarsRaw = !isAlwaysLive && _storedSpot.IsConfigured
            ? (await _storedSpot.GetSpotCandlesAsync(underlying, date, date, cancellationToken)).Bars
            : Array.Empty<CandleWithVolume>();
        var spotError = (string?)null;

        if (isAlwaysLive || (_allowLiveDataFallback && !IsFreshEnough(date, spotBarsRaw.Count > 0 ? spotBarsRaw[^1].Time : null)))
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
        //
        // Fetched concurrently now (bounded by MaxConcurrentStrikeFetches - see its own doc comment),
        // not one strike/side at a time - the 21-strike band x CE/PE is 42 GetSeriesAsync calls, and
        // on a deployment with no stored database every one of them is a live Dhan round trip with
        // zero overlap under the old sequential loop. Each fetch returns its own point list rather
        // than mutating a shared cePoints/pePoints list directly - List<T> is not safe for concurrent
        // writers, and collecting via Task.WhenAll's own results sidesteps needing a lock entirely.
        using var throttle = new SemaphoreSlim(MaxConcurrentStrikeFetches);

        async Task<List<OiReplayPoint>> FetchPointsAsync(string strikeToken, string drvOptionType)
        {
            await throttle.WaitAsync(cancellationToken);
            try
            {
                var bars = await GetSeriesAsync(underlying, expiryFlag, strikeToken, drvOptionType, date, ResolveInstrumentAsync, cancellationToken, forceLive);
                var points = new List<OiReplayPoint>(bars.Count);
                foreach (var bar in bars)
                    if (bar.Strike is { } strike)
                        points.Add(new OiReplayPoint(bar.Bar.Time, strike, bar.OpenInterest, bar.ImpliedVolatility, bar.Bar.Close, bar.Bar.Open, bar.Bar.High, bar.Bar.Low));
                return points;
            }
            finally
            {
                throttle.Release();
            }
        }

        var ceTasks = new List<Task<List<OiReplayPoint>>>();
        var peTasks = new List<Task<List<OiReplayPoint>>>();
        for (var steps = -StrikeBandSteps; steps <= StrikeBandSteps; steps++)
        {
            var token = ExpiredOptionBacktestService.StrikeToken(steps);
            ceTasks.Add(FetchPointsAsync(token, "CALL"));
            peTasks.Add(FetchPointsAsync(token, "PUT"));
        }
        await Task.WhenAll(ceTasks.Concat(peTasks));

        var cePoints = ceTasks.SelectMany(t => t.Result).ToList();
        var pePoints = peTasks.SelectMany(t => t.Result).ToList();

        var spotCandlesTf = BacktestUtil.AggregateCandles(spotBars1m, timeframe);

        var (futuresBars, futuresExpiry, futuresOiAvailable, futuresError) = await GetFuturesAsync(underlying, date, cancellationToken);

        return new OiReplayResult(true, null, underlying, date, timeframe, step, expiryFlag, NearestExpiryCode,
            spotCandlesTf, spotBars1m, cePoints, pePoints, futuresBars, futuresExpiry, futuresOiAvailable, futuresError);
    }

    /// <summary>The day's futures contract, OHLC + (best-effort) OI - ALWAYS a live Dhan call, per
    /// the user's own explicit "i do not have futures data in db so it will be dhan call always"
    /// request. Unlike the spot/option paths above, there is no stored source to prefer and no
    /// AppEnvironment.IsLocal gate - futures simply has nowhere else to come from, in every
    /// environment including local development.</summary>
    private async Task<(IReadOnlyList<FuturesBar> Bars, DateOnly? Expiry, bool OiAvailable, string? Error)> GetFuturesAsync(
        string underlying, DateOnly date, CancellationToken cancellationToken)
    {
        try
        {
            await _futuresInstrumentMaster.EnsureLoadedAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return (Array.Empty<FuturesBar>(), null, false, $"Could not load the futures instrument master: {ex.Message}");
        }

        var contract = _futuresInstrumentMaster.GetNearestContract(underlying, date);
        if (contract is null)
            return (Array.Empty<FuturesBar>(), null, false, $"No currently-listed futures contract found for {underlying} - the instrument master may still be loading.");

        var (bars, oiFieldPresent, error) = await _historicalData.GetIntradayFuturesCandlesAsync(
            contract.SecurityId, contract.DhanSegment, date, date, 1, cancellationToken);

        if (error is not null)
            return (Array.Empty<FuturesBar>(), contract.Expiry, false, error);

        if (bars.Count == 0)
            return (Array.Empty<FuturesBar>(), contract.Expiry,
                false, $"No futures data for {date:dd MMM yyyy} - the {contract.Expiry:dd MMM yyyy} contract Dhan currently lists likely did not exist yet on this date (an older contract that has since expired is no longer resolvable at all).");

        var futuresBars = bars.Select(b => new FuturesBar(b.Bar.Time, b.Bar.Open, b.Bar.High, b.Bar.Low, b.Bar.Close, b.Bar.Volume, b.OpenInterest)).ToList();
        return (futuresBars, contract.Expiry, oiFieldPresent, null);
    }

    /// <summary>One CE or PE series for one relative strike: stored first (when configured), then a
    /// live Dhan call over it ONLY when live fallback is allowed and the stored result isn't fresh
    /// enough (see IsFreshEnough) - the exact same "prefer stored, fall through when it's not good
    /// enough" shape as ExpiredOptionBacktestService's own useStoredData handling, just decided per
    /// series here instead of once per whole request, since different strikes' own stored rows can
    /// in principle lag by different amounts. Skips straight to the live call, unconditionally, for
    /// an AlwaysLiveUnderlyings member (SENSEX) - there is no stored series to prefer for those at
    /// all.</summary>
    private async Task<IReadOnlyList<(CandleWithVolume Bar, decimal? Strike, decimal? Spot, long? OpenInterest, decimal? ImpliedVolatility)>> GetSeriesAsync(
        string underlying, string expiryFlag, string strikeToken, string drvOptionType, DateOnly date,
        Func<Task<DhanSpotInstrument?>> resolveInstrument, CancellationToken cancellationToken, bool forceLive = false)
    {
        var isAlwaysLive = forceLive || AlwaysLiveUnderlyings.Contains(underlying);

        var storedBars = !isAlwaysLive && _storedRollingOption.IsConfigured
            ? (await _storedRollingOption.GetRollingOptionCandlesAsync(underlying, 0, expiryFlag, NearestExpiryCode, strikeToken, drvOptionType, date, date, 1, cancellationToken)).Bars
            : Array.Empty<(CandleWithVolume, decimal?, decimal?, long?, decimal?)>();

        if (!isAlwaysLive && !_allowLiveDataFallback) return storedBars;

        var latest = storedBars.Count > 0 ? storedBars[^1].Item1.Time : (DateTimeOffset?)null;
        if (!isAlwaysLive && IsFreshEnough(date, latest)) return storedBars;

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

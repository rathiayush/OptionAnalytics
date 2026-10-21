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
    /// <summary>How many more times a strike series that came back empty is asked for, and the pause before each round.</summary>
    private const int MissingSeriesRetryRounds = 2;
    /// <summary>How long a day's load waits for its futures (started with the options) before showing the day without them.</summary>
    internal static readonly TimeSpan FuturesBudget = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan MissingSeriesRetryDelay = TimeSpan.FromSeconds(2);

    /// <summary>The only expiry cycle this page ever reads - see this class's own doc comment.</summary>
    private const int NearestExpiryCode = 1;

    /// <summary>How many strike/side fetches (out of the 42 the ATM+-10 band needs - 21 strikes x
    /// CE/PE) may be IN FLIGHT at once, when they end up needing a live Dhan call. This used to be
    /// a plain sequential loop - correct, but on a deployed environment with no stored database
    /// configured (see ConnectionStrings:NiftyDataCollectorTimescale, deliberately blank there -
    /// this class's own top-of-file doc comment), EVERY one of the 42 calls falls through to Dhan,
    /// one at a time, so the page's own load time was 42x a single call's network round trip with
    /// zero overlap - the dominant, previously-unaddressed cause of "OI Replay takes forever to
    /// load" on a real deployment.
    ///
    /// The ACTUAL per-second ceiling Dhan documents (5 Data-API requests/second, account-wide) is
    /// now enforced correctly and app-wide by DhanDataApiRateLimiter, which every one of these
    /// fetches' underlying DhanRollingOptionDataService/DhanHistoricalDataService calls goes
    /// through - a real requests-per-second limiter, not this semaphore (a semaphore only bounds
    /// how many requests are simultaneously IN FLIGHT, which does not bound the RATE new ones start
    /// at once responses come back quickly - a materially different, weaker guarantee that a plain
    /// SemaphoreSlim here used to be the only protection against, before that limiter existed).
    /// This constant's own job now is just capping how many tasks pile up waiting on that shared
    /// limiter at once (bounding this one request's own memory/task overhead) - correctness against
    /// Dhan's real limit no longer depends on this number at all, so it is set generously rather
    /// than conservatively.</summary>
    private const int MaxConcurrentStrikeFetches = 10;

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
    private readonly NseFuturesContractArchive? _futuresArchive;
    private readonly NseChartHistory? _nseChart;
    private readonly DhanHistoricalDataService _historicalData;
    private readonly DhanRollingOptionDataService _rollingOption;
    private readonly bool _allowLiveDataFallback;

    // Today's answers from Dhan, shared by every request (see TodayFetchShare): a minute - or, with the live
    // feed's own bars to carry on from (LiveOptionLegStore), the rest of the day: today's option series and
    // futures are backfilled from Dhan ONCE per series per day, then served from the backfill plus the feed's
    // minute bars since (MergeTodayLive). Spot comes from the spot feed's own day of bars (SpotFeedHostedService).
    private readonly TodayFetchShare _today = new();
    private readonly LiveOptionLegStore? _liveBars;
    private readonly SpotFeedHostedService? _spotFeed;
    private TimeSpan TodayWindow => _liveBars is null ? TodayFetchShare.DefaultWindow : TimeSpan.MaxValue;
    private Task<T> ReuseTodayAsync<T>(string key, DateOnly date, Func<CancellationToken, Task<T>> fetch, Func<T, bool> keep, CancellationToken cancellationToken) =>
        _today.ReuseAsync(key, date, IstClock.Today(), fetch, keep, cancellationToken);

    /// <summary>Forgets today's held backfill of `underlying` - its next run asks Dhan afresh (the page's Clear
    /// cache).</summary>
    public void RefreshToday(string underlying) => _today.Invalidate($"{underlying.ToUpperInvariant()}|");

    /// <summary>Today's spot bars from the spot feed's memory when it holds the whole day so far (from the open to a
    /// few minutes ago) - null otherwise (then Dhan is asked).</summary>
    private IReadOnlyList<CandleWithVolume>? TodaySpotFromFeed(string underlying, DateOnly date)
    {
        if (_spotFeed is null || date != IstClock.Today() || !_spotFeed.States.TryGetValue(underlying.ToUpperInvariant(), out var state)) return null;
        var bars = state.GetVolumeBars().Where(b => DateOnly.FromDateTime(b.Time.ToOffset(IstClock.Offset).DateTime) == date).OrderBy(b => b.Time).ToList();
        if (bars.Count == 0) return null;
        var open = new DateTimeOffset(date.ToDateTime(new TimeOnly(9, 16)), IstClock.Offset);
        var close = new DateTimeOffset(date.ToDateTime(new TimeOnly(15, 29)), IstClock.Offset);
        var recent = DateTimeOffset.UtcNow.AddMinutes(-3) < close ? DateTimeOffset.UtcNow.AddMinutes(-3) : close;
        return bars[0].Time <= open && bars[^1].Time >= recent ? bars : null;
    }

    public OiReplayService(
        StoredSpotDataService storedSpot, StoredRollingOptionDataService storedRollingOption,
        DhanSpotInstrumentMaster instrumentMaster, DhanFuturesInstrumentMaster futuresInstrumentMaster,
        DhanHistoricalDataService historicalData, DhanRollingOptionDataService rollingOption,
        AppEnvironment appEnvironment, NseFuturesContractArchive? futuresArchive = null, NseChartHistory? nseChart = null,
        LiveOptionLegStore? liveBars = null, SpotFeedHostedService? spotFeed = null)
    {
        _liveBars = liveBars;
        _spotFeed = spotFeed;
        _futuresArchive = futuresArchive;
        _nseChart = nseChart;
        _storedSpot = storedSpot;
        _storedRollingOption = storedRollingOption;
        _instrumentMaster = instrumentMaster;
        _futuresInstrumentMaster = futuresInstrumentMaster;
        _historicalData = historicalData;
        _rollingOption = rollingOption;
        _allowLiveDataFallback = !appEnvironment.IsLocal;
    }

    /// <param name="forceFetch">Skip the saved days (the Dhan day cache and the stored database) and ask Dhan for everything afresh -
    /// each day that comes back is written over what was kept, so the cache is updated too.</param>
    public async Task<OiReplayResult> RunAsync(
        string underlying, DateOnly date, int timeframeMinutes, string expiryFlag, CancellationToken cancellationToken, bool forceLive = false, bool forceFetch = false)
    {
        using var force = forceFetch ? DhanDataCache.ForceRefreshScope() : null;
        forceLive |= forceFetch; // no stored database either: straight from Dhan, like today's seed
        var timeframe = Math.Max(1, timeframeMinutes);
        // forceLive folds into the SAME isAlwaysLive treatment SENSEX already gets (skip stored
        // entirely, always call Dhan, ignore AppEnvironment.IsLocal) - set by OiReplayPage's own
        // frontend whenever the requested date is TODAY (its "Go Live" mode), which unlike reviewing
        // a genuinely past day (where stored-first is the right default) has no scenario where
        // preferring possibly-stale OR entirely-not-yet-backfilled stored data over a live call ever
        // makes sense: it's about to hand off to the live tick feed anyway, so the seed itself should
        // always be the freshest reading available rather than first checking a database that may
        // simply not have caught up to today yet.
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

        // The futures are asked for at the same time as the spot and the 42 option series, not after them: a past day's contract can
        // go Dhan -> NSE's archive (30 s) -> NSE's chart (20 s), and a slow NSE used to sit on top of the whole load. Past
        // FuturesBudget the page is shown without them, saying why.
        LoadProgress.Stage("spot, futures and the option series");
        LoadProgress.AddTotal(2 + 2 * (2 * StrikeBandSteps + 1));
        LoadProgress.Info($"Loading {underlying} {date:dd MMM yyyy} ({expiryFlag}): spot, futures and {2 * (2 * StrikeBandSteps + 1)} option series (ATM±{StrikeBandSteps}, CE and PE).");
        var futuresClock = System.Diagnostics.Stopwatch.StartNew();
        var futuresTask = _today.ReuseWithTimeAsync($"{underlying}|fut", date, IstClock.Today(),
            ct => GetFuturesAsync(underlying, date, ct), r => r.Item1.Count > 0, cancellationToken, TodayWindow);
        _ = futuresTask.ContinueWith(t => _ = t.Exception, TaskContinuationOptions.OnlyOnFaulted);

        var fromFeed = isAlwaysLive ? TodaySpotFromFeed(underlying, date) : null;
        var (spotBarsRaw, spotError) = fromFeed is not null ? (fromFeed, null) : await FetchSpotBarsWithVolumeAsync(underlying, date, isAlwaysLive, ResolveInstrumentAsync, cancellationToken);

        LoadProgress.Done(failed: spotBarsRaw.Count == 0);
        if (fromFeed is not null) LoadProgress.Ok($"Spot: {spotBarsRaw.Count} bars from the live feed's memory (no Dhan call).");
        else if (spotBarsRaw.Count > 0) LoadProgress.Ok($"Spot: {spotBarsRaw.Count} bars.");
        else LoadProgress.Error($"Spot: nothing - {spotError ?? "no data"}");
        if (spotBarsRaw.Count == 0)
            return OiReplayResult.Failed(underlying, date, timeframe,
                spotError ?? $"No stored spot data for {underlying} on {date:dd MMM yyyy} - has NiftyDataCollector backfilled this date yet?");

        var spotBars1m = spotBarsRaw.Select(b => b.ToCandle()).ToList();

        // Every strike NiftyDataCollector might plausibly have backfilled (ATM+-StrikeBandSteps at
        // the time it collected, per underlying) - a strike this page asks for that the collector
        // never tracked just comes back with zero rows, contributing no points, not an error; the
        // frontend's own ladder simply has nothing to show at that level.
        //
        // Fetched concurrently now (in-flight count bounded by MaxConcurrentStrikeFetches, actual
        // Dhan call RATE bounded separately and correctly by the shared DhanDataApiRateLimiter each
        // fetch's own DhanRollingOptionDataService/DhanHistoricalDataService call goes through -
        // see MaxConcurrentStrikeFetches' own doc comment), not one strike/side at a time - the
        // 21-strike band x CE/PE is 42 GetSeriesAsync calls, and on a deployment with no stored
        // database every one of them is a live Dhan round trip with zero overlap under the old
        // sequential loop. Each fetch returns its own point list rather than mutating a shared
        // cePoints/pePoints list directly - List<T> is not safe for concurrent writers, and
        // collecting via Task.WhenAll's own results sidesteps needing a lock entirely.
        using var throttle = new SemaphoreSlim(MaxConcurrentStrikeFetches);
        var backfilledAt = new System.Collections.Concurrent.ConcurrentBag<DateTimeOffset>();

        async Task<List<OiReplayPoint>> FetchPointsAsync(string strikeToken, string drvOptionType)
        {
            await throttle.WaitAsync(cancellationToken);
            try
            {
                var bars = await GetSeriesAsync(underlying, expiryFlag, strikeToken, drvOptionType, date, ResolveInstrumentAsync, cancellationToken, forceLive, backfilledAt.Add);
                var points = new List<OiReplayPoint>(bars.Count);
                foreach (var bar in bars)
                    if (bar.Strike is { } strike)
                        points.Add(new OiReplayPoint(bar.Bar.Time, strike, bar.OpenInterest, bar.ImpliedVolatility, bar.Bar.Close, bar.Bar.Open, bar.Bar.High, bar.Bar.Low, bar.Bar.Volume));
                var label = $"{(drvOptionType == "CALL" ? "CE" : "PE")} {strikeToken}";
                if (points.Count > 0) LoadProgress.Ok($"{label}: {points.Count} minutes");
                else LoadProgress.Error($"{label}: nothing came back");
                return points;
            }
            finally
            {
                throttle.Release();
            }
        }

        async Task<List<OiReplayPoint>> CountedAsync(string strikeToken, string drvOptionType)
        {
            var points = await FetchPointsAsync(strikeToken, drvOptionType);
            LoadProgress.Done(failed: points.Count == 0);
            return points;
        }

        var ceTasks = new List<Task<List<OiReplayPoint>>>();
        var peTasks = new List<Task<List<OiReplayPoint>>>();
        for (var steps = -StrikeBandSteps; steps <= StrikeBandSteps; steps++)
        {
            var token = ExpiredOptionBacktestService.StrikeToken(steps);
            ceTasks.Add(CountedAsync(token, "CALL"));
            peTasks.Add(CountedAsync(token, "PUT"));
        }
        await Task.WhenAll(ceTasks.Concat(peTasks));

        // A strike series that came back empty (a Dhan error - usually its rate limit - after its own retries) is asked
        // again, one at a time after a pause, rather than leaving that strike blank for the whole day.
        var ceResults = ceTasks.Select(t => t.Result).ToList();
        var peResults = peTasks.Select(t => t.Result).ToList();
        for (var round = 0; round < MissingSeriesRetryRounds; round++)
        {
            var missing = Enumerable.Range(0, ceResults.Count).Where(i => ceResults[i].Count == 0).Select(i => (i, Ce: true))
                .Concat(Enumerable.Range(0, peResults.Count).Where(i => peResults[i].Count == 0).Select(i => (i, Ce: false))).ToList();
            if (missing.Count == 0) break;
            LoadProgress.Stage($"asking again for {missing.Count} empty series (round {round + 1} of {MissingSeriesRetryRounds})");
            LoadProgress.Warn($"{missing.Count} series came back empty - asking again, one at a time (round {round + 1} of {MissingSeriesRetryRounds}).");
            await Task.Delay(MissingSeriesRetryDelay, cancellationToken);
            foreach (var (i, ce) in missing)
            {
                var token = ExpiredOptionBacktestService.StrikeToken(i - StrikeBandSteps);
                LoadProgress.Retry();
                var points = await FetchPointsAsync(token, ce ? "CALL" : "PUT");
                if (points.Count > 0) LoadProgress.Recovered();
                if (ce) ceResults[i] = points; else peResults[i] = points;
            }
        }

        var cePoints = ceResults.SelectMany(p => p).ToList();
        var pePoints = peResults.SelectMany(p => p).ToList();
        // Today, live: the backfill up to when it was taken, the live feed's minute bars from then on.
        if (_liveBars is not null && date == IstClock.Today() && !backfilledAt.IsEmpty)
        {
            var from = backfilledAt.Min();
            cePoints = MergeTodayLive(cePoints, _liveBars.OptionPointsFrom(underlying, expiryFlag, "CE", from), from);
            pePoints = MergeTodayLive(pePoints, _liveBars.OptionPointsFrom(underlying, expiryFlag, "PE", from), from);
        }

        // Every minute shows every strike in the band: a minute a strike has no reading for (an untraded minute, a gap in
        // Dhan's answer) holds its last value - only ever an EARLIER reading, so nothing is seen before it happened.
        // Today's running minute is left to the live feed.
        var fillMinutes = spotBars1m.Select(b => (b.Time, b.Close)).ToList();
        if (date == IstClock.Today() && fillMinutes.Count > 0) fillMinutes.RemoveAt(fillMinutes.Count - 1);
        cePoints = CarryForward(cePoints, fillMinutes, step, StrikeBandSteps);
        pePoints = CarryForward(pePoints, fillMinutes, step, StrikeBandSteps);

        var spotCandlesTf = BacktestUtil.AggregateCandles(spotBars1m, timeframe);

        LoadProgress.Stage("futures");
        var futuresLeft = FuturesBudget - futuresClock.Elapsed;
        var futuresDone = futuresTask.IsCompleted || (futuresLeft > TimeSpan.Zero && await Task.WhenAny(futuresTask, Task.Delay(futuresLeft, cancellationToken)) == futuresTask);
        var ((futuresBars, futuresExpiry, futuresOiAvailable, futuresError), futuresAt) = futuresDone
            ? await futuresTask
            : ((Array.Empty<FuturesBar>(), (DateOnly?)null, false,
                $"The futures for {date:dd MMM yyyy} were not ready within {FuturesBudget.TotalSeconds:0} s (an expired contract's day comes from NSE when Dhan has none, and NSE did not answer) - the page is shown without them."),
               DateTimeOffset.UtcNow);
        LoadProgress.Done(failed: futuresBars.Count == 0);
        if (futuresBars.Count > 0) LoadProgress.Ok($"Futures: {futuresBars.Count} bars ({futuresClock.Elapsed.TotalSeconds:0.0} s).");
        else LoadProgress.Warn($"Futures: none - {futuresError ?? "no data"}");
        if (_liveBars is not null && date == IstClock.Today() && futuresBars.Count > 0)
        {
            var cutoff = futuresAt.ToUnixTimeSeconds() / 60 * 60;
            var live = _liveBars.FuturesBarsFrom(underlying, futuresAt);
            if (live.Count > 0) futuresBars = futuresBars.Where(b => b.Time.ToUnixTimeSeconds() < cutoff).Concat(live).ToList();
        }

        return new OiReplayResult(true, null, underlying, date, timeframe, step, expiryFlag, NearestExpiryCode,
            spotCandlesTf, spotBars1m, cePoints, pePoints, futuresBars, futuresExpiry, futuresOiAvailable, futuresError)
        {
            SpotVwap = VwapCalculator.ComputeSeries(spotBarsRaw),
        };
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

        // A past date's real front-month contract - expired or not - from NSE's contract archive (Dhan's
        // scrip master lists live contracts only, which made an older day show the wrong, later contract
        // or nothing at all). Falls back to the nearest listed contract.
        DhanFuturesInstrument? contract = null;
        if (date < IstClock.Today() && _futuresArchive is not null && NseFuturesContractArchive.Covers(underlying))
        {
            try { contract = await _futuresArchive.ContractOnAsync(underlying, date, null, cancellationToken); }
            catch (Exception e) when (e is not OperationCanceledException) { contract = null; }
        }
        contract ??= _futuresInstrumentMaster.GetNearestContract(underlying, date);
        if (contract is null)
            return (Array.Empty<FuturesBar>(), null, false, $"No currently-listed futures contract found for {underlying} - the instrument master may still be loading.");

        // An expired contract has no intraday history at Dhan - fall back to another contract listed that day.
        IReadOnlyList<DhanFuturesInstrument> listed = Array.Empty<DhanFuturesInstrument>();
        if (contract.Expiry < IstClock.Today() && _futuresArchive is not null && NseFuturesContractArchive.Covers(underlying))
        {
            try { listed = await _futuresArchive.ContractsOnAsync(underlying, date, cancellationToken); }
            catch (Exception e) when (e is not OperationCanceledException) { listed = Array.Empty<DhanFuturesInstrument>(); }
        }
        var fetched = await PastFuturesCandles.FetchAsync(_historicalData, contract, listed, date, cancellationToken, _nseChart);
        var (bars, oiFieldPresent, error) = (fetched.Bars, fetched.OiFieldPresent, fetched.Error);
        contract = fetched.Contract;

        if (error is not null)
            return (Array.Empty<FuturesBar>(), contract.Expiry, false, fetched.Note is null ? error : $"No futures data for {date:dd MMM yyyy} - {fetched.Note}");

        if (bars.Count == 0)
            return (Array.Empty<FuturesBar>(), contract.Expiry,
                false, contract.Expiry < IstClock.Today()
                    ? $"No futures data for {date:dd MMM yyyy} (a holiday?) - {contract.TradingSymbol} (id {contract.SecurityId}) has expired. {fetched.Note}"
                    : $"No futures data for {date:dd MMM yyyy} - the {contract.Expiry:dd MMM yyyy} contract was not trading on this date.");

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
        Func<Task<DhanSpotInstrument?>> resolveInstrument, CancellationToken cancellationToken, bool forceLive = false, Action<DateTimeOffset>? backfilledAt = null)
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

        var ((liveBars, _), fetchedAt) = await _today.ReuseWithTimeAsync($"{underlying}|opt|{expiryFlag}|{strikeToken}|{drvOptionType}", date, IstClock.Today(),
            ct => _rollingOption.GetRollingOptionCandlesAsync(underlying, instrument.SecurityId, expiryFlag, NearestExpiryCode, strikeToken, drvOptionType, date, date, 1, ct),
            r => r.Bars.Count > 0, cancellationToken, TodayWindow);
        if (liveBars.Count > 0) backfilledAt?.Invoke(fetchedAt);
        return liveBars.Count > 0 ? liveBars : storedBars;
    }

    /// <summary>`points` with a point at every spot minute for every strike within `bandSteps` strikes of that minute's
    /// ATM that has had a reading earlier in the day but none in that minute: its last reading carried forward (same
    /// OI, IV and premium, no volume). Strikes never seen yet, and strikes outside the band, get nothing.</summary>
    internal static List<OiReplayPoint> CarryForward(IReadOnlyList<OiReplayPoint> points, IReadOnlyList<(DateTimeOffset Time, decimal Close)> spotMinutes, decimal step, int bandSteps)
    {
        if (points.Count == 0 || spotMinutes.Count == 0 || step <= 0) return points.ToList();
        static long MinuteOf(DateTimeOffset t) => t.ToUnixTimeSeconds() / 60;
        var readings = points.OrderBy(p => p.Time).ToList();
        var next = 0;
        var last = new Dictionary<decimal, OiReplayPoint>();
        var result = new List<OiReplayPoint>(points);
        long? previousMinute = null;
        foreach (var (time, close) in spotMinutes.OrderBy(m => m.Time))
        {
            var minute = MinuteOf(time);
            if (minute == previousMinute) continue;
            previousMinute = minute;
            // Readings up to and including this minute first (one that came in between two spot minutes counts too).
            while (next < readings.Count && MinuteOf(readings[next].Time) <= minute) { last[readings[next].Strike] = readings[next]; next++; }
            var atm = Math.Round(close / step, MidpointRounding.AwayFromZero) * step;
            for (var k = -bandSteps; k <= bandSteps; k++)
            {
                var strike = atm + k * step;
                if (!last.TryGetValue(strike, out var prev) || MinuteOf(prev.Time) == minute) continue;
                var carried = new OiReplayPoint(DateTimeOffset.FromUnixTimeSeconds(minute * 60).ToOffset(time.Offset), strike, prev.OpenInterest,
                    prev.ImpliedVolatility, prev.Price, prev.Price, prev.Price, prev.Price, 0);
                result.Add(carried);
                last[strike] = carried;
            }
        }
        return result.OrderBy(p => p.Time).ThenBy(p => p.Strike).ToList();
    }

    /// <summary>Today's points: the backfill's before the minute it was taken (`from`), the live feed's minute bars
    /// from that minute on (whole minutes the feed saw - the backfill's last one was still forming), by time.</summary>
    internal static List<OiReplayPoint> MergeTodayLive(IReadOnlyList<OiReplayPoint> backfill, IReadOnlyList<OiReplayPoint> live, DateTimeOffset from)
    {
        if (live.Count == 0) return backfill.ToList();
        var cutoff = from.ToUnixTimeSeconds() / 60 * 60;
        return backfill.Where(p => p.Time.ToUnixTimeSeconds() < cutoff).Concat(live).OrderBy(p => p.Time).ThenBy(p => p.Strike).ToList();
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

    /// <summary>The exact stored-then-live-fallback shape RunAsync's own spot fetch always used
    /// (extracted verbatim, not reimplemented) - stored first when configured and not an
    /// AlwaysLiveUnderlyings member, then a live Dhan call over it when isAlwaysLive OR the stored
    /// result isn't fresh enough (see IsFreshEnough). Reused by GetPreviousDayVolumeProfileAsync
    /// below so "how spot bars for a date get fetched" has exactly one implementation, not two
    /// silently drifting copies.</summary>
    private async Task<(IReadOnlyList<CandleWithVolume> Bars, string? Error)> FetchSpotBarsWithVolumeAsync(
        string underlying, DateOnly date, bool isAlwaysLive, Func<Task<DhanSpotInstrument?>> resolveInstrument, CancellationToken cancellationToken)
    {
        var spotBarsRaw = !isAlwaysLive && _storedSpot.IsConfigured
            ? (await _storedSpot.GetSpotCandlesAsync(underlying, date, date, cancellationToken)).Bars
            : Array.Empty<CandleWithVolume>();
        var spotError = (string?)null;

        if (isAlwaysLive || (_allowLiveDataFallback && !IsFreshEnough(date, spotBarsRaw.Count > 0 ? spotBarsRaw[^1].Time : null)))
        {
            var liveInstrument = await resolveInstrument();
            if (liveInstrument is not null)
            {
                var (liveSpotBars, liveSpotError) = await ReuseTodayAsync($"{underlying}|spot", date,
                    ct => _historicalData.GetIntradayCandlesAsync(liveInstrument.SecurityId, liveInstrument.DhanSegment, date, date, 1, ct),
                    r => r.Candles.Count > 0, cancellationToken);
                // Only trust the live call over whatever's already stored if it actually found
                // something - a live error (auth, market holiday) should never blank out a
                // perfectly good, merely slightly-stale stored result.
                if (liveSpotBars.Count > 0) spotBarsRaw = liveSpotBars;
                else spotError = liveSpotError;
            }
        }
        return (spotBarsRaw, spotError);
    }

    /// <summary>How many equal-width price bins the previous day's own [low, high] range is divided
    /// into before summing volume into each - a day-RELATIVE bin size, not a fixed point value, so
    /// this scales correctly whether the day's own range was 50 points or 500 and needs no
    /// per-underlying tuning. 60 gives a reasonably fine-grained distribution without being so
    /// granular that a single stray tick's bar creates its own noisy little peak.</summary>
    private const int VolumeProfileBinCount = 60;

    /// <summary>The standard value-area convention - the price band that captured 70% of the day's
    /// own traded volume, expanding outward from POC.</summary>
    private const decimal ValueAreaShare = 0.70m;

    /// <summary>Walks backward from the day before `onOrBeforeDate` (today's own live view, or
    /// whatever historical day the replay is currently on) to find the nearest PRIOR trading day with
    /// real spot volume, then computes its volume profile - POC/VAH/VAL/HVN/LVN, the reference levels
    /// a trader marks up before the session from yesterday's own traded activity. Skips weekends
    /// outright and, for anything else, simply moves one more day back whenever a candidate day comes
    /// back with no data at all (most commonly a market holiday) - up to a week back, comfortably
    /// covering any ordinary single holiday (or a holiday adjacent to a weekend) without needing a
    /// full NSE holiday calendar.</summary>
    public async Task<VolumeProfileResult> GetPreviousDayVolumeProfileAsync(string underlying, DateOnly onOrBeforeDate, CancellationToken cancellationToken)
    {
        if (!StrikeStepByUnderlying.ContainsKey(underlying))
            return VolumeProfileResult.Failed(underlying, $"'{underlying}' is not supported - only NIFTY, BANKNIFTY, and SENSEX.");

        var isAlwaysLive = AlwaysLiveUnderlyings.Contains(underlying);
        if (!isAlwaysLive && !_storedSpot.IsConfigured && !_allowLiveDataFallback)
            return VolumeProfileResult.Failed(underlying, "Stored data is not configured on this server (no NiftyDataCollector database connection) - see ConnectionStrings:NiftyDataCollectorTimescale.");

        DhanSpotInstrument? instrument = null;
        if (isAlwaysLive || _allowLiveDataFallback)
        {
            await _instrumentMaster.EnsureLoadedAsync(cancellationToken);
            instrument = _instrumentMaster.FindSpot(underlying);
        }
        Task<DhanSpotInstrument?> ResolveInstrumentAsync() => Task.FromResult(instrument);

        IReadOnlyList<CandleWithVolume> foundBars = Array.Empty<CandleWithVolume>();
        var resolvedDate = await ResolvePreviousTradingDayAsync(onOrBeforeDate, async candidate =>
        {
            var (bars, _) = await FetchSpotBarsWithVolumeAsync(underlying, candidate, isAlwaysLive, ResolveInstrumentAsync, cancellationToken);
            if (bars.Count == 0) return false;
            foundBars = bars;
            return true;
        });
        if (resolvedDate is null)
            return VolumeProfileResult.Failed(underlying, $"No previous trading day data found for {underlying} in the last week.");
        return ComputeVolumeProfile(underlying, resolvedDate.Value, foundBars);
    }

    /// <summary>The previous trading day's 1-minute bars of the futures contract the chart shows for `date` - `expiry` (the
    /// run's FuturesExpiry), else that day's front month - for OI Replay's futures chart, which draws the PREVIOUS
    /// session's volume profile in that same contract's prices (another month trades higher - cost of carry - so its
    /// levels would sit off the candles). Walks back like GetPreviousDayVolumeProfileAsync (weekends skipped, a day
    /// with no bars - a holiday - stepped over). A contract still live comes from Dhan (a past day kept on disk -
    /// DhanDataCache); an expired one as the chart's own day does (PastFuturesCandles - its Note says what was used).</summary>
    public async Task<PreviousDayFuturesResult> GetPreviousDayFuturesAsync(string underlying, DateOnly date, DateOnly? expiry, CancellationToken cancellationToken)
    {
        if (!StrikeStepByUnderlying.ContainsKey(underlying))
            return PreviousDayFuturesResult.Failed(underlying, $"'{underlying}' is not supported - only NIFTY, BANKNIFTY, and SENSEX.");
        try
        {
            await _futuresInstrumentMaster.EnsureLoadedAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return PreviousDayFuturesResult.Failed(underlying, $"Could not load the futures instrument master: {ex.Message}");
        }

        var archive = _futuresArchive is not null && NseFuturesContractArchive.Covers(underlying) ? _futuresArchive : null;
        var contract = expiry is { } wanted ? _futuresInstrumentMaster.GetContract(underlying, wanted) : null;
        if (contract is null && archive is not null)
        {
            try { contract = await archive.ContractOnAsync(underlying, date, expiry, cancellationToken); }
            catch (Exception e) when (e is not OperationCanceledException) { contract = null; }
        }
        if (contract is null && expiry is null) contract = _futuresInstrumentMaster.GetNearestContract(underlying, date);
        if (contract is null)
            return PreviousDayFuturesResult.Failed(underlying, $"No {underlying} futures contract{(expiry is { } x ? $" expiring {x:dd MMM yyyy}" : "")} found for {date:dd MMM yyyy}.");

        async Task<IReadOnlyList<DhanFuturesInstrument>> ListedOnAsync(DateOnly day)
        {
            if (archive is null) return Array.Empty<DhanFuturesInstrument>();
            try { return await archive.ContractsOnAsync(underlying, day, cancellationToken); }
            catch (Exception e) when (e is not OperationCanceledException) { return Array.Empty<DhanFuturesInstrument>(); }
        }

        var found = await PreviousDayFuturesBarsAsync(_historicalData, contract, date, ListedOnAsync, _nseChart, cancellationToken);
        if (found is not { } f)
            return PreviousDayFuturesResult.Failed(underlying, $"No {contract.TradingSymbol} bars on the trading days before {date:dd MMM yyyy}.");
        var bars = f.Fetched.Bars.Select(b => new FuturesBar(b.Bar.Time, b.Bar.Open, b.Bar.High, b.Bar.Low, b.Bar.Close, b.Bar.Volume, b.OpenInterest)).ToList();
        return new PreviousDayFuturesResult(true, null, underlying, f.Day, f.Fetched.Contract.Expiry, f.Fetched.Contract.TradingSymbol, bars, f.Fetched.Note);
    }

    /// <summary>The nearest trading day before `date` on which `contract` has 1-minute bars, and those bars
    /// (ResolvePreviousTradingDayAsync over PastFuturesCandles) - null when none of the last week has any.</summary>
    internal static async Task<(DateOnly Day, PastFuturesCandles.Result Fetched)?> PreviousDayFuturesBarsAsync(
        DhanHistoricalDataService historical, DhanFuturesInstrument contract, DateOnly date,
        Func<DateOnly, Task<IReadOnlyList<DhanFuturesInstrument>>> listedOnAsync, NseChartHistory? nse, CancellationToken cancellationToken)
    {
        PastFuturesCandles.Result? found = null;
        var day = await ResolvePreviousTradingDayAsync(date, async candidate =>
        {
            var listed = contract.Expiry < IstClock.Today() ? await listedOnAsync(candidate) : Array.Empty<DhanFuturesInstrument>();
            var fetched = await PastFuturesCandles.FetchAsync(historical, contract, listed, candidate, cancellationToken, nse);
            if (fetched.Bars.Count == 0) return false;
            found = fetched;
            return true;
        });
        return day is { } d && found is not null ? (d, found) : null;
    }

    /// <summary>How many calendar days back GetPreviousDayVolumeProfileAsync will walk before giving
    /// up - comfortably covers any ordinary single holiday (or one adjacent to a weekend) without
    /// needing a full NSE holiday calendar.</summary>
    private const int PreviousTradingDayMaxAttempts = 7;

    /// <summary>The actual date-walking logic, pulled out of GetPreviousDayVolumeProfileAsync as its
    /// own pure-shaped, independently testable piece (internal + InternalsVisibleTo, same reasoning
    /// as ComputeVolumeProfile's own doc comment) - the real question worth pinning down with a test
    /// is exactly this: does it correctly skip weekends, and does it correctly keep walking back one
    /// more day whenever a candidate reports no data (a market holiday) rather than giving up on the
    /// first miss, all while never trying more than PreviousTradingDayMaxAttempts real weekdays.
    /// hasDataAsync is the caller's own "does this specific date have anything" check - production
    /// code fetches for real; a test fakes specific dates as holidays with no network/DB at all.
    /// Starts at onOrBeforeDate - 1 (the day BEFORE whatever is currently loaded), returns the first
    /// date hasDataAsync confirms, or null once attempts are exhausted with nothing found.</summary>
    internal static async Task<DateOnly?> ResolvePreviousTradingDayAsync(DateOnly onOrBeforeDate, Func<DateOnly, Task<bool>> hasDataAsync)
    {
        var candidate = onOrBeforeDate.AddDays(-1);
        for (var attempts = 0; attempts < PreviousTradingDayMaxAttempts; attempts++, candidate = candidate.AddDays(-1))
        {
            if (candidate.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) continue;
            if (await hasDataAsync(candidate)) return candidate;
        }
        return null;
    }

    /// <summary>internal (not private), tested directly via InternalsVisibleTo - see
    /// AssemblyInfo.cs's own doc comment and VolumeProfileTests for why, matching
    /// CdvUnderlyingState.ComputeLookbackChange's identical reasoning.</summary>
    internal static VolumeProfileResult ComputeVolumeProfile(string underlying, DateOnly date, IReadOnlyList<CandleWithVolume> bars)
    {
        var low = bars.Min(b => b.Low);
        var high = bars.Max(b => b.High);
        if (high <= low) return VolumeProfileResult.Failed(underlying, $"{date:dd MMM yyyy}'s own range was flat - nothing to profile.");
        var binSize = (high - low) / VolumeProfileBinCount;

        var volumeByBin = new long[VolumeProfileBinCount];
        foreach (var bar in bars)
        {
            // Attributes a bar's WHOLE volume to its own CLOSE price's bin - the standard
            // simplification for bars this short (1 minute): their own high-low range is typically a
            // sliver of a bin this wide, so splitting volume proportionally across that range would
            // add real complexity for a difference that rounds away at this granularity.
            var bin = (int)((bar.Close - low) / binSize);
            if (bin >= VolumeProfileBinCount) bin = VolumeProfileBinCount - 1;
            if (bin < 0) bin = 0;
            volumeByBin[bin] += bar.Volume;
        }

        var totalVolume = volumeByBin.Sum();
        if (totalVolume == 0) return VolumeProfileResult.Failed(underlying, $"{date:dd MMM yyyy} had no traded volume to profile.");

        decimal BinPrice(int i) => low + (i + 0.5m) * binSize;

        // POC: the bin with the most volume; on a tie, the one nearest the middle of the range (the
        // standard rule - the same as the Order Flow page's profiles).
        var pocBin = 0;
        var middle = (VolumeProfileBinCount - 1) / 2m;
        for (var i = 1; i < VolumeProfileBinCount; i++)
            if (volumeByBin[i] > volumeByBin[pocBin] || (volumeByBin[i] == volumeByBin[pocBin] && Math.Abs(i - middle) < Math.Abs(pocBin - middle))) pocBin = i;

        // Value area (CBOT / Steidlmayer): from the POC, compare the volume of the TWO bins above the
        // area with the TWO bins below it and add the larger pair (one bin when only one is left on that
        // side; above first on a tie), until ValueAreaShare of the day's total is inside.
        var targetVolume = totalVolume * ValueAreaShare;
        var accumulated = (decimal)volumeByBin[pocBin];
        var lowBin = pocBin;
        var highBin = pocBin;
        while (accumulated < targetVolume && (lowBin > 0 || highBin < VolumeProfileBinCount - 1))
        {
            var upCount = Math.Min(2, VolumeProfileBinCount - 1 - highBin);
            var downCount = Math.Min(2, lowBin);
            long aboveVolume = -1, belowVolume = -1;
            if (upCount > 0) { aboveVolume = 0; for (var k = 1; k <= upCount; k++) aboveVolume += volumeByBin[highBin + k]; }
            if (downCount > 0) { belowVolume = 0; for (var k = 1; k <= downCount; k++) belowVolume += volumeByBin[lowBin - k]; }
            if (aboveVolume >= belowVolume) { highBin += upCount; accumulated += aboveVolume; }
            else { lowBin -= downCount; accumulated += belowVolume; }
        }

        // HVN/LVN: local peaks/troughs in the histogram (strictly higher/lower than BOTH neighbors) -
        // the top 2 of each, by volume for HVN (the strongest OTHER concentrations besides POC itself)
        // and by how pronounced the dip is for LVN (the levels price previously moved through
        // quickly rather than consolidating at). Excludes both histogram edges (no second neighbor to
        // compare against) and the POC bin itself (already surfaced separately).
        var hvnCandidates = new List<(int Bin, long Volume)>();
        var lvnCandidates = new List<(int Bin, long Volume)>();
        for (var i = 1; i < VolumeProfileBinCount - 1; i++)
        {
            if (i == pocBin) continue;
            if (volumeByBin[i] > volumeByBin[i - 1] && volumeByBin[i] > volumeByBin[i + 1]) hvnCandidates.Add((i, volumeByBin[i]));
            else if (volumeByBin[i] < volumeByBin[i - 1] && volumeByBin[i] < volumeByBin[i + 1]) lvnCandidates.Add((i, volumeByBin[i]));
        }
        var hvn = hvnCandidates.OrderByDescending(c => c.Volume).Take(2).Select(c => BinPrice(c.Bin)).ToList();
        var lvn = lvnCandidates.OrderBy(c => c.Volume).Take(2).Select(c => BinPrice(c.Bin)).ToList();

        return new VolumeProfileResult(true, null, underlying, date, BinPrice(pocBin), BinPrice(highBin), BinPrice(lowBin), hvn, lvn)
        {
            Bins = volumeByBin.Select((volume, i) => new VolumeProfileBin(Math.Round(BinPrice(i), 2), volume)).ToList(),
            Bars = bars,
        };
    }
}

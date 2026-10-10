using Microsoft.Extensions.Options;
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
    /// <summary>StrategyTuning:FastOiRange - see StrategyTuningOptions. Only RunRangeAsync reads it;
    /// the per-day path never does.</summary>
    private readonly bool _fastOiRange;
    private readonly ILogger<OiReplayService>? _logger;

    public OiReplayService(
        StoredSpotDataService storedSpot, StoredRollingOptionDataService storedRollingOption,
        DhanSpotInstrumentMaster instrumentMaster, DhanFuturesInstrumentMaster futuresInstrumentMaster,
        DhanHistoricalDataService historicalData, DhanRollingOptionDataService rollingOption,
        AppEnvironment appEnvironment, IOptions<StrategyTuningOptions>? tuningOptions = null,
        NseFuturesContractArchive? futuresArchive = null, NseChartHistory? nseChart = null,
        ILogger<OiReplayService>? logger = null)
    {
        _futuresArchive = futuresArchive;
        _nseChart = nseChart;
        _storedSpot = storedSpot;
        _storedRollingOption = storedRollingOption;
        _instrumentMaster = instrumentMaster;
        _futuresInstrumentMaster = futuresInstrumentMaster;
        _historicalData = historicalData;
        _rollingOption = rollingOption;
        _allowLiveDataFallback = !appEnvironment.IsLocal;
        // Defaults to ON when the setting (or the whole options object) is absent - the same value
        // StrategyTuningOptions' own default carries; read once here, since a range request must not
        // be able to change which path a job is already using halfway through.
        _fastOiRange = tuningOptions?.Value.FastOiRange ?? true;
        _logger = logger;
    }

    public async Task<OiReplayResult> RunAsync(
        string underlying, DateOnly date, int timeframeMinutes, string expiryFlag, CancellationToken cancellationToken, bool forceLive = false)
    {
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

        var (spotBarsRaw, spotError) = await FetchSpotBarsWithVolumeAsync(underlying, date, date, isAlwaysLive, ResolveInstrumentAsync, cancellationToken);

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

        var optionErrors = new System.Collections.Concurrent.ConcurrentBag<string>();
        async Task<List<OiReplayPoint>> FetchPointsAsync(string strikeToken, string drvOptionType)
        {
            await throttle.WaitAsync(cancellationToken);
            try
            {
                var (bars, error) = await GetSeriesAsync(underlying, expiryFlag, NearestExpiryCode, strikeToken, drvOptionType, date, date, ResolveInstrumentAsync, cancellationToken, forceLive);
                if (error is not null) optionErrors.Add($"{strikeToken} {drvOptionType}: {error}");
                var points = new List<OiReplayPoint>(bars.Count);
                foreach (var bar in bars)
                    if (bar.Strike is { } strike)
                        points.Add(new OiReplayPoint(bar.Bar.Time, strike, bar.OpenInterest, bar.ImpliedVolatility, bar.Bar.Close, bar.Bar.Open, bar.Bar.High, bar.Bar.Low, bar.Bar.Volume));
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
            spotCandlesTf, spotBars1m, cePoints, pePoints, futuresBars, futuresExpiry, futuresOiAvailable, futuresError)
        {
            OptionErrors = optionErrors.OrderBy(e => e, StringComparer.Ordinal).ToList(),
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
        var (resolved, resolveError) = await ResolveFuturesContractAsync(underlying, date, cancellationToken);
        if (resolved is null) return (Array.Empty<FuturesBar>(), null, false, resolveError);
        var contract = resolved;

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

    /// <summary>Which futures contract a date's bars should come from, and why there is none when
    /// there isn't - lifted VERBATIM out of GetFuturesAsync (same order, same fallbacks, same
    /// messages) so the range path can ask the same question per day without a second copy of it.
    /// Both the archive lookup and the instrument master are cached/in-memory after the first call,
    /// so asking it for every day of a window is not a Dhan call per day.</summary>
    private async Task<(DhanFuturesInstrument? Contract, string? Error)> ResolveFuturesContractAsync(
        string underlying, DateOnly date, CancellationToken cancellationToken)
    {
        try
        {
            await _futuresInstrumentMaster.EnsureLoadedAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return (null, $"Could not load the futures instrument master: {ex.Message}");
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
        return contract is null
            ? (null, $"No currently-listed futures contract found for {underlying} - the instrument master may still be loading.")
            : (contract, null);
    }


    // ---- The range path: many days per Dhan call ------------------------------------------------
    //
    // Everything below is ADDITIONAL to the per-day path above - RunAsync and everything it calls
    // behaves exactly as it always has, and nothing here runs unless a caller asks for the range
    // endpoint specifically. When in doubt, this code falls back to RunAsync for the day rather than
    // return anything it is not sure of: a slow job is an inconvenience, a wrong OI point prices a
    // real trade wrongly.

    /// <summary>Underlyings whose expiry cadence this app can establish with CERTAINTY from code it
    /// already has, and so the only ones a multi-day window is ever built for:
    ///   - NIFTY (weekly or monthly) and BANKNIFTY (monthly only - NSE discontinued its weekly) are
    ///     exactly what ExpiryCalendar documents and ExpiredOptionBacktestService already fetches
    ///     expired contracts for every day, against real Dhan responses.
    ///   - SENSEX is deliberately absent. It is a BSE contract, and ExpiryCalendar is explicitly an
    ///     NSE calendar (see its own doc comment - "every NSE index option expires on TUESDAY"), so
    ///     this app cannot say which day a SENSEX cycle ends on, and a window that cut on the wrong
    ///     day would splice two contracts together. A SENSEX range is still served - every day the
    ///     ordinary per-day way, at the ordinary cost, which is exactly what it costs today.
    /// A new underlying belongs here only once its real cadence is in ExpiryCalendar.</summary>
    private static readonly HashSet<string> FastRangeUnderlyings = new(StringComparer.OrdinalIgnoreCase) { "NIFTY", "BANKNIFTY" };

    /// <summary>How short a day's own OI may be, against the SAME day's spot, before the window's
    /// answer for it is thrown away and the day is fetched the per-day way instead: fewer than 90% of
    /// the minutes spot has is "a hole", not "a quiet strike". The tuning job's own floor is 300 of a
    /// session's 375 minutes (80%), so this is deliberately stricter than the thing downstream - a
    /// hole gets caught here, by refetching, rather than there, by discarding the day.</summary>
    private const int MinOiMinutesPercentOfSpot = 90;

    /// <summary>
    /// Every trading day in [from,to], each in the SAME shape RunAsync returns for one day - but
    /// fetched with ONE Dhan call per strike per EXPIRY CYCLE instead of 42 calls per day (see
    /// OiReplayRangeWindows for the window maths and why a window can never cross an expiry).
    ///
    /// What this will NOT do, by design:
    ///   - It will not return a day with holes. A window whose own strike calls reported ANY error,
    ///     a day a window returned no CE or no PE for, and a day whose OI covers materially fewer
    ///     minutes than its own spot does, are all fetched again the ordinary per-day way
    ///     (RunAsync) - the result's FallbackDays says which days those were. A strike that is
    ///     missing for one day of a window while other days in the same window have it is reported
    ///     in that day's own OptionErrors, exactly as a failed per-day strike always has been.
    ///   - It will not use a window for an underlying whose expiry cadence this app cannot establish
    ///     (see FastRangeUnderlyings), for a day that IS an expiry day (see OiReplayRangeWindows),
    ///     or at all when StrategyTuning:FastOiRange is off - each of those just means every
    ///     affected day comes from RunAsync, i.e. exactly today's behavior.
    ///   - It will not serve a range wider than OiReplayRangeWindows.MaxRangeDays, or one in the
    ///     future: it says so instead (Dhan serves at most 30 days of expired-option data per call,
    ///     so a wider range saves nothing anyway).
    /// </summary>
    public async Task<OiReplayRangeResult> RunRangeAsync(
        string underlying, DateOnly from, DateOnly to, int timeframeMinutes, string expiryFlag, CancellationToken cancellationToken)
    {
        var timeframe = Math.Max(1, timeframeMinutes);

        // The same guards RunAsync applies, in the same order and with the same messages - a range
        // request must never reach a combination one day could not.
        if (!StrikeStepByUnderlying.ContainsKey(underlying))
            return OiReplayRangeResult.Failed(underlying, from, to, timeframe, expiryFlag, $"'{underlying}' is not supported - only NIFTY, BANKNIFTY, and SENSEX.");
        if (string.Equals(underlying, "BANKNIFTY", StringComparison.OrdinalIgnoreCase) && string.Equals(expiryFlag, "WEEK", StringComparison.OrdinalIgnoreCase))
            return OiReplayRangeResult.Failed(underlying, from, to, timeframe, expiryFlag, "BANKNIFTY has no weekly expiry - NSE discontinued it. Use Monthly instead.");

        if (!AlwaysLiveUnderlyings.Contains(underlying) && !_storedSpot.IsConfigured && !_allowLiveDataFallback)
            return OiReplayRangeResult.Failed(underlying, from, to, timeframe, expiryFlag,
                "Stored data is not configured on this server (no NiftyDataCollector database connection) - see ConnectionStrings:NiftyDataCollectorTimescale.");

        var today = IstClock.Today();
        var days = OiReplayRangeWindows.TradingDayCandidates(from, to, today);
        if (days.Count == 0)
            return OiReplayRangeResult.Failed(underlying, from, to, timeframe, expiryFlag,
                $"No weekday between {from:dd MMM yyyy} and {to:dd MMM yyyy} is a past or current trading day - nothing to fetch.");

        // Validated even when the fast path is off, so the endpoint's own contract (a bounded range)
        // does not change with a setting.
        var (windows, buildError) = OiReplayRangeWindows.Build(expiryFlag, from, to, today);
        if (buildError is not null) return OiReplayRangeResult.Failed(underlying, from, to, timeframe, expiryFlag, buildError);

        // A cadence this app's own expiry calendar does not cover is never guessed at: the OI Replay
        // page can also ask for positional expiry flags ("N1".."N5" - see
        // OiReplayLiveFeedService.ResolveNearestExpiryCore), and nothing here can say which calendar
        // date those resolve to, so a window must not be built for them either.
        var isKnownCadence = string.Equals(expiryFlag, "WEEK", StringComparison.OrdinalIgnoreCase)
            || string.Equals(expiryFlag, "MONTH", StringComparison.OrdinalIgnoreCase);
        var fastPathDisabled =
            !_fastOiRange
                ? "StrategyTuning:FastOiRange is off - every day was fetched the ordinary per-day way."
                : !FastRangeUnderlyings.Contains(underlying)
                    ? $"{underlying}'s expiry cadence is not in this app's own expiry calendar (an NSE calendar) - every day was fetched the ordinary per-day way rather than guess where a contract's cycle ends."
                    : !isKnownCadence
                        ? $"'{expiryFlag}' is not a WEEK/MONTH cadence this app's own expiry calendar can place - every day was fetched the ordinary per-day way."
                        : null;
        if (fastPathDisabled is not null) windows = new List<OiReplayRangeWindows.Window>();

        var isAlwaysLive = AlwaysLiveUnderlyings.Contains(underlying);
        var fromWindow = new Dictionary<DateOnly, DayFromWindow>();
        var windowReports = new List<OiReplayRangeWindow>();
        var optionSeriesCalls = 0;

        if (windows.Count > 0)
        {
            // Resolved once, eagerly, before any concurrent work starts - the same reasoning (and
            // the same race it avoids) as RunAsync's own instrument resolution.
            DhanSpotInstrument? instrument = null;
            if (isAlwaysLive || _allowLiveDataFallback)
            {
                await _instrumentMaster.EnsureLoadedAsync(cancellationToken);
                instrument = _instrumentMaster.FindSpot(underlying);
            }
            Task<DhanSpotInstrument?> ResolveInstrumentAsync() => Task.FromResult(instrument);

            // The whole span's spot in ONE call (Dhan's /charts/intraday takes a date range and
            // documents 90 days per call; the stored source is a plain BETWEEN), then cut per day -
            // instead of one spot call per day.
            var spanFrom = windows[0].From;
            var spanTo = windows[^1].To;
            var (spotBars, spotError) = await FetchSpotBarsWithVolumeAsync(underlying, spanFrom, spanTo, isAlwaysLive, ResolveInstrumentAsync, cancellationToken);
            var spanDays = OiReplayRangeWindows.TradingDayCandidates(spanFrom, spanTo, today);
            var spotByDay = OiReplayRangeWindows.ByDay(spotBars, b => b.Time, spanDays);
            // One call covered every day of the span, so "nothing at all" is the CALL having failed,
            // not the market having been closed for the whole span - in that case nothing here is
            // trusted and every day goes back to the per-day path (which fetches its own spot).
            var spotUsable = spotBars.Count > 0;
            if (!spotUsable)
                _logger?.LogWarning("OI range fetch for {Underlying} {From}..{To} got no spot bars at all ({Error}) - falling back to the per-day path for every day.",
                    underlying, spanFrom, spanTo, spotError ?? "no error reported");

            foreach (var window in windows)
            {
                var windowDays = OiReplayRangeWindows.TradingDayCandidates(window.From, window.To, today);
                var (series, calls) = await FetchWindowBandAsync(underlying, expiryFlag, window, ResolveInstrumentAsync, cancellationToken);
                optionSeriesCalls += calls;

                var windowErrors = series.Where(s => s.Error is not null).Select(s => $"{s.Token} {s.Side}: {s.Error}").ToList();
                windowReports.Add(new OiReplayRangeWindow(window.From, window.To, window.Expiry, window.ExpiryCode, calls,
                    windowErrors.Count == 0 ? null : string.Join("; ", windowErrors)));

                // A window with ANY failed strike is not trusted for ANY of its days: a partial band
                // is exactly the silently-incomplete day this endpoint must never produce. Those days
                // are simply left unassigned here and fetched the per-day way below, which reports
                // its own OptionErrors if the failure is still there.
                if (windowErrors.Count > 0)
                {
                    _logger?.LogWarning("OI range window {From}..{To} ({Underlying} {Flag}+{Code}) had {Count} failed strike series - its {Days} day(s) fall back to the per-day path. First: {First}",
                        window.From, window.To, underlying, expiryFlag, window.ExpiryCode, windowErrors.Count, windowDays.Count, windowErrors[0]);
                    continue;
                }
                if (!spotUsable) continue;

                var perSeriesByDay = series.Select(s => (s.Token, s.Side, ByDay: OiReplayRangeWindows.ByDay(s.Points, p => p.Time, windowDays), Any: s.Points.Count > 0)).ToList();

                foreach (var day in windowDays)
                {
                    var daySpot = spotByDay[day];
                    var ce = perSeriesByDay.Where(s => s.Side == "CALL").SelectMany(s => s.ByDay[day]).ToList();
                    var pe = perSeriesByDay.Where(s => s.Side == "PUT").SelectMany(s => s.ByDay[day]).ToList();

                    if (daySpot.Count == 0)
                    {
                        // A closed market (a holiday): the window's one spot call covered this day and
                        // found nothing, so there is nothing to fetch again - reported as the per-day
                        // path reports it, present in the range rather than missing from it.
                        fromWindow[day] = new DayFromWindow(day, daySpot, ce, pe, Array.Empty<string>(), Closed: true);
                        continue;
                    }

                    // No CE or no PE at all on a day the market was open means the window simply did
                    // not answer for this day - never treated as "the strikes were quiet".
                    if (ce.Count == 0 || pe.Count == 0) continue;

                    // A hole in TIME is the dangerous kind of incompleteness (a strategy reads OI
                    // minute by minute), so a day whose OI covers materially fewer minutes than its
                    // own spot is refetched rather than reported.
                    var spotMinutes = daySpot.Select(b => b.Time).Distinct().Count();
                    var oiMinutes = ce.Concat(pe).Select(p => p.Time).Distinct().Count();
                    if (oiMinutes * 100 < spotMinutes * MinOiMinutesPercentOfSpot) continue;

                    // A strike the window HAS data for on other days but not on this one: kept, and
                    // said out loud on the day itself - the same channel a failed per-day strike has
                    // always been reported through, so a caller that rejects an incomplete day
                    // (the strategy tuning does) keeps rejecting it.
                    var gaps = perSeriesByDay
                        .Where(s => s.Any && s.ByDay[day].Count == 0)
                        .Select(s => $"{s.Token} {s.Side}: no bars for {day:dd MMM yyyy} in the {window.From:dd MMM}..{window.To:dd MMM} window, though other days in it have them")
                        .ToList();

                    fromWindow[day] = new DayFromWindow(day, daySpot, ce, pe, gaps, Closed: false);
                }
            }
        }

        // Futures for the days the window path actually produced, grouped so one Dhan intraday call
        // can cover a run of days on the same contract (see GetFuturesForDaysAsync) - the fallback
        // days get theirs from RunAsync, exactly as always.
        var futuresByDay = await GetFuturesForDaysAsync(underlying, fromWindow.Values.Where(d => !d.Closed).Select(d => d.Date).OrderBy(d => d).ToList(), cancellationToken);

        var results = new List<OiReplayResult>(days.Count);
        var fellBack = new List<DateOnly>();
        foreach (var day in days)
        {
            if (fromWindow.TryGetValue(day, out var built))
            {
                results.Add(BuildDayResult(underlying, built, timeframe, expiryFlag, futuresByDay));
                continue;
            }

            // The proven path, unchanged, for every day a window did not (or must not) answer for.
            var perDay = await RunAsync(underlying, day, timeframe, expiryFlag, cancellationToken);
            optionSeriesCalls += (StrikeBandSteps * 2 + 1) * 2;
            fellBack.Add(day);
            results.Add(perDay with { FetchSource = "day" });
        }

        return new OiReplayRangeResult(true, null, underlying, from, to, timeframe, expiryFlag, results, windowReports)
        {
            FallbackDays = fellBack,
            OptionSeriesCalls = optionSeriesCalls,
            FastPathDisabled = fastPathDisabled,
        };
    }

    /// <summary>One day's worth of a window fetch, before it becomes an OiReplayResult. Closed marks
    /// a day the window's own spot call covered and found nothing for (a holiday) - reported as an
    /// unsuccessful day, not refetched.</summary>
    private sealed record DayFromWindow(
        DateOnly Date, IReadOnlyList<CandleWithVolume> SpotBars, List<OiReplayPoint> CePoints, List<OiReplayPoint> PePoints,
        IReadOnlyList<string> OptionErrors, bool Closed);

    /// <summary>Turns one day cut out of a window into the exact shape RunAsync returns - the same
    /// aggregation (BacktestUtil.AggregateCandles), the same fields, the same OptionErrors channel,
    /// plus FetchSource "range" so a caller can see where the day came from.</summary>
    private static OiReplayResult BuildDayResult(
        string underlying, DayFromWindow day, int timeframe, string expiryFlag,
        IReadOnlyDictionary<DateOnly, (IReadOnlyList<FuturesBar> Bars, DateOnly? Expiry, bool OiAvailable, string? Error)> futuresByDay)
    {
        var step = StrikeStepByUnderlying[underlying];
        if (day.Closed)
            return (OiReplayResult.Failed(underlying, day.Date, timeframe,
                $"No spot data for {underlying} on {day.Date:dd MMM yyyy} - a market holiday, or not backfilled yet.")) with { FetchSource = "range" };

        var spot1m = day.SpotBars.Select(b => b.ToCandle()).ToList();
        var futures = futuresByDay.TryGetValue(day.Date, out var f)
            ? f
            : (Bars: (IReadOnlyList<FuturesBar>)Array.Empty<FuturesBar>(), Expiry: (DateOnly?)null, OiAvailable: false,
                Error: (string?)$"No futures data for {day.Date:dd MMM yyyy}.");

        return new OiReplayResult(true, null, underlying, day.Date, timeframe, step, expiryFlag, NearestExpiryCode,
            BacktestUtil.AggregateCandles(spot1m, timeframe), spot1m,
            // NOT re-sorted: the window's series are collected strike by strike (ATM-10..ATM+10),
            // each one time-ascending, which is the EXACT order RunAsync's own concurrent band fetch
            // produces - so a caller reading these lists sees the same sequence either way, not just
            // the same set.
            day.CePoints, day.PePoints,
            futures.Bars, futures.Expiry, futures.OiAvailable, futures.Error)
        {
            OptionErrors = day.OptionErrors.OrderBy(e => e, StringComparer.Ordinal).ToList(),
            FetchSource = "range",
        };
    }

    /// <summary>The whole ATM+-StrikeBandSteps band for ONE window - 42 series (21 strikes x CE/PE),
    /// one Dhan call each covering every day of the window, fetched with the same bounded concurrency
    /// (MaxConcurrentStrikeFetches) and through the same GetSeriesAsync the per-day path uses, so the
    /// same stored-first rule, the same rate limiter lane and the same error reporting apply. Returns
    /// each series separately (not one flattened list) because "which strike is missing for which
    /// day" is exactly what the caller has to be able to see.</summary>
    private async Task<(List<(string Token, string Side, List<OiReplayPoint> Points, string? Error)> Series, int Calls)> FetchWindowBandAsync(
        string underlying, string expiryFlag, OiReplayRangeWindows.Window window,
        Func<Task<DhanSpotInstrument?>> resolveInstrument, CancellationToken cancellationToken)
    {
        using var throttle = new SemaphoreSlim(MaxConcurrentStrikeFetches);

        async Task<(string Token, string Side, List<OiReplayPoint> Points, string? Error)> FetchAsync(string strikeToken, string drvOptionType)
        {
            await throttle.WaitAsync(cancellationToken);
            try
            {
                var (bars, error) = await GetSeriesAsync(underlying, expiryFlag, window.ExpiryCode, strikeToken, drvOptionType,
                    window.From, window.To, resolveInstrument, cancellationToken);
                var points = new List<OiReplayPoint>(bars.Count);
                foreach (var bar in bars)
                    if (bar.Strike is { } strike)
                        points.Add(new OiReplayPoint(bar.Bar.Time, strike, bar.OpenInterest, bar.ImpliedVolatility, bar.Bar.Close, bar.Bar.Open, bar.Bar.High, bar.Bar.Low, bar.Bar.Volume));
                return (strikeToken, drvOptionType, points, error);
            }
            finally
            {
                throttle.Release();
            }
        }

        var tasks = new List<Task<(string, string, List<OiReplayPoint>, string?)>>();
        for (var steps = -StrikeBandSteps; steps <= StrikeBandSteps; steps++)
        {
            var token = ExpiredOptionBacktestService.StrikeToken(steps);
            tasks.Add(FetchAsync(token, "CALL"));
            tasks.Add(FetchAsync(token, "PUT"));
        }
        await Task.WhenAll(tasks);

        return (tasks.Select(t => t.Result).ToList(), tasks.Count);
    }

    /// <summary>Each day's futures, for a run of days, in as few calls as the contracts allow: days
    /// sharing one contract are fetched in ONE /charts/intraday range call (that endpoint takes a
    /// date range and documents 90 days per call) and cut per day. A day the range call returned
    /// nothing for is fetched again through GetFuturesAsync - the per-day path with all of its own
    /// fallbacks (an expired contract's NSE chart data, another contract listed that day), which a
    /// range call cannot reproduce. FuturesError / FuturesOiAvailable stay per day either way.</summary>
    private async Task<Dictionary<DateOnly, (IReadOnlyList<FuturesBar> Bars, DateOnly? Expiry, bool OiAvailable, string? Error)>> GetFuturesForDaysAsync(
        string underlying, IReadOnlyList<DateOnly> days, CancellationToken cancellationToken)
    {
        var byDay = new Dictionary<DateOnly, (IReadOnlyList<FuturesBar> Bars, DateOnly? Expiry, bool OiAvailable, string? Error)>();
        if (days.Count == 0) return byDay;

        // Which contract each day belongs to - cached lookups, not a Dhan call per day (see
        // ResolveFuturesContractAsync).
        var contracts = new Dictionary<DateOnly, DhanFuturesInstrument?>();
        string? resolveError = null;
        foreach (var day in days)
        {
            var (contract, error) = await ResolveFuturesContractAsync(underlying, day, cancellationToken);
            contracts[day] = contract;
            resolveError ??= error;
        }

        var groups = new List<(DhanFuturesInstrument Contract, List<DateOnly> Days)>();
        foreach (var day in days)
        {
            if (contracts[day] is not { } contract)
            {
                byDay[day] = (Array.Empty<FuturesBar>(), null, false, resolveError);
                continue;
            }
            if (groups.Count > 0 && groups[^1].Contract.SecurityId == contract.SecurityId) groups[^1].Days.Add(day);
            else groups.Add((contract, new List<DateOnly> { day }));
        }

        foreach (var (contract, groupDays) in groups)
        {
            var sliced = new Dictionary<DateOnly, List<(CandleWithVolume Bar, long? OpenInterest)>>();
            var oiFieldPresent = false;
            if (groupDays.Count > 1)
            {
                var (bars, oiPresent, error) = await _historicalData.GetIntradayFuturesCandlesAsync(
                    contract.SecurityId, contract.DhanSegment, groupDays[0], groupDays[^1], 1, cancellationToken);
                oiFieldPresent = oiPresent;
                if (error is null && bars.Count > 0) sliced = OiReplayRangeWindows.ByDay(bars, b => b.Bar.Time, groupDays);
            }

            foreach (var day in groupDays)
            {
                if (sliced.TryGetValue(day, out var dayBars) && dayBars.Count > 0)
                {
                    byDay[day] = (dayBars.Select(b => new FuturesBar(b.Bar.Time, b.Bar.Open, b.Bar.High, b.Bar.Low, b.Bar.Close, b.Bar.Volume, b.OpenInterest)).ToList(),
                        contract.Expiry, oiFieldPresent, null);
                    continue;
                }
                byDay[day] = await GetFuturesAsync(underlying, day, cancellationToken);
            }
        }

        return byDay;
    }

    /// <summary>
    /// Fetches ONE day both ways - cut out of a real multi-day window, and through the per-day path
    /// this app has always used - and compares every OI point (see OiReplayDayComparer). The proof
    /// the range path is worth trusting, meant to be run for real before a long job leans on it: on
    /// any difference the caller should use the per-day path for the whole job, and the difference is
    /// logged here as a warning too, so it is visible on the server even if nobody reads the
    /// response.
    ///
    /// The window used is deliberately a REAL one, several days wide where the cycle allows, not the
    /// requested day alone - a one-day window would send Dhan exactly the per-day request and prove
    /// nothing about slicing a multi-day answer. WindowFrom/WindowTo in the result say how wide it
    /// actually was.
    /// </summary>
    public async Task<(OiReplayDayComparison? Comparison, DateOnly WindowFrom, DateOnly WindowTo, string? Error)> CheckDayAsync(
        string underlying, DateOnly date, int timeframeMinutes, string expiryFlag, CancellationToken cancellationToken)
    {
        var timeframe = Math.Max(1, timeframeMinutes);
        var today = IstClock.Today();
        if (date > today) return (null, date, date, $"{date:dd MMM yyyy} is in the future - there is nothing to compare yet.");

        // The widest window that still contains `date`, stays inside the date's own expiry cycle and
        // inside one request's cap - built by the same code the endpoint itself uses, so the check
        // exercises the real thing.
        var probeFrom = date.AddDays(-(OiReplayRangeWindows.MaxRangeDays / 3));
        var probeTo = date.AddDays(OiReplayRangeWindows.MaxRangeDays / 3);
        if (probeTo > today) probeTo = today;
        var (windows, buildError) = OiReplayRangeWindows.Build(expiryFlag, probeFrom, probeTo, today);
        if (buildError is not null) return (null, probeFrom, probeTo, buildError);
        var found = windows.Where(w => w.From <= date && date <= w.To).Cast<OiReplayRangeWindows.Window?>().FirstOrDefault();
        if (found is not { } window)
            return (null, probeFrom, probeTo,
                $"{date:dd MMM yyyy} is not inside any multi-day window - an expiry day is always fetched the per-day way (see OiReplayRangeWindows), so there is nothing to compare for it.");

        var range = await RunRangeAsync(underlying, window.From, window.To, timeframe, expiryFlag, cancellationToken);
        if (!range.Success) return (null, window.From, window.To, range.Error);
        var rangeDay = range.Days.FirstOrDefault(d => d.Date == date);
        if (rangeDay is null) return (null, window.From, window.To, $"The range fetch returned no day for {date:dd MMM yyyy}.");
        if (range.FallbackDays.Contains(date))
            return (null, window.From, window.To,
                $"{date:dd MMM yyyy} itself fell back to the per-day path inside the range fetch, so there is nothing to compare - " +
                (range.FastPathDisabled ?? range.Windows.FirstOrDefault(w => w.From <= date && date <= w.To)?.Error ?? "no reason reported, which itself is worth looking into"));

        var perDay = await RunAsync(underlying, date, timeframe, expiryFlag, cancellationToken);
        var comparison = OiReplayDayComparer.Compare(date, rangeDay, perDay);
        if (!comparison.Match)
            _logger?.LogWarning("OI range self-check FAILED for {Underlying} {Date} (window {From}..{To}): {Differences}",
                underlying, date, window.From, window.To, string.Join(" | ", comparison.Differences));
        else
            _logger?.LogInformation("OI range self-check passed for {Underlying} {Date} (window {From}..{To}): {Points} CE / {PePoints} PE points identical both ways.",
                underlying, date, window.From, window.To, comparison.RangeCePoints, comparison.RangePePoints);

        return (comparison, window.From, window.To, null);
    }

    /// <summary>One CE or PE series for one relative strike: stored first (when configured), then a
    /// live Dhan call over it ONLY when live fallback is allowed and the stored result isn't fresh
    /// enough (see IsFreshEnough) - the exact same "prefer stored, fall through when it's not good
    /// enough" shape as ExpiredOptionBacktestService's own useStoredData handling, just decided per
    /// series here instead of once per whole request, since different strikes' own stored rows can
    /// in principle lag by different amounts. Skips straight to the live call, unconditionally, for
    /// an AlwaysLiveUnderlyings member (SENSEX) - there is no stored series to prefer for those at
    /// all.
    ///
    /// Takes a DATE RANGE and an expiryCode rather than a single date and a fixed code 1, so the
    /// range endpoint (RunRangeAsync) fetches a whole expiry cycle of days per call through THIS
    /// method - the same stored-first decision, the same live call, the same error reporting - rather
    /// than a second copy of it that could drift. The per-day path passes (date, date) and
    /// NearestExpiryCode, which is exactly what it always sent.</summary>
    private async Task<(IReadOnlyList<(CandleWithVolume Bar, decimal? Strike, decimal? Spot, long? OpenInterest, decimal? ImpliedVolatility)> Bars, string? Error)> GetSeriesAsync(
        string underlying, string expiryFlag, int expiryCode, string strikeToken, string drvOptionType, DateOnly fromDay, DateOnly toDay,
        Func<Task<DhanSpotInstrument?>> resolveInstrument, CancellationToken cancellationToken, bool forceLive = false)
    {
        var isAlwaysLive = forceLive || AlwaysLiveUnderlyings.Contains(underlying);

        var storedBars = !isAlwaysLive && _storedRollingOption.IsConfigured
            ? (await _storedRollingOption.GetRollingOptionCandlesAsync(underlying, 0, expiryFlag, expiryCode, strikeToken, drvOptionType, fromDay, toDay, 1, cancellationToken)).Bars
            : Array.Empty<(CandleWithVolume, decimal?, decimal?, long?, decimal?)>();

        if (!isAlwaysLive && !_allowLiveDataFallback) return (storedBars, null);

        var latest = storedBars.Count > 0 ? storedBars[^1].Item1.Time : (DateTimeOffset?)null;
        // Judged against the LAST day of the window - the only day whose freshness can be in
        // question, since "today" is the one date IsFreshEnough treats as still forming.
        if (!isAlwaysLive && IsFreshEnough(toDay, latest)) return (storedBars, null);

        var instrument = await resolveInstrument();
        if (instrument is null) return (storedBars, null);

        var (liveBars, liveError) = await _rollingOption.GetRollingOptionCandlesAsync(
            underlying, instrument.SecurityId, expiryFlag, expiryCode, strikeToken, drvOptionType, fromDay, toDay, 1, cancellationToken);
        // A live call that FAILED (rate limit, timeout, auth) is reported, not passed off as an empty strike - the
        // caller says which strikes are missing instead of returning a day with silent holes in its OI.
        return liveBars.Count > 0 ? (liveBars, null) : (storedBars, storedBars.Count > 0 ? null : liveError);
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
    /// silently drifting copies.
    ///
    /// Takes a DATE RANGE (the per-day callers pass the same date twice, exactly what they always
    /// sent) because both sources already serve one: Dhan's /charts/intraday takes a date range and
    /// documents 90 days per call, and the stored query is a plain BETWEEN. So the range endpoint
    /// gets a whole window's spot in ONE call here instead of one call per day, through the same
    /// stored-first logic.</summary>
    private async Task<(IReadOnlyList<CandleWithVolume> Bars, string? Error)> FetchSpotBarsWithVolumeAsync(
        string underlying, DateOnly fromDay, DateOnly toDay, bool isAlwaysLive, Func<Task<DhanSpotInstrument?>> resolveInstrument, CancellationToken cancellationToken)
    {
        var spotBarsRaw = !isAlwaysLive && _storedSpot.IsConfigured
            ? (await _storedSpot.GetSpotCandlesAsync(underlying, fromDay, toDay, cancellationToken)).Bars
            : Array.Empty<CandleWithVolume>();
        var spotError = (string?)null;

        if (isAlwaysLive || (_allowLiveDataFallback && !IsFreshEnough(toDay, spotBarsRaw.Count > 0 ? spotBarsRaw[^1].Time : null)))
        {
            var liveInstrument = await resolveInstrument();
            if (liveInstrument is not null)
            {
                var (liveSpotBars, liveSpotError) = await _historicalData.GetIntradayCandlesAsync(
                    liveInstrument.SecurityId, liveInstrument.DhanSegment, fromDay, toDay, 1, cancellationToken);
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
            var (bars, _) = await FetchSpotBarsWithVolumeAsync(underlying, candidate, candidate, isAlwaysLive, ResolveInstrumentAsync, cancellationToken);
            if (bars.Count == 0) return false;
            foundBars = bars;
            return true;
        });
        if (resolvedDate is null)
            return VolumeProfileResult.Failed(underlying, $"No previous trading day data found for {underlying} in the last week.");
        return ComputeVolumeProfile(underlying, resolvedDate.Value, foundBars);
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

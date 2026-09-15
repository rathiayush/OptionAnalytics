using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Runs a registered IBacktestStrategy against an EXPIRED contract, given an actual calendar expiry
/// date - the thing BacktestService itself cannot do, since it only ever reads whatever spot/ATM
/// candle history SpotFeedHostedService/CdvHostedService currently hold LIVE in memory (a rolling
/// window of recent trading days, nothing that has already expired).
///
/// Two data sources feed one BacktestStrategyContext:
///   - SPOT bars come from Dhan's ordinary /charts/intraday endpoint (DhanHistoricalDataService) -
///     real OHLC, the same source the live app already trusts for spot. Deliberately NOT sourced
///     from the rolling-option endpoint's own "spot" field: that field is a single scalar per bar
///     (no separate spot-open/high/low), so building a synthetic candle from it (Open=High=Low=
///     Close) would silently corrupt any breakout/EMA-touch logic that reads a bar's High/Low - the
///     exact thing FiveEmaStrategy's alert-candle rule depends on. If /charts/intraday doesn't
///     reach back far enough for the requested date range, this fails loudly (see RunAsync) rather
///     than falling back to that degraded shape. GetSpotCandlesAsync below tries
///     HistoricalSpotDataStore's on-disk cache first (HistoricalSpotDataPrefetchHostedService fills
///     it once per deployment with the last ~1 year) and only falls back to this live call when the
///     cache does not fully cover the requested window - a run within that cached year no longer
///     costs a Dhan call for its spot side at all.
///   - The OPTION premium comes from Dhan's rolling-option endpoint (DhanRollingOptionDataService) -
///     the only way to reach an expired contract's own price history at all. NOT covered by the
///     on-disk cache above - see HistoricalSpotDataPrefetchHostedService's own doc comment for why
///     (its RELATIVE "ATM+-K" token means there is no single absolute series to cache the way spot
///     has one).
///
/// Every strategy whose ENTIRE signal and pricing logic reads spot bars plus GetOptionBars(strike,
/// isCall) for one specific strike at a time is trivially supported (see SupportedStrategyKeys) -
/// FiveEmaStrategy is the plain case, its signal generation reading only spot bars while
/// OptionTradeSimulator.Run itself calls GetOptionBars for whichever strike the resulting trade is
/// actually taken at, which this class already serves for any strike within the fetched band (see
/// StrikeBandSteps).
///
/// EmaCrossAtmFlowStrategy additionally needs OBV/CDV computed across the WHOLE surrounding strike
/// chain (see BacktestStrategyContext.ObvCeSeries/CdvCeSeries and CdvUnderlyingState.GetObvSeries's
/// own "summed across every tracked strike" doc comment) - not something GetOptionBars for one
/// strike can ever supply on its own. Supported anyway, at the user's own explicit request for exact
/// parity with what Backtrack itself would show: RunAsync fetches a much WIDER band for this one
/// strategy (pure ATM +-FlowChainRadius) and reconstructs OBV/CDV/AtmCeBars/AtmPeBars from it via a
/// scratch, throwaway CdvUnderlyingState instance (see BuildFlowChainSeries) - the SAME offline
/// backfill machinery CdvHostedService itself uses to seed a strike's history before its first live
/// tick, just driven from Dhan's rolling-option data instead of Dhan's ordinary option-chain one.
/// FlowChainRadius is 10, not live's own wider ATM+-16 (CdvHostedService.StrikeRange) - Dhan's
/// rolling-option endpoint's own documented "strike" enum tops out at "ATM+-10" (see
/// DhanRollingOptionDataService's own doc comment), so ATM+-10 is the actual ceiling this data
/// source can ever supply, not a cost/latency choice this app is free to widen further. This is
/// real, not synthetic/empty flow data, but it is real work: 42 separate rolling-option fetches
/// instead of the usual 26, each individually chunked/paced like every other token here - a run
/// using this specific strategy takes noticeably longer and carries more exposure to Dhan's own
/// rate limit than any other strategy this app runs.
///
/// GetOptionBars/GetOptionBarsOneMinute below DO use the actual "strike" value a strategy passes in
/// (an ABSOLUTE price - OptionTradeSimulator computes it as "ATM at the signal's own time +-
/// otmSteps") - see StrikeBandSteps/FetchStrikeBandAsync/BuildFixedStrikeSeries for why: the single
/// relative token this run's own otmSteps calls for is fetched alongside a whole BAND of nearby
/// tokens too, so that a trade entered at one specific absolute strike keeps being priced off THAT
/// exact contract for its whole life, even if the index has since moved far enough that Dhan's own
/// day-level "ATM+-K" resolution for the single primary token would otherwise have quietly drifted
/// onto a different real contract by the time of exit (added at the user's own explicit request -
/// "even if index is moved you need to keep watch on it... give me result from that particular
/// strike"). Different runs use different otmSteps, so a new run always re-fetches its own band
/// rather than serving stale strikes from a previous one.
///
/// HOW EXPIRYCODE IS CHOSEN (this is the part that took several real runs to get right):
/// Dhan's own Annexure documents expiryCode as a tiny enum - 0 = current/near expiry, 1 = next,
/// 2 = far - counted from the query's own fromDate, NOT an arbitrary "how many weeks out" number.
/// A real call also confirmed 0 is rejected outright ("expiryCode is required", the same error a
/// required-field check gives a value it treats as absent), so 0 is never sent.
///
/// Most runs get the SPECIFIC contract the caller asked for by sending code 1 and choosing fromDate
/// instead - anchored to just after the PREVIOUS contract's own expiry, so that whatever expiry
/// comes "1st" after fromDate can only be the one the caller actually wants. This is also what
/// fixed the contract-splicing a wide, undifferentiated lookback used to cause: a window that can
/// never reach past the prior contract's own expiry cannot roll onto it in the first place.
///
/// MULTI-SEGMENT FETCH (added at the user's own explicit request to reach further back than one
/// contract's own cycle - e.g. selecting 25 Aug's monthly expiry with a 45-day lookback,
/// deliberately reaching into July, or a weekly expiry with a lookback past 7 days): a lookback
/// that reaches past the immediately preceding real expiry (of the SAME cadence - weekly anchors
/// against prior weekly expiries, monthly against prior monthly ones) is split into more than one
/// [From,To,ExpiryCode] segment (see BuildFetchSegments) - the nearest segment still uses code 1
/// anchored after the immediately preceding expiry (the proven mechanism above, unchanged), and an
/// older segment anchored one real expiry earlier still uses code 2 ("the 2nd expiry from
/// fromDate", by the same 1-indexed counting-forward logic - see DhanRollingOptionDataService's own
/// doc comment for why that reading, not an NSE-near/next/far-listing-depth one, is what this app's
/// prior evidence actually supports). UNLIKE the single-segment mechanism, this multi-segment
/// extension has NOT been confirmed against a real Dhan response for either cadence - the existing
/// splice-detection safety net (DetectPossibleSplices) is what makes shipping it before that
/// confirmation reasonable: if the older segment's anchoring turns out wrong, it shows up as a
/// splice at the segment boundary and gets trimmed away, degrading to exactly the single-segment
/// result rather than silently mispricing anything.</summary>
public sealed class ExpiredOptionBacktestService
{
    /// <summary>Empty right now - every strategy that used to be listed here was removed. A new
    /// strategy becomes eligible for Expired Backtest by adding its key here, provided its entire
    /// signal/pricing logic only reads spot bars plus GetOptionBars(strike, isCall) for one strike at
    /// a time (see this class's own top-of-file doc comment for the one exception that needs more:
    /// order-flow across the whole surrounding strike chain, via includeObvCdv/needsFlowChain
    /// below).</summary>
    private static readonly HashSet<string> SupportedStrategyKeys = new();

    /// <summary>Underlyings this feature supports at all - Dhan's rolling-option docs only ever show
    /// "NSE_FNO" as the exchange segment, never a BSE one, so SENSEX is left out rather than
    /// guessed at.</summary>
    private static readonly Dictionary<string, int> StrikeStepByUnderlying = new(StringComparer.OrdinalIgnoreCase)
    {
        ["NIFTY"] = 50,
        ["BANKNIFTY"] = 100,
    };

    /// <summary>Dhan's own "the 1st expiry from fromDate" resolution (see this class's own doc
    /// comment) - the code every SINGLE-segment fetch uses (most runs, either cadence). A run whose
    /// lookback reaches further back than the immediately preceding real expiry needs a SECOND,
    /// older segment anchored one real expiry earlier still - see BuildFetchSegments for why that
    /// older segment uses code 2, not this constant.</summary>
    private const int ExpiryCode = 1;

    /// <summary>How far back GetAvailableExpiries offers dates for - see ExpiryCalendar's own doc
    /// comment for why this app cannot defensibly claim accuracy further back than the current
    /// Tuesday-expiry convention has been in effect (SEBI's November 2024 rule).</summary>
    private const int CalendarMonthsBack = 12;

    /// <summary>How far forward GetAvailableExpiries offers NOT-YET-EXPIRED dates for, at the user's
    /// own explicit request ("I should be able to test against them as well"). This carries none of
    /// CalendarMonthsBack's accuracy concern - a future expiry is a real, currently-listed, actively
    /// trading contract, not a guess at one that doesn't exist yet, and the exact same fetch/anchor
    /// mechanism already handles the CURRENT (nearest, not-yet-expired) contract correctly, which is
    /// exactly what removing the old live-overlap guard on this dropdown proved out. Bounded anyway,
    /// generously, so the dropdown doesn't fill with dates so far out Dhan may not have listed the
    /// actual contract for yet - RunAsync's own "no data" failure is the backstop if one slips
    /// through with nothing to fetch.</summary>
    private const int CalendarMonthsForward = 3;

    /// <summary>How many extra days of spot history the CHART fetches on each side of the actual
    /// [fromDay,toDay] lookback window - see RunAsync's own comment on why this is safe to widen
    /// (spot has no contract of its own to splice across) even though CE/PE's window cannot be.</summary>
    private const int ChartPaddingDays = 2;

    /// <summary>How many relative-strike tokens EITHER SIDE of a run's own primary otmSteps (or, on
    /// the Rolling Strike Data page, the offset a requested absolute strike converts to) get fetched
    /// into a BAND, at the user's own explicit request ("even if index is moved you need to keep
    /// watch on it... give me result from that particular strike"): Dhan's rolling-option endpoint
    /// only ever accepts a RELATIVE "ATM+-K" token, so there is no way to ask it directly for "strike
    /// 56200's own price, whatever ATM does later" - the only way to get that with this API is to
    /// fetch a wide enough range of tokens that, whatever day the index has since drifted to, SOME
    /// token in the band still resolves to that exact absolute strike, then stitch those matching
    /// bars together (see BuildFixedStrikeSeries). 6 either side (13 tokens total per side) is what
    /// the user confirmed after being told the real cost: StrikeBandSteps*2+1 separate rolling-
    /// option fetches per side instead of 1, each individually chunked/paced exactly like a single
    /// fetch is today - a real run takes noticeably longer and carries more exposure to Dhan's own
    /// rate limit, which the user explicitly accepted ("even it takes few min lets do it").</summary>
    private const int StrikeBandSteps = 6;

    /// <summary>Radius (steps either side of pure ATM) for the WIDE, exact-parity flow-chain band
    /// EmaCrossAtmFlowStrategy needs when it runs here, since OBV/CDV are a delta-weighted SUM
    /// across every tracked strike (see CdvUnderlyingState.GetObvSeries's own doc comment: "summed
    /// across every tracked strike"), not one leg's own series the way GetOptionBars/AtmCeBars are.
    /// 10 either side (21 tokens per side, 42 total instead of the usual 13/26) is the actual CEILING
    /// this data source can supply, not a cost/latency choice: Dhan's rolling-option endpoint's own
    /// documented "strike" enum tops out at "ATM+-10" (see DhanRollingOptionDataService's own doc
    /// comment), narrower than live CdvHostedService's own tracked ATM+-16 window
    /// (CdvHostedService.StrikeRange) - so this is the closest this endpoint can ever get to genuine
    /// parity with what Backtrack itself would show, confirmed with the user as worth the real cost
    /// (noticeably slower and more exposed to Dhan's rate limit than any other strategy this app
    /// runs) even knowing it stops short of the live window's own full radius.
    ///
    /// RunAsync fetches only this ONE band when the strategy needs it, reused for pricing too -
    /// never a second, separate fetch just for the traded strike.</summary>
    private const int FlowChainRadius = 10;

    /// <summary>Pacing between successive TOKEN fetches within one side's own band (see
    /// FetchStrikeBandAsync) - same idea and same value as DhanRollingOptionDataService's own
    /// ChunkDelay (which only paces chunks WITHIN one token's own fetch), extended to the band loop
    /// itself so StrikeBandSteps*2+1 back-to-back token fetches do not burst at Dhan the same way
    /// running CE and PE concurrently used to (see this class's own top-of-file doc comment on that
    /// real failure).</summary>
    private static readonly TimeSpan BandFetchDelay = TimeSpan.FromMilliseconds(350);

    private readonly DhanSpotInstrumentMaster _instrumentMaster;
    private readonly DhanHistoricalDataService _historicalData;
    private readonly DhanRollingOptionDataService _rollingOption;
    private readonly HistoricalSpotDataStore _spotCache;
    private readonly IReadOnlyDictionary<string, IBacktestStrategy> _strategies;

    public ExpiredOptionBacktestService(
        DhanSpotInstrumentMaster instrumentMaster,
        DhanHistoricalDataService historicalData,
        DhanRollingOptionDataService rollingOption,
        HistoricalSpotDataStore spotCache,
        IEnumerable<IBacktestStrategy> strategies)
    {
        _instrumentMaster = instrumentMaster;
        _historicalData = historicalData;
        _rollingOption = rollingOption;
        _spotCache = spotCache;
        _strategies = strategies.Where(s => SupportedStrategyKeys.Contains(s.Key)).ToDictionary(s => s.Key);
    }

    /// <summary>Spot candles for [fromDay,toDay], served from HistoricalSpotDataPrefetchHostedService's
    /// own on-disk cache when it fully covers the window (a fast local CSV read, no Dhan call at
    /// all), falling straight back to the ordinary live fetch otherwise - a window reaching earlier
    /// than the cache's own year, or newer than its last prefetch, or simply not yet prefetched on
    /// this deployment. Every caller here already handles GetIntradayCandlesAsync's own (Candles,
    /// Error) shape, so the cache hit path returns the identical shape with a null error rather than
    /// introducing a third return convention.</summary>
    private async Task<(IReadOnlyList<CandleWithVolume> Candles, string? Error)> GetSpotCandlesAsync(
        string underlying, DhanSpotInstrument instrument, DateOnly fromDay, DateOnly toDay, CancellationToken cancellationToken)
    {
        if (_spotCache.HasCompleteData(underlying, fromDay, toDay))
            return (_spotCache.Read(underlying, fromDay, toDay), null);

        return await _historicalData.GetIntradayCandlesAsync(instrument.SecurityId, instrument.DhanSegment, fromDay, toDay, 1, cancellationToken);
    }

    /// <summary>Metadata for just the strategies this page can actually run - see
    /// SupportedStrategyKeys. Same BacktestStrategyInfo shape BacktestService.GetStrategies uses, so
    /// the frontend's existing generic parameter-rendering code works unchanged here.</summary>
    public IReadOnlyList<BacktestStrategyInfo> GetStrategies() =>
        _strategies.Values.Select(s => new BacktestStrategyInfo(s.Key, s.Name, s.Description, s.Parameters)).OrderBy(s => s.Name).ToList();

    /// <summary>Every date this page will actually accept for expiryDate - a REAL listed expiry
    /// (see ExpiryCalendar), not just any Tuesday-ish date a user might type, since the anchoring
    /// logic (see this class's own top-of-file doc comment) assumes fromDate sits just inside the
    /// ACTUAL target contract's own life, which only holds when expiryDate itself is genuine.
    /// Descending (most recent first), since a recent expiry is usually the more useful default -
    /// this also puts the not-yet-expired, still-trading contracts (today's nearest expiry and
    /// CalendarMonthsForward beyond it) at the very top of the list.
    ///
    /// This deliberately does NOT exclude dates already covered by Backtrack's own live-tracked
    /// history (an earlier version of this method did) - the caller is expected to keep their own
    /// lookbackDays within the target contract's own life (see MaxLookbackDays) to avoid
    /// re-fetching across a live contract boundary.</summary>
    public IReadOnlyList<DateOnly> GetAvailableExpiries(string underlying, string expiryFlag)
    {
        if (!StrikeStepByUnderlying.ContainsKey(underlying)) return Array.Empty<DateOnly>();
        if (string.Equals(underlying, "BANKNIFTY", StringComparison.OrdinalIgnoreCase) && string.Equals(expiryFlag, "WEEK", StringComparison.OrdinalIgnoreCase))
            return Array.Empty<DateOnly>();

        var today = IstClock.Today();
        var rangeStart = today.AddMonths(-CalendarMonthsBack);
        var rangeEnd = today.AddMonths(CalendarMonthsForward);

        var candidates = string.Equals(expiryFlag, "MONTH", StringComparison.OrdinalIgnoreCase)
            ? ExpiryCalendar.MonthlyExpiries(rangeStart, rangeEnd)
            : ExpiryCalendar.WeeklyExpiries(rangeStart, rangeEnd);

        return candidates.OrderByDescending(d => d).ToList();
    }

    public async Task<ExpiredBacktestResult> RunAsync(
        string underlying, string expiryFlag, DateOnly expiryDate, int lookbackDays, string strategyKey,
        int timeframeMinutes, IReadOnlyDictionary<string, decimal> parameters,
        CancellationToken cancellationToken, bool includeObvCdv = false)
    {
        if (!StrikeStepByUnderlying.TryGetValue(underlying, out var step))
            return ExpiredBacktestResult.Failed($"'{underlying}' is not supported - only NIFTY and BANKNIFTY (Dhan's rolling-option API only documents NSE_FNO index options).");

        // NSE discontinued BANKNIFTY's own weekly options entirely - there is no such contract to
        // resolve, so WEEK here would not just be a bad default, it would ask Dhan for something
        // that never existed. Rejected outright rather than silently falling through to whatever
        // Dhan happens to return for a request it cannot actually satisfy.
        if (string.Equals(underlying, "BANKNIFTY", StringComparison.OrdinalIgnoreCase) && string.Equals(expiryFlag, "WEEK", StringComparison.OrdinalIgnoreCase))
            return ExpiredBacktestResult.Failed("BANKNIFTY has no weekly expiry - NSE discontinued it. Use Monthly instead.");

        if (!_strategies.TryGetValue(strategyKey, out var strategy))
            return ExpiredBacktestResult.Failed(
                $"'{strategyKey}' cannot run against expired-option history - it needs order-flow (OBV/CDV) across the whole surrounding strike chain, which Dhan's rolling-option endpoint does not provide (a single relative strike per call only). Supported here: {string.Join(", ", SupportedStrategyKeys)}.");

        // The bug this exists to prevent, confirmed by a real run: a typed expiryDate that was NOT
        // an actual listed expiry broke the fromDate-anchoring this whole feature depends on (see
        // this class's own top-of-file doc comment), letting the fetch window reach across a REAL
        // contract boundary and splice two different contracts' premiums together. Validating
        // against the same GetAvailableExpiries list the page's own dropdown is populated from
        // means a request that reaches this point can only ever name a date that dropdown could
        // have offered - distinguishing the two failure reasons since they have different remedies.
        var cadence = string.Equals(expiryFlag, "MONTH", StringComparison.OrdinalIgnoreCase) ? "monthly" : "weekly";
        var today = IstClock.Today();

        var isRealExpiry = string.Equals(expiryFlag, "MONTH", StringComparison.OrdinalIgnoreCase)
            ? ExpiryCalendar.MonthlyExpiries(expiryDate, expiryDate).Count > 0
            : ExpiryCalendar.WeeklyExpiries(expiryDate, expiryDate).Count > 0;
        if (!isRealExpiry)
            return ExpiredBacktestResult.Failed(
                $"{expiryDate:dd MMM yyyy} is not a real {cadence} expiry - NSE's current convention (since Nov 2024) is the last Tuesday of the month (monthly) or every Tuesday (weekly), possibly shifted a day earlier around a trading holiday. Pick a date from the list.");

        if (expiryDate < today.AddMonths(-CalendarMonthsBack))
            return ExpiredBacktestResult.Failed(
                $"{expiryDate:dd MMM yyyy} is further back than this app can reliably validate ({CalendarMonthsBack} months) - NSE's expiry-weekday convention has changed more than once historically, so a date this old is not offered.");

        if (expiryDate > today.AddMonths(CalendarMonthsForward))
            return ExpiredBacktestResult.Failed(
                $"{expiryDate:dd MMM yyyy} is further ahead than this app offers ({CalendarMonthsForward} months) - Dhan may not have even listed that contract yet. Pick a date from the list.");

        // A no-op once SpotFeedHostedService's own startup resolve has already loaded the shared
        // instance (see EnsureLoadedAsync's freshness check) - only actually downloads/parses
        // anything on a cold request that beat that background resolve to it.
        await _instrumentMaster.EnsureLoadedAsync(cancellationToken);

        var instrument = _instrumentMaster.FindSpot(underlying);
        if (instrument is null)
            return ExpiredBacktestResult.Failed($"Could not resolve {underlying}'s Dhan security id yet - the scrip master may still be loading. Try again shortly.");

        // Capped at today, never expiryDate itself, for a not-yet-expired contract - "the contract's
        // life so far" (the whole point of offering future expiries at all) can only ever mean up to
        // right now, since no trading has happened on any day after today regardless of how real and
        // currently-listed the contract is. Left equal to expiryDate for an already-past one, exactly
        // as before.
        var toDay = expiryDate > today ? today : expiryDate;

        // Anchors directly against ExpiryCalendar's own real prior expiry dates (see
        // BuildFetchSegments) - and, when the requested lookback reaches past the immediately
        // preceding one, builds a SECOND, older segment rather than just clamping the request away;
        // MaxLookbackDays here is only the outer sanity bound on the raw input, not the real safety
        // boundary. Deliberately anchored against the REAL expiryDate, not toDay - Dhan's own
        // expiryCode resolution (see this class's own top-of-file doc comment) needs the actual
        // future expiry to land on the right contract; only the DATA window fetched from it is ever
        // capped at today.
        var requestedFromDay = expiryDate.AddDays(-Math.Clamp(lookbackDays, 1, MaxLookbackDays(expiryFlag)));
        var segments = BuildFetchSegments(expiryFlag, expiryDate, requestedFromDay);
        var fromDay = segments[0].From;

        // A future expiry whose own requested lookback hasn't even STARTED yet (fromDay itself is
        // still ahead of today) is a completely different situation from "Dhan lacks history this
        // old" or "the market was shut" - nothing failed, the window the caller asked for simply
        // hasn't happened. Caught here, before a single Dhan call, with a message that says exactly
        // that rather than the generic no-data one below.
        if (fromDay > toDay)
            return ExpiredBacktestResult.Failed(
                $"{underlying} hasn't traded yet over the requested window - today is {today:dd MMM yyyy}, but a {lookbackDays}-day lookback from {expiryDate:dd MMM yyyy} starts {fromDay:dd MMM yyyy}, which is still in the future. Pick a shorter lookback (or wait until closer to today) to backtest this contract's life so far.");

        // Every fetch segment's own upper bound is capped the same way as toDay above - a future
        // contract has no real data past right now no matter how far out its own expiry still is.
        // The fromDay > toDay guard above already guarantees at least one segment survives this.
        segments = ClampSegmentsToToday(segments, today);

        var effectiveLookbackDays = toDay.DayNumber - fromDay.DayNumber;

        // The spot CHART shown alongside the trade table is fetched a few days wider than the
        // lookback window itself on both sides - purely for visual context around it, so a signal
        // sitting right at the window's own edge doesn't look like it appeared out of nowhere. Safe
        // to widen ONLY on the spot side: unlike CE/PE (see this class's own top-of-file doc
        // comment), the underlying INDEX has no "expired contract" of its own to accidentally splice
        // across, so this padding carries none of the risk MaxLookbackDays exists to avoid. The
        // strategy itself still only ever sees spotBars1m below (the exact [fromDay,toDay] slice),
        // unaffected by this wider fetch.
        var chartFromDay = fromDay.AddDays(-ChartPaddingDays);
        var chartToDay = toDay.AddDays(ChartPaddingDays);

        var (spotVolumeBarsForChart, spotError) = await GetSpotCandlesAsync(underlying, instrument, chartFromDay, chartToDay, cancellationToken);
        var spotBarsForChart = spotVolumeBarsForChart.Select(b => b.ToCandle()).ToList();
        var spotBars1m = spotBarsForChart.Where(b => IstClock.IstDate(b.Time) >= fromDay && IstClock.IstDate(b.Time) <= toDay).ToList();
        // The same [fromDay,toDay] slice as spotBars1m, but keeping Volume - what VwapCalculator
        // needs; spotBars1m itself stays plain Candle since every other reader here (FetchStrikeBandAsync,
        // BuildFlowChainSeries, AggregateCandles) only ever wants OHLC.
        var spotVolumeBars1m = spotVolumeBarsForChart.Where(b => IstClock.IstDate(b.Time) >= fromDay && IstClock.IstDate(b.Time) <= toDay).ToList();
        if (spotBars1m.Count == 0)
            return ExpiredBacktestResult.Failed(spotError is null
                ? $"No spot history for {underlying} between {fromDay:dd MMM yyyy} and {toDay:dd MMM yyyy} - the market may simply have been closed the whole window, or Dhan's intraday history may not reach back that far for a window this old."
                : $"No spot history for {underlying} between {fromDay:dd MMM yyyy} and {toDay:dd MMM yyyy} - Dhan: {spotError}");

        // Every parameter the strategy declares but the caller omitted falls back to its own
        // default - same rule BacktestService.Prepare uses, so a strategy implementation can always
        // assume the dictionary handed to Simulate/EntrySignals is complete.
        var mergedParameters = strategy.Parameters.ToDictionary(p => p.Key, p => parameters.TryGetValue(p.Key, out var v) ? v : p.Default);
        var otmSteps = (int)mergedParameters.GetValueOrDefault("otmSteps", 0);

        var ceStrike = StrikeToken(otmSteps);
        var peStrike = StrikeToken(-otmSteps);

        // Sequential, not Task.WhenAll - each side's own fetch is already chunked (and paced) across
        // Dhan's 30-day-per-call cap (see DhanRollingOptionDataService), and Dhan's rate limit is
        // account-wide, not per-endpoint. Running both sides concurrently was exactly what a
        // "Rate_Limit: Too many requests" error on the second side came from: two chunked loops
        // bursting requests in parallel, each individually paced but with no coordination between
        // them. One side fully finishing before the other starts keeps every request this method
        // makes on the same, single, paced cadence - including every SEGMENT of one side (see
        // BuildFetchSegments) and every TOKEN in one side's own band (see FetchStrikeBandAsync), not
        // just each side as a whole.
        //
        // A BAND of tokens per side, not just the single one otmSteps calls for - see
        // StrikeBandSteps' own doc comment for why: it is what lets GetOptionBars below keep pricing
        // a trade off the EXACT absolute strike it entered at, even if the index has since moved far
        // enough that Dhan's own day-level "ATM+-K" resolution for the single primary token would
        // otherwise have quietly drifted onto a different real contract.
        //
        // EmaCrossAtmFlowStrategy needs a WIDER band (pure ATM +-FlowChainRadius) to reconstruct
        // OBV/CDV summed across the whole live-tracked chain (see FlowChainRadius/BuildFlowChainSeries'
        // own doc comments) - fetched here INSTEAD of the ordinary otmSteps+-StrikeBandSteps one, not
        // in addition to it, since FlowChainRadius (10) already covers any legal otmSteps (bounded to
        // +-8), so the wider band alone still serves this run's own pricing too.
        //
        // includeObvCdv opts ANY strategy into this same wide fetch purely so the page can plot the
        // OBV/CDV chart alongside a run, for the user to visually check those series are behaving
        // sensibly - no currently-registered strategy's own signal logic reads it (see
        // SupportedStrategyKeys' own doc comment for the kind of strategy that would). Off by
        // default: it is real extra work (42 rolling-option fetches instead of the usual 26, per
        // FlowChainRadius' own doc comment) and extra exposure to Dhan's rate limit, so a run that
        // does not ask for the chart does not pay for it.
        var needsFlowChain = includeObvCdv;
        var bandCenterSteps = needsFlowChain ? 0 : otmSteps;
        var bandRadius = needsFlowChain ? FlowChainRadius : StrikeBandSteps;
        var (ceBand, ceError) = await FetchStrikeBandAsync(instrument.SecurityId, expiryFlag, segments, bandCenterSteps, bandRadius, isCall: true, spotBars1m, step, cancellationToken);
        var (peBand, peError) = await FetchStrikeBandAsync(instrument.SecurityId, expiryFlag, segments, bandCenterSteps, bandRadius, isCall: false, spotBars1m, step, cancellationToken);

        // The PRIMARY (centre-of-band) member - what this run's own otmSteps actually calls for -
        // used only for the summary stats below (resolved/expected strike, splices, bar counts).
        // Pricing itself no longer depends on any one band member alone - see GetOptionBars below.
        var cePrimary = ceBand.First(m => m.Steps == otmSteps);
        var pePrimary = peBand.First(m => m.Steps == otmSteps);
        var ceSplices = cePrimary.Splices;
        var peSplices = pePrimary.Splices;

        var ceUsed = cePrimary.Bars.Select(b => b.Bar).ToList();
        var peUsed = pePrimary.Bars.Select(b => b.Bar).ToList();

        // What strike Dhan itself actually resolved "ATM+-K" to, versus what this app expected from
        // its own real spot - the direct check for a mismatched contract resolution rather than a
        // genuinely-priced but merely surprising premium. Read off the LAST bar (closest to expiry,
        // most representative of "the ATM this run cared about") rather than averaging across a
        // series that may itself have re-centered as spot moved through the window.
        var ceResolvedStrike = cePrimary.Bars.LastOrDefault(b => b.Strike is > 0).Strike;
        var peResolvedStrike = pePrimary.Bars.LastOrDefault(b => b.Strike is > 0).Strike;
        var spotDuringUsedWindow = ceUsed.Count > 0 ? spotBars1m.Where(b => b.Time >= ceUsed[0].Time).ToList() : spotBars1m;
        var referenceSpot = spotDuringUsedWindow.Count > 0 ? spotDuringUsedWindow[^1].Close : spotBars1m[^1].Close;
        var referenceAtm = step > 0 ? Math.Round(referenceSpot / step) * step : referenceSpot;
        var ceExpectedStrike = referenceAtm + otmSteps * step;
        var peExpectedStrike = referenceAtm - otmSteps * step;

        var timeframe = Math.Max(1, timeframeMinutes);

        // GetOptionBars/GetOptionBarsOneMinute now actually USE the strike argument a strategy
        // passes in, instead of ignoring it - BuildFixedStrikeSeries searches the WHOLE fetched band
        // (StrikeBandSteps either side of otmSteps) for whichever token, AT EACH BAR, actually
        // resolved to the exact absolute strike requested, so a trade entered at (say) 56200 keeps
        // being priced off 56200's own real data for as long as ANY fetched token in the band still
        // reports it - not whatever the single primary token happens to have drifted onto by exit.
        IReadOnlyList<Candle> OneMinuteOptionBars(decimal strikeArg, bool isCallArg) =>
            BuildFixedStrikeSeries(isCallArg ? ceBand : peBand, strikeArg, step).Select(b => b.ToCandle()).ToList();

        IReadOnlyList<Candle> TimeframeOptionBars(decimal strikeArg, bool isCallArg) =>
            BacktestUtil.AggregateCandles(OneMinuteOptionBars(strikeArg, isCallArg), timeframe);

        // The WIDER (chartFromDay..chartToDay) series, not spotBars1m - what the page's own chart
        // plots, so the padding around the lookback window this method fetched actually reaches it.
        var spotChartCandlesTf = BacktestUtil.AggregateCandles(spotBarsForChart, timeframe);
        // Volume counterpart, same wider chart window - a plain fetch reuse (spotVolumeBarsForChart
        // was already fetched for spotBarsForChart/spotVolumeBars1m above), no extra Dhan call. VWAP
        // is computed off the native 1-minute series FIRST (session-anchored cumulative sums need
        // per-minute granularity, not pre-aggregated buckets) and only aggregated to the chart's own
        // timeframe afterward - the same "compute at 1m, then AggregateLine" order OBV/CDV already use.
        var spotVolumeChartBarsTf = BacktestUtil.AggregateCandlesWithVolume(spotVolumeBarsForChart, timeframe);
        var spotVwapSeriesTf = BacktestUtil.AggregateLine(VwapCalculator.ComputeSeries(spotVolumeBarsForChart), timeframe);

        // Only EmaCrossAtmFlowStrategy reads any of this for its own signal logic (see needsFlowChain
        // above) - a run of any other strategy still gets it computed (and returned - see below) when
        // includeObvCdv asked for it; otherwise the same harmless empty placeholders this class has
        // always handed a strategy that does not read them.
        var (atmCeBars1m, atmPeBars1m, obvCeSeries1m, obvPeSeries1m, cdvCeSeries1m, cdvPeSeries1m) = needsFlowChain
            ? BuildFlowChainSeries(underlying, ceBand, peBand, spotBars1m, step)
            : (Array.Empty<Candle>(), Array.Empty<Candle>(), Array.Empty<ObvPoint>(), Array.Empty<ObvPoint>(), Array.Empty<ObvPoint>(), Array.Empty<ObvPoint>());

        // Computed once, at the chart's own timeframe, and reused both by the strategy context below
        // AND the result returned to the page - so the OBV/CDV chart plots EXACTLY what the strategy
        // itself saw, not a second, separately-aggregated copy that could drift from it.
        var obvCeSeriesTf = BacktestUtil.AggregateLine(obvCeSeries1m, timeframe);
        var obvPeSeriesTf = BacktestUtil.AggregateLine(obvPeSeries1m, timeframe);
        var cdvCeSeriesTf = BacktestUtil.AggregateLine(cdvCeSeries1m, timeframe);
        var cdvPeSeriesTf = BacktestUtil.AggregateLine(cdvPeSeries1m, timeframe);

        var context = new BacktestStrategyContext
        {
            Underlying = underlying,
            TimeframeMinutes = timeframe,
            Step = step,
            SpotBars = BacktestUtil.AggregateCandles(spotBars1m, timeframe),
            SpotBarsOneMinute = spotBars1m,
            SpotVolumeBarsOneMinute = spotVolumeBars1m,
            ConfluenceSignalsAscending = Array.Empty<BacktestSignal>(),
            AllSignals = Array.Empty<BacktestSignal>(),
            ObvCeSeries = obvCeSeriesTf,
            ObvPeSeries = obvPeSeriesTf,
            CdvCeSeries = cdvCeSeriesTf,
            CdvPeSeries = cdvPeSeriesTf,
            GetOptionBars = TimeframeOptionBars,
            GetOptionBarsOneMinute = OneMinuteOptionBars,
            AtmCeBars = BacktestUtil.AggregateCandles(atmCeBars1m, timeframe),
            AtmPeBars = BacktestUtil.AggregateCandles(atmPeBars1m, timeframe),
            AtmCeVolumeBars = Array.Empty<CandleWithVolume>(),
            AtmPeVolumeBars = Array.Empty<CandleWithVolume>(),
            AtmStrike = null,
        };

        var trades = strategy.Simulate(context, mergedParameters);
        var signals = strategy.EntrySignals(context, mergedParameters);

        return new ExpiredBacktestResult(
            true, null, trades, signals, ExpiryCode, ceStrike, peStrike, ceError, peError,
            // The counts actually fed to the strategy after trimming, not the raw fetch - what the
            // page should show as "how much of the single target contract's own history this run
            // used."
            spotBars1m.Count, ceUsed.Count, peUsed.Count, ceSplices, peSplices,
            ceResolvedStrike, peResolvedStrike, ceExpectedStrike, peExpectedStrike, effectiveLookbackDays,
            spotChartCandlesTf, spotVolumeChartBarsTf, spotVwapSeriesTf,
            obvCeSeriesTf, obvPeSeriesTf, cdvCeSeriesTf, cdvPeSeriesTf);
    }

    /// <summary>The raw rolling-option series for ONE relative strike/side, with no strategy run
    /// against it at all - what the Strike Data (Rolling) page needs to let a real premium anomaly
    /// (a bar whose High/Low never actually traded - see this app's own real finding of exactly
    /// that) be inspected directly, bar by bar and resolved-strike by resolved-strike, instead of
    /// only inferred from a trade's own surprising exit. Shares every validation/anchoring rule
    /// RunAsync uses (same expiry/lookback bounds, same BuildFetchSegments/ClampSegmentsToToday
    /// anchoring, same DetectPossibleSplices safety net) so this page can never show a window the
    /// real backtest page itself would have rejected or handled differently.
    ///
    /// Deliberately returns the RAW fetch, not TrimToLargestSegment's trimmed result - a real splice
    /// or a wrong-contract bar is exactly what this page exists to make visible, not something to
    /// quietly cut away before the user ever sees it (RunAsync itself trims, since a live strategy
    /// run has to pick ONE contract to trade; this one does not).
    ///
    /// <paramref name="absoluteStrike"/>, when given, overrides <paramref name="otmSteps"/>: an
    /// ABSOLUTE strike (e.g. the exact "56200" a disputed trade's own row named) is converted to the
    /// relative token Dhan's endpoint actually needs (it has no "give me this exact strike" input at
    /// all) using the ATM AS OF <paramref name="expiryDate"/>'s own window (real spot across the
    /// whole [fromDay,toDay] fetch window, its LATEST bar), NOT today's current spot - converting
    /// against today's price for a date that may be weeks or months in the past would round to a
    /// strike offset several steps away from the one that actually existed back then, which is a
    /// wrong-contract bug of this app's OWN making rather than anything Dhan itself did.
    ///
    /// When <paramref name="absoluteStrike"/> is given, this ALSO fetches a whole BAND of tokens
    /// around that starting offset (see StrikeBandSteps) and returns, in the result's own
    /// FixedStrikeBars, absoluteStrike's own price stitched continuously across the whole window
    /// (see BuildFixedStrikeSeries) - so the chart can show that ONE real contract's own data even on
    /// a day the index has since moved far enough that the single starting token would have drifted
    /// onto a different real strike. Bars (the raw, unfiltered per-token fetch) stays exactly what it
    /// always was: the single PRIMARY token's own untouched response, for auditing.</summary>
    public async Task<RollingOptionChartResult> GetRollingChartAsync(
        string underlying, string expiryFlag, DateOnly expiryDate, int otmSteps, decimal? absoluteStrike, bool isCall, int lookbackDays,
        CancellationToken cancellationToken)
    {
        if (!StrikeStepByUnderlying.ContainsKey(underlying))
            return RollingOptionChartResult.Failed($"'{underlying}' is not supported - only NIFTY and BANKNIFTY (Dhan's rolling-option API only documents NSE_FNO index options).");

        if (string.Equals(underlying, "BANKNIFTY", StringComparison.OrdinalIgnoreCase) && string.Equals(expiryFlag, "WEEK", StringComparison.OrdinalIgnoreCase))
            return RollingOptionChartResult.Failed("BANKNIFTY has no weekly expiry - NSE discontinued it. Use Monthly instead.");

        var cadence = string.Equals(expiryFlag, "MONTH", StringComparison.OrdinalIgnoreCase) ? "monthly" : "weekly";
        var today = IstClock.Today();

        var isRealExpiry = string.Equals(expiryFlag, "MONTH", StringComparison.OrdinalIgnoreCase)
            ? ExpiryCalendar.MonthlyExpiries(expiryDate, expiryDate).Count > 0
            : ExpiryCalendar.WeeklyExpiries(expiryDate, expiryDate).Count > 0;
        if (!isRealExpiry)
            return RollingOptionChartResult.Failed(
                $"{expiryDate:dd MMM yyyy} is not a real {cadence} expiry - NSE's current convention (since Nov 2024) is the last Tuesday of the month (monthly) or every Tuesday (weekly), possibly shifted a day earlier around a trading holiday. Pick a date from the list.");

        if (expiryDate < today.AddMonths(-CalendarMonthsBack))
            return RollingOptionChartResult.Failed(
                $"{expiryDate:dd MMM yyyy} is further back than this app can reliably validate ({CalendarMonthsBack} months) - NSE's expiry-weekday convention has changed more than once historically, so a date this old is not offered.");

        if (expiryDate > today.AddMonths(CalendarMonthsForward))
            return RollingOptionChartResult.Failed(
                $"{expiryDate:dd MMM yyyy} is further ahead than this app offers ({CalendarMonthsForward} months) - Dhan may not have even listed that contract yet. Pick a date from the list.");

        await _instrumentMaster.EnsureLoadedAsync(cancellationToken);

        var instrument = _instrumentMaster.FindSpot(underlying);
        if (instrument is null)
            return RollingOptionChartResult.Failed($"Could not resolve {underlying}'s Dhan security id yet - the scrip master may still be loading. Try again shortly.");

        var toDay = expiryDate > today ? today : expiryDate;

        var requestedFromDay = expiryDate.AddDays(-Math.Clamp(lookbackDays, 1, MaxLookbackDays(expiryFlag)));
        var segments = BuildFetchSegments(expiryFlag, expiryDate, requestedFromDay);
        var fromDay = segments[0].From;

        if (fromDay > toDay)
            return RollingOptionChartResult.Failed(
                $"{underlying} hasn't traded yet over the requested window - today is {today:dd MMM yyyy}, but a {lookbackDays}-day lookback from {expiryDate:dd MMM yyyy} starts {fromDay:dd MMM yyyy}, which is still in the future. Pick a shorter lookback (or wait until closer to today) to inspect this contract's life so far.");

        segments = ClampSegmentsToToday(segments, today);
        var effectiveLookbackDays = toDay.DayNumber - fromDay.DayNumber;

        var step = StrikeStepByUnderlying[underlying];
        var resolvedOtmSteps = otmSteps;
        List<StrikeBandMember>? band = null;
        string? bandError = null;

        if (absoluteStrike is { } strikeValue)
        {
            // The FULL [fromDay,toDay] window, not just a short reference slice near toDay - still
            // used to convert strikeValue into a starting relative offset off the window's own
            // LATEST spot (unchanged from before), but now ALSO needed for FilterToExpectedStrike to
            // validate every member of the strike BAND fetched below - see StrikeBandSteps' own doc
            // comment for why one token alone cannot keep tracking a fixed absolute strike as the
            // index moves.
            var (windowSpotVolumeBars, spotError) = await GetSpotCandlesAsync(underlying, instrument, fromDay, toDay, cancellationToken);
            var windowSpotBars = windowSpotVolumeBars.Select(b => b.ToCandle()).ToList();
            if (windowSpotBars.Count == 0)
                return RollingOptionChartResult.Failed(
                    $"Could not resolve spot history for {fromDay:dd MMM yyyy}..{toDay:dd MMM yyyy} to convert {strikeValue:0.##} into a strike offset - {spotError ?? "no spot history in that window"}.");

            var referenceSpot = windowSpotBars[^1].Close;
            var referenceAtm = step > 0 ? Math.Round(referenceSpot / step) * step : referenceSpot;
            var absoluteToken = step > 0 ? (int)Math.Round((strikeValue - referenceAtm) / step, MidpointRounding.AwayFromZero) : 0;
            // The token is symmetric in ABSOLUTE terms - "ATM+2" names the same real strike whether
            // asking for the CE or PE sitting at it - so this cancels back out via the same isCall
            // sign flip below, the same way RunAsync's own ceStrike/peStrike do for a shared
            // otmSteps; nothing extra needed here beyond computing the plain absolute offset.
            resolvedOtmSteps = isCall ? absoluteToken : -absoluteToken;

            // A BAND of tokens around resolvedOtmSteps, not just the single one - so absoluteStrike
            // keeps being found even on a day the index has drifted enough that this single starting
            // offset no longer resolves to it (see BuildFixedStrikeSeries below).
            (band, bandError) = await FetchStrikeBandAsync(instrument.SecurityId, expiryFlag, segments, resolvedOtmSteps, StrikeBandSteps, isCall, windowSpotBars, step, cancellationToken);
        }

        // Same sign convention RunAsync itself uses: otmSteps is "how far OTM for the side actually
        // being looked at", negated for PE since OTM sits BELOW spot for a put but above it for a
        // call - see StrikeToken/RunAsync's own ceStrike/peStrike computation.
        var strikeToken = StrikeToken(isCall ? resolvedOtmSteps : -resolvedOtmSteps);
        var optionType = isCall ? "CALL" : "PUT";

        List<(CandleWithVolume Bar, decimal? Strike, decimal? Spot)> raw;
        List<PossibleSplice> splices;
        string? error;

        if (band is { } fetchedBand)
        {
            // Already fetched as part of the band above (resolvedOtmSteps sits at its exact centre)
            // - reuse it rather than fetching the very same token a second time.
            var primary = fetchedBand.First(m => m.Steps == resolvedOtmSteps);
            raw = primary.RawBars;
            splices = primary.Splices;
            error = bandError;
        }
        else
        {
            (raw, error) = await FetchAcrossSegmentsAsync(instrument.SecurityId, expiryFlag, segments, strikeToken, optionType, cancellationToken);
            splices = DetectPossibleSplices(raw.Select(b => b.Bar).ToList());
        }

        // Only populated when a specific absolute strike was requested - see StrikeBandSteps' own
        // doc comment. Stitched from the band fetched above, so it keeps tracking absoluteStrike's
        // OWN price continuously across the whole window, not just the days the single primary token
        // happened to land on it (unlike Bars below, which stays the single primary token's own RAW,
        // unfiltered fetch, exactly as before, for auditing).
        var fixedStrikeBars = absoluteStrike is { } targetStrike && band is { } strikeBand
            ? BuildFixedStrikeSeries(strikeBand, targetStrike, step)
                .Select(b => new RollingOptionChartBar(b.Time, b.Open, b.High, b.Low, b.Close, b.Volume, targetStrike))
                .ToList()
            : new List<RollingOptionChartBar>();

        return new RollingOptionChartResult(
            true, error, strikeToken, optionType, effectiveLookbackDays,
            raw.Select(b => new RollingOptionChartBar(b.Bar.Time, b.Bar.Open, b.Bar.High, b.Bar.Low, b.Bar.Close, b.Bar.Volume, b.Strike)).ToList(),
            splices, absoluteStrike, fixedStrikeBars);
    }

    private static string StrikeToken(int steps) => steps == 0 ? "ATM" : $"ATM{(steps > 0 ? "+" : "")}{steps}";

    /// <summary>Neither cadence uses this as a real safety boundary any more - BuildFetchSegments
    /// computes its own directly from ExpiryCalendar's real expiry dates instead of approximating
    /// one with a flat number. This is still called for both, but only to sanity-clamp an absurd
    /// raw input before it reaches that method (see RawLookbackSanityCapDays).</summary>
    internal static int MaxLookbackDays(string expiryFlag) => RawLookbackSanityCapDays;

    /// <summary>The outer sanity bound on a raw lookbackDays input, applied BEFORE BuildFetchSegments
    /// ever sees it - not itself a safety boundary (that method's own anchoring against real prior
    /// expiries is), just a guard against a wildly large typed number doing something undefined.
    /// Generous enough to comfortably cover the 2 real cycles BuildFetchSegments can ever actually
    /// use for either cadence (see its own MaxPriorExpiries).</summary>
    private const int RawLookbackSanityCapDays = 200;

    /// <summary>One rolling-option fetch call's own [From,To] window and the expiryCode to send
    /// with it - see BuildFetchSegments's own doc comment for why a single run can need more than
    /// one of these.</summary>
    internal readonly record struct FetchSegment(DateOnly From, DateOnly To, int ExpiryCode);

    /// <summary>How many real prior expiries (of the SAME cadence as the target) BuildFetchSegments
    /// will ever anchor a segment against - 2 is every segment this app's own multi-segment design
    /// currently supports (see this class's own top-of-file doc comment); a lookback that would need
    /// a THIRD only ever gets clamped back to what 2 segments can reach, the same "clamped, not
    /// rejected" behavior EffectiveLookbackDays already reports for any other over-long request.</summary>
    private const int MaxPriorExpiries = 2;

    /// <summary>Splits [requestedFromDay, targetExpiry] into one or more fetch segments, each
    /// anchored so Dhan's own "Nth expiry from fromDate" resolution (see DhanRollingOptionDataService's
    /// own doc comment on expiryCode) can only resolve to targetExpiry within it:
    ///   - Segment 1 (nearest): code 1, anchored just after the real expiry (of the SAME cadence -
    ///     expiryFlag decides whether that means the prior WEEKLY or prior MONTHLY expiry)
    ///     immediately before targetExpiry - the original, single-segment mechanism, unchanged,
    ///     confirmed correct across many real runs.
    ///   - Segment 2 (older, only added when requestedFromDay reaches further back than segment 1's
    ///     own start): code 2, anchored just after the real expiry BEFORE THAT - "the 2nd expiry
    ///     from fromDate" resolving to targetExpiry by the same counting-forward logic segment 1
    ///     already relies on. NOT yet confirmed against a real Dhan response for either cadence -
    ///     see this class's own top-of-file doc comment for why shipping it before that
    ///     confirmation is still reasonable (DetectPossibleSplices is the safety net).
    /// Returned oldest-first, so a caller can fetch each side across every segment in that order and
    /// simply concatenate - the combined series is already time-ascending.</summary>
    internal static List<FetchSegment> BuildFetchSegments(string expiryFlag, DateOnly targetExpiry, DateOnly requestedFromDay)
    {
        var isMonthly = string.Equals(expiryFlag, "MONTH", StringComparison.OrdinalIgnoreCase);
        var priorExpiries = (isMonthly
                ? ExpiryCalendar.MonthlyExpiries(targetExpiry.AddMonths(-6), targetExpiry.AddDays(-1))
                : ExpiryCalendar.WeeklyExpiries(targetExpiry.AddMonths(-6), targetExpiry.AddDays(-1)))
            .OrderByDescending(d => d).Take(MaxPriorExpiries).ToList();
        var prevExpiry = priorExpiries.Count > 0 ? priorExpiries[0] : (DateOnly?)null;
        var prevPrevExpiry = priorExpiries.Count > 1 ? priorExpiries[1] : (DateOnly?)null;

        var segment1EarliestStart = prevExpiry is { } pe ? pe.AddDays(1) : requestedFromDay;
        var segment1Start = Later(requestedFromDay, segment1EarliestStart);
        var segments = new List<FetchSegment> { new(segment1Start, targetExpiry, 1) };

        if (requestedFromDay < segment1EarliestStart && prevExpiry is { } segment2End)
        {
            var segment2EarliestStart = prevPrevExpiry is { } ppe ? ppe.AddDays(1) : requestedFromDay;
            var segment2Start = Later(requestedFromDay, segment2EarliestStart);
            if (segment2Start <= segment2End) segments.Insert(0, new FetchSegment(segment2Start, segment2End, 2));
        }

        return segments;
    }

    private static DateOnly Later(DateOnly a, DateOnly b) => a > b ? a : b;

    /// <summary>Caps every segment's own upper bound at <paramref name="today"/> and drops any that
    /// end up inverted (From left past the new, clamped To) as a result - a not-yet-expired target
    /// contract has no real data past right now no matter how far out its own expiry still is, and
    /// with a target far enough out even the PREVIOUS same-cadence expiry an older segment anchors
    /// against (see BuildFetchSegments) can itself still be in the future, which is what leaves a
    /// segment inverted rather than merely shortened. RunAsync's own fromDay > toDay guard (checked
    /// BEFORE calling this) already guarantees at least one segment survives.</summary>
    internal static List<FetchSegment> ClampSegmentsToToday(IReadOnlyList<FetchSegment> segments, DateOnly today) =>
        segments
            .Select(s => s.To > today ? s with { To = today } : s)
            .Where(s => s.From <= s.To)
            .ToList();

    /// <summary>Fetches one option side across every segment (see BuildFetchSegments),
    /// oldest first, and concatenates the results - segments are already ordered oldest-first and
    /// each one's own bars are individually time-ascending (DhanRollingOptionDataService's own
    /// chunking preserves that), so the combined series is time-ascending too with no extra
    /// sorting needed. Per-segment errors are concatenated rather than only the first/last kept, so
    /// a failure on the OLDER (less-tested, code-2) segment is never silently hidden by an older
    /// segment's success or vice versa.</summary>
    private async Task<(List<(CandleWithVolume Bar, decimal? Strike, decimal? Spot)> Bars, string? Error)> FetchAcrossSegmentsAsync(
        uint underlyingSecurityId, string expiryFlag, IReadOnlyList<FetchSegment> segments, string strikeToken, string optionType,
        CancellationToken cancellationToken)
    {
        var bars = new List<(CandleWithVolume Bar, decimal? Strike, decimal? Spot)>();
        string? error = null;

        foreach (var segment in segments)
        {
            var (segmentBars, segmentError) = await _rollingOption.GetRollingOptionCandlesAsync(
                underlyingSecurityId, expiryFlag, segment.ExpiryCode, strikeToken, optionType, segment.From, segment.To, 1, cancellationToken);
            bars.AddRange(segmentBars);
            if (segmentError is not null) error = error is null ? segmentError : $"{error}; {segmentError}";
        }

        return (bars, error);
    }

    /// <summary>One band member's own data (see FetchStrikeBandAsync): RawBars is the untouched fetch
    /// (what a caller inspecting "everything Dhan sent back for this token" wants), Bars is the SAME
    /// data after this run's usual TrimToLargestSegment + FilterToExpectedStrike processing (what a
    /// real backtest trade should actually be priced from), and Splices is what DetectPossibleSplices
    /// found in RawBars - kept per member so a caller can still report "what did the PRIMARY token's
    /// own splices/resolved-strike look like" exactly as before, even though pricing itself no longer
    /// depends on any one member alone (see BuildFixedStrikeSeries).</summary>
    internal readonly record struct StrikeBandMember(
        int Steps,
        List<(CandleWithVolume Bar, decimal? Strike, decimal? Spot)> RawBars,
        List<(CandleWithVolume Bar, decimal? Strike, decimal? Spot)> Bars,
        List<PossibleSplice> Splices);

    /// <summary>Fetches every relative-strike token from centerSteps-radius to centerSteps+radius
    /// for one side (CE or PE, isCall says which) - the raw ingredients BuildFixedStrikeSeries
    /// stitches one FIXED absolute strike's own continuous series from. See StrikeBandSteps' own doc
    /// comment for why one token alone cannot do that at all - callers pass StrikeBandSteps for an
    /// ordinary run, or FlowChainRadius (wider, always centered on pure ATM) when the selected
    /// strategy needs the whole flow chain (see BuildFlowChainSeries).
    ///
    /// Sequential, individually paced (BandFetchDelay) - never parallel, for the same account-wide
    /// rate-limit reason this class's own top-of-file doc comment already explains for CE-vs-PE.
    /// Per-member errors are concatenated, same convention FetchAcrossSegmentsAsync itself uses.</summary>
    private async Task<(List<StrikeBandMember> Band, string? Error)> FetchStrikeBandAsync(
        uint underlyingSecurityId, string expiryFlag, IReadOnlyList<FetchSegment> segments, int centerSteps, int radius, bool isCall,
        IReadOnlyList<Candle> spotBars, int step, CancellationToken cancellationToken)
    {
        var optionType = isCall ? "CALL" : "PUT";
        var band = new List<StrikeBandMember>();
        string? error = null;
        var isFirst = true;

        for (var steps = centerSteps - radius; steps <= centerSteps + radius; steps++)
        {
            // Paced, not back to back - see BandFetchDelay's own doc comment. Skipped before the
            // very first token only.
            if (!isFirst) await Task.Delay(BandFetchDelay, cancellationToken);
            isFirst = false;

            var token = StrikeToken(isCall ? steps : -steps);
            var (raw, fetchError) = await FetchAcrossSegmentsAsync(underlyingSecurityId, expiryFlag, segments, token, optionType, cancellationToken);
            if (fetchError is not null) error = error is null ? fetchError : $"{error}; {fetchError}";

            var splices = DetectPossibleSplices(raw.Select(b => b.Bar).ToList());
            var filtered = FilterToExpectedStrike(TrimToLargestSegment(raw, splices), spotBars, step, steps, isCall);
            band.Add(new StrikeBandMember(steps, raw, filtered, splices));
        }

        return (band, error);
    }

    /// <summary>Splits raw into the segments delimited by splices' own timestamps and returns the
    /// LARGEST one by bar count - see DetectPossibleSplices' own doc comment for why "largest", not
    /// "last", is the right one to trust: a genuine anomaly can now show up at either edge of the
    /// window (a too-old contract at the head, or Dhan's own rolling resolution flipping early near
    /// the target contract's real expiry at the tail), and the correct, single-contract data is
    /// whichever side of it is bigger, not always the side closest to the requested expiry.</summary>
    internal static List<(CandleWithVolume Bar, decimal? Strike, decimal? Spot)> TrimToLargestSegment(
        List<(CandleWithVolume Bar, decimal? Strike, decimal? Spot)> raw, IReadOnlyList<PossibleSplice> splices)
    {
        if (splices.Count == 0) return raw;

        List<(CandleWithVolume Bar, decimal? Strike, decimal? Spot)>? best = null;
        var previousCutoff = DateTimeOffset.MinValue;

        foreach (var cutoff in splices.Select(s => s.Time))
        {
            var segment = raw.Where(b => b.Bar.Time >= previousCutoff && b.Bar.Time < cutoff).ToList();
            if (best is null || segment.Count > best.Count) best = segment;
            previousCutoff = cutoff;
        }

        var tail = raw.Where(b => b.Bar.Time >= previousCutoff).ToList();
        if (best is null || tail.Count > best.Count) best = tail;

        return best;
    }

    /// <summary>Drops any bar whose own resolved strike does not match what SPOT AT THAT BAR'S OWN
    /// TIME implies it should be - the direct, per-bar counterpart to Ce/PeResolvedStrike's single
    /// end-of-window check, and the one thing TrimToLargestSegment's splice-based trimming cannot
    /// catch: a bar can be individually wrong without ever producing the sudden jump
    /// DetectPossibleSplices looks for, sitting quietly in the middle of an otherwise-smooth series.
    /// A real run confirmed this shape exactly - a Stop Loss triggered off a premium that never
    /// actually traded, with no splice anywhere near it.
    ///
    /// Prefers a bar's OWN reported Spot (Dhan's "spot" field - the exact underlying price Dhan
    /// itself used to resolve THIS bar's "ATM+-K") when Dhan's response included it: that is exact,
    /// not an approximation, so there is no time-alignment question at all. Only falls back to the
    /// nearest-earlier match against the separately fetched spotBars series (the original mechanism,
    /// still needed for a bar whose response omitted "spot") when a bar's own Spot is null.
    ///
    /// Deliberately compares against spot as of EACH bar's own time, not one fixed reference for the
    /// whole window - a strike legitimately re-centers as ATM moves across the days a wide lookback
    /// spans, and that is not a bug; only a bar that disagrees with what ITS OWN day's ATM implies is
    /// dropped. A bar with no resolved strike at all (Dhan's response omitted the field), or neither
    /// its own Spot nor a spotBars reference yet available, is kept, not dropped - there is nothing to
    /// disprove it with, and this is a targeted removal of bars actively shown to be wrong, not a
    /// blanket "trust nothing unverified" filter.</summary>
    internal static List<(CandleWithVolume Bar, decimal? Strike, decimal? Spot)> FilterToExpectedStrike(
        List<(CandleWithVolume Bar, decimal? Strike, decimal? Spot)> bars, IReadOnlyList<Candle> spotBars, int step, int otmSteps, bool isCall)
    {
        if (step <= 0) return bars;

        var kept = new List<(CandleWithVolume Bar, decimal? Strike, decimal? Spot)>(bars.Count);
        var spotIndex = 0;

        foreach (var entry in bars)
        {
            if (entry.Strike is not { } resolvedStrike)
            {
                kept.Add(entry); // nothing reported to check - can't disprove it
                continue;
            }

            decimal referenceSpot;
            if (entry.Spot is { } ownSpot)
            {
                referenceSpot = ownSpot; // exact - Dhan's own resolution reference for THIS bar
            }
            else
            {
                while (spotIndex + 1 < spotBars.Count && spotBars[spotIndex + 1].Time <= entry.Bar.Time) spotIndex++;

                if (spotBars.Count == 0 || spotBars[spotIndex].Time > entry.Bar.Time)
                {
                    kept.Add(entry); // no spot reference yet available either way - can't disprove it
                    continue;
                }

                referenceSpot = spotBars[spotIndex].Close;
            }

            var expectedAtm = Math.Round(referenceSpot / step) * step;
            var expectedStrike = isCall ? expectedAtm + otmSteps * step : expectedAtm - otmSteps * step;

            if (Math.Abs(resolvedStrike - expectedStrike) <= step / 2m) kept.Add(entry);
        }

        return kept;
    }

    /// <summary>Stitches ONE fixed absolute strike's own continuous candle series from across an
    /// entire fetched band of relative tokens (see FetchStrikeBandAsync) - at every bar time ANY
    /// band member reports, keeps the bar from whichever member's OWN resolved strike actually
    /// matches targetStrike (within step/2, the same tolerance FilterToExpectedStrike uses), so a
    /// trade entered at one specific absolute strike (or a caller inspecting one on the Rolling
    /// Strike Data page) keeps seeing THAT exact contract's own price for as long as ANY fetched
    /// token in the band still reports it - regardless of which relative offset was needed to reach
    /// it on a given day, and regardless of how far the underlying's own ATM has since moved away
    /// from where it was when the strike was chosen. A bar time no band member's resolved strike
    /// matches at all (the index moved further than StrikeBandSteps can reach) simply produces no
    /// candle there - the same "no data for this strike" outcome any other untracked strike already
    /// gets, not a crash or a silently wrong price.
    ///
    /// When more than one band member reports the SAME bar time as a match (possible right at the
    /// edge of two adjacent tokens both resolving near targetStrike that day), the first one
    /// encountered wins - band members are iterated in the same fixed (ascending Steps) order every
    /// time, so this is deterministic, not a source of run-to-run variance.</summary>
    internal static List<CandleWithVolume> BuildFixedStrikeSeries(
        IReadOnlyList<StrikeBandMember> band, decimal targetStrike, int step)
    {
        var merged = new SortedDictionary<DateTimeOffset, CandleWithVolume>();

        foreach (var member in band)
        {
            foreach (var entry in member.Bars)
            {
                if (entry.Strike is not { } resolved || Math.Abs(resolved - targetStrike) > step / 2m) continue;
                merged.TryAdd(entry.Bar.Time, entry.Bar);
            }
        }

        return merged.Values.ToList();
    }

    /// <summary>Reconstructs EmaCrossAtmFlowStrategy's own AtmCeBars/AtmPeBars/ObvCeSeries/
    /// ObvPeSeries/CdvCeSeries/CdvPeSeries from the wide flow-chain band (see FlowChainRadius) - the
    /// data that strategy needs but this class otherwise never computes, since every OTHER strategy
    /// here only ever reads SpotBars + GetOptionBars(strike, isCall).
    ///
    /// AtmCeBars/AtmPeBars: the pure-ATM (Steps == 0) member's own bars - a SNAPSHOT, exactly like
    /// live CdvUnderlyingState.GetAtmClosedCandles is (see BacktestStrategyContext.AtmCeBars' own
    /// doc comment: "whichever strike is ATM right now, its own full stored history" - a known
    /// approximation replayed across a whole multi-day backtest, not something this method changes).
    ///
    /// ObvCeSeries/ObvPeSeries/CdvCeSeries/CdvPeSeries: OBV and CDV are each a delta-weighted SUM
    /// across EVERY member of the band (see CdvUnderlyingState.GetObvSeries's own doc comment -
    /// "summed across every tracked strike"), so reproducing them means feeding every member's own
    /// bars through the SAME offline reconstruction CdvUnderlyingState already exposes for exactly
    /// this purpose (SeedStrikeHistory for OBV's multi-day history, SeedHistoricalDayStrike +
    /// FinalizeHistory for CDV's day-scoped one - the same two paths CdvHostedService itself uses to
    /// backfill a strike's history before its first live tick, just driven here from Dhan's
    /// rolling-option data instead of Dhan's ordinary option-chain one). A scratch CdvUnderlyingState
    /// is built fresh per run and thrown away after - nothing here touches the live one.
    ///
    /// Every bar is registered under a SYNTHETIC strike price (member.Steps * step away from THAT
    /// bar's own resolved ATM) rather than trusting that bar's own resolved "strike" field for the
    /// identity CdvUnderlyingState's own moneyness weighting needs - Dhan's own resolution is
    /// exactly the field this app's whole strike-band mechanism already exists to work around when
    /// it drifts (see FilterToExpectedStrike). This is deliberately PER BAR, not one fixed value for
    /// a member's whole life: a real, in-market run confirmed that pinning it to a single
    /// end-of-window reference (as an earlier version of this method did) manufactures a nonsense
    /// moneyness distance for every earlier day the window's spot has since moved away from,
    /// mis-weighting those bars' volume and firing flow confirmations Backtrack's own live
    /// reconstruction never would - see the per-bar loop below.
    ///
    /// OBV is the one exception: its own moneyness weight uses ONE fixed reference spot for the
    /// WHOLE series (CdvUnderlyingState.LastSpot) rather than each bar's own historical spot - the
    /// same approximation the live OBV path already makes (see its own doc comment) - so pinning its
    /// per-member synthetic strike to that same single end-of-window reference is consistent with
    /// that existing approximation, not a second instance of the CDV bug above.</summary>
    internal static (
        IReadOnlyList<Candle> AtmCeBars, IReadOnlyList<Candle> AtmPeBars,
        IReadOnlyList<ObvPoint> ObvCeSeries, IReadOnlyList<ObvPoint> ObvPeSeries,
        IReadOnlyList<ObvPoint> CdvCeSeries, IReadOnlyList<ObvPoint> CdvPeSeries) BuildFlowChainSeries(
        string underlying, List<StrikeBandMember> ceChain, List<StrikeBandMember> peChain, IReadOnlyList<Candle> spotBars, int step)
    {
        var atmCeBars = ceChain.First(m => m.Steps == 0).Bars.Select(b => b.Bar.ToCandle()).ToList();
        var atmPeBars = peChain.First(m => m.Steps == 0).Bars.Select(b => b.Bar.ToCandle()).ToList();

        if (spotBars.Count == 0 || step <= 0)
            return (atmCeBars, atmPeBars, Array.Empty<ObvPoint>(), Array.Empty<ObvPoint>(), Array.Empty<ObvPoint>(), Array.Empty<ObvPoint>());

        var referenceSpot = spotBars[^1].Close;
        var referenceAtm = Math.Round(referenceSpot / step) * step;

        // Last-write-wins on a duplicate timestamp is harmless - spot never legitimately reports two
        // different closes for the same minute.
        var spotByTime = new Dictionary<DateTimeOffset, decimal>();
        foreach (var bar in spotBars) spotByTime[bar.Time] = bar.Close;

        var cdvState = new CdvUnderlyingState(underlying) { LastSpot = referenceSpot };
        uint nextSyntheticId = 1;

        void Seed(List<StrikeBandMember> chain, bool isCall)
        {
            foreach (var member in chain)
            {
                if (member.Bars.Count == 0) continue;

                var bars = member.Bars.Select(b => b.Bar).ToList();

                // OBV: one fixed representative strike for the member's whole life, matching the
                // live OBV path's own single-LastSpot-weight approximation (see this method's own
                // doc comment) - OBV already accepts one static weight per strike for its ENTIRE
                // series, so which reasonably-representative strike identity is used here does not
                // change that approximation's nature.
                var obvId = nextSyntheticId++;
                cdvState.EnsureTracked(obvId, referenceAtm + member.Steps * step, isCall);
                // OBV's own multi-day history (SeedHistory, called inside regardless of
                // includeInCdvHistory) - CDV itself is seeded separately below, so this never asks
                // for the today-only CDV reconstruction this method also happens to offer.
                cdvState.SeedStrikeHistory(obvId, bars, Array.Empty<CandleWithVolume>(), 0m, includeInCdvHistory: false);

                // CDV: unlike OBV, SeedHistoricalDayStrike already re-weights every bar by ITS OWN
                // historical spot (spotByTime) rather than one fixed reference - pairing that with a
                // strike identity fixed to the END of the window was the actual bug here (confirmed
                // against a real run): a "steps=N" member's bars on an early day are the option that
                // was ACTUALLY N steps from ATM back then (that is what Dhan's own rolling series
                // tracks - the real listed contract behind "ATM+N" changes as spot moves), not N
                // steps from whatever ATM the window happens to end on. Using the stale, window-end
                // strike against that day's own (correct) spot manufactured a moneyness distance
                // that had nothing to do with the contract's real distance from ATM that day,
                // over/under-weighting its volume and producing flow confirmations - and rejections
                // - that would never happen live. Each bar gets its OWN synthetic strike instead,
                // resolved from that bar's own historical spot, one EnsureTracked+
                // SeedHistoricalDayStrike call per bar (SeedHistoricalDayStrike's per-bar increments
                // sum correctly across however many distinct synthetic ids contribute to a given
                // minute, so this doesn't change how days/bars aggregate - only which strike each
                // bar's own delta is weighted against).
                foreach (var entry in member.Bars)
                {
                    var bar = entry.Bar;
                    var barSpot = spotByTime.TryGetValue(bar.Time, out var atBar) && atBar > 0 ? atBar : referenceSpot;
                    var barAtm = Math.Round(barSpot / step) * step;

                    var cdvId = nextSyntheticId++;
                    cdvState.EnsureTracked(cdvId, barAtm + member.Steps * step, isCall);
                    cdvState.SeedHistoricalDayStrike(cdvId, new List<CandleWithVolume> { bar }, spotByTime, referenceSpot);
                }
            }
        }

        Seed(ceChain, true);
        Seed(peChain, false);
        cdvState.FinalizeHistory();

        return (
            atmCeBars, atmPeBars,
            cdvState.GetObvSeries(true), cdvState.GetObvSeries(false),
            cdvState.GetSmoothedCdvSeries(true), cdvState.GetSmoothedCdvSeries(false));
    }

    /// <summary>Whether the returned series genuinely stays on ONE single contract for the whole
    /// requested window, or Dhan's own rolling resolution splices between several as the range
    /// crosses their individual expiries, is NOT something Dhan's docs state outright - the
    /// endpoint's very existence (returning ONE continuous series over an arbitrary date range
    /// rather than requiring one call per specific contract) is exactly the point of a "rolling"
    /// product, so it is plausible the series is stitched from more than one real contract when the
    /// window is wide enough to span more than one expiry cycle.
    ///
    /// This is the one thing that can be checked directly from the data itself without Dhan
    /// confirming anything: a real option's own premium decays/moves continuously toward its own
    /// expiry - it does not suddenly multiply several-fold from one minute to the next. A splice
    /// from an old, nearly-worthless, about-to-expire contract onto a fresh one (or vice versa) is
    /// exactly the shape that WOULD produce such a jump, so a handful of large consecutive-bar
    /// jumps is strong first-hand evidence the window crossed a contract boundary, even though its
    /// absence is not proof it didn't (a smooth-enough transition is not impossible, just unlikely
    /// for a real premium).
    ///
    /// A real run confirmed this ratio check ALONE has a false-positive mode: a deep-OTM strike in
    /// its final hour before expiry can genuinely swing several-fold on an almost-zero base (e.g.
    /// 0.50 -> 2.50 is a 5x "splice-looking" ratio on a real, tiny, single-contract premium as
    /// gamma reacts to spot in the last few minutes) - trimming the ENTIRE rest of the series away
    /// on a jump that was never a splice at all. A genuine splice, per the doc comment above, is a
    /// near-worthless about-to-expire print landing next to a FRESH contract's own opening premium -
    /// a fresh contract carries meaningfully more absolute time value than a few rupees, so an
    /// ABSOLUTE floor on top of the ratio (both must hold) filters the OTM false-positive case
    /// without weakening real-splice detection: every genuine splice this app has actually seen
    /// (see the test suite's own worked examples) clears this floor by a wide margin.
    ///
    /// A SEPARATE real run then surfaced a large-magnitude jump (tens of rupees, comfortably past
    /// the absolute floor above) that was NOT a false positive from a tiny premium - it showed up
    /// consistently in the FINAL hour before close, on the TARGET contract's own real expiry date,
    /// regardless of month or strike moneyness (OTM and ITM alike). The likely explanation: Dhan's
    /// own rolling resolution appears to flip which contract is "current" sometime before that
    /// day's actual 3:30pm close, so the tail end of a window that ends on expiry day itself can
    /// genuinely be the NEXT contract's opening data, not the target's. This is a real splice, not a
    /// detection bug - what needed fixing was TrimToLargestSegment's caller-side assumption that the
    /// segment nearest the requested expiry is always the correct one to keep (see its own doc
    /// comment for why that is no longer true).
    ///
    /// A THIRD, much more damaging bug: this check never excluded the OVERNIGHT gap between one
    /// trading day's own last bar and the NEXT day's own first bar. A real option's premium
    /// genuinely CAN move several-fold overnight (theta decay through a non-trading gap, or the
    /// underlying itself gapping) - completely normal, and nothing like a contract splice, but
    /// indistinguishable from one by a check that only looks at consecutive ARRAY entries with no
    /// notion of calendar days. Across a multi-day window this fired on ordinary overnight gaps
    /// again and again, and since TrimToLargestSegment can only ever keep ONE contiguous run,
    /// "splitting" the series into one segment per trading day left just whichever single day
    /// happened to have the most bars - every OTHER day's signals finding no option data at all
    /// (BacktestTrade.NoData), even though the underlying multi-day fetch itself was fine. A
    /// consecutive-bar comparison is only ever meaningful WITHIN the same trading day - an overnight
    /// gap is checked for nothing here, the same way this method already ignores a zero/negative
    /// price rather than reading it as an infinite jump.</summary>
    internal static List<PossibleSplice> DetectPossibleSplices(IReadOnlyList<CandleWithVolume> bars)
    {
        const decimal SuspiciousRatio = 3m;
        const decimal MinimumAbsoluteJump = 5m;
        var splices = new List<PossibleSplice>();

        for (var i = 1; i < bars.Count && splices.Count < 10; i++)
        {
            var previousBar = bars[i - 1];
            var thisBar = bars[i];
            if (IstClock.IstDate(previousBar.Time) != IstClock.IstDate(thisBar.Time)) continue;

            var previousClose = previousBar.Close;
            var thisOpen = thisBar.Open;
            if (previousClose <= 0 || thisOpen <= 0) continue;
            if (Math.Abs(thisOpen - previousClose) < MinimumAbsoluteJump) continue;

            var ratio = thisOpen >= previousClose ? thisOpen / previousClose : previousClose / thisOpen;
            if (ratio >= SuspiciousRatio) splices.Add(new PossibleSplice(thisBar.Time, previousClose, thisOpen));
        }

        return splices;
    }
}

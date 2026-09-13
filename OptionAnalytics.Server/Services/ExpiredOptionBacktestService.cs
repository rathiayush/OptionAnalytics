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
///     than falling back to that degraded shape.
///   - The OPTION premium comes from Dhan's rolling-option endpoint (DhanRollingOptionDataService) -
///     the only way to reach an expired contract's own price history at all.
///
/// Only strategies whose ENTIRE signal and pricing logic reads spot bars plus ONE CE/PE strike
/// relative to ATM are supported (see SupportedStrategyKeys) - EmaCrossAtmFlowStrategy needs OBV/
/// CDV computed across the WHOLE surrounding strike chain (see BacktestStrategyContext.
/// ObvCeSeries/CdvCeSeries), which would need ~17 separate rolling-option calls per side per run;
/// unsupported here rather than built on synthetic/empty flow series that would silently never
/// confirm a trade.
///
/// GetOptionBars/GetOptionBarsOneMinute below ignore the actual "strike" value a strategy passes
/// in and always return the one relative-strike series this run fetched - which is correct, not an
/// approximation: OptionTradeSimulator computes that argument as "ATM at the signal's own time +-
/// otmSteps", and the rolling-option endpoint was asked for exactly that same relative position
/// ("ATM+otmSteps" for the call leg, "ATM-otmSteps" for the put leg), re-resolved by Dhan itself as
/// spot moves through the window. Different runs use different otmSteps, so a new run always
/// re-fetches rather than serving stale strikes from a previous one.
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
    private static readonly HashSet<string> SupportedStrategyKeys = new() { "five-ema", "five-ema-v2" };

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

    private readonly DhanSpotInstrumentMaster _instrumentMaster;
    private readonly DhanHistoricalDataService _historicalData;
    private readonly DhanRollingOptionDataService _rollingOption;
    private readonly IReadOnlyDictionary<string, IBacktestStrategy> _strategies;

    public ExpiredOptionBacktestService(
        DhanSpotInstrumentMaster instrumentMaster,
        DhanHistoricalDataService historicalData,
        DhanRollingOptionDataService rollingOption,
        IEnumerable<IBacktestStrategy> strategies)
    {
        _instrumentMaster = instrumentMaster;
        _historicalData = historicalData;
        _rollingOption = rollingOption;
        _strategies = strategies.Where(s => SupportedStrategyKeys.Contains(s.Key)).ToDictionary(s => s.Key);
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
        CancellationToken cancellationToken)
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

        var (spotBarsForChart, spotError) = await _historicalData.GetIntradayCandlesAsync(instrument.SecurityId, instrument.DhanSegment, chartFromDay, chartToDay, 1, cancellationToken);
        var spotBars1m = spotBarsForChart.Where(b => IstClock.IstDate(b.Time) >= fromDay && IstClock.IstDate(b.Time) <= toDay).ToList();
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
        // BuildFetchSegments), not just each side as a whole.
        var (ceRaw, ceError) = await FetchAcrossSegmentsAsync(instrument.SecurityId, expiryFlag, segments, ceStrike, "CALL", cancellationToken);
        var (peRaw, peError) = await FetchAcrossSegmentsAsync(instrument.SecurityId, expiryFlag, segments, peStrike, "PUT", cancellationToken);

        var ceBars1m = ceRaw.Select(b => b.Bar).ToList();
        var peBars1m = peRaw.Select(b => b.Bar).ToList();
        var ceSplices = DetectPossibleSplices(ceBars1m);
        var peSplices = DetectPossibleSplices(peBars1m);

        // A wide lookback's returned series COULD genuinely be several real contracts spliced end to
        // end - but a real run confirmed a splice showing up somewhere other than the head of the
        // window too: right in the FINAL hour before close, ON the target contract's own real expiry
        // date, regardless of month or how far OTM/ITM the strike was. Keeping "everything after the
        // last splice" - the original assumption, when a too-wide lookback crossing into an OLDER
        // contract was the only failure mode this had ever seen - is exactly backwards for that case:
        // it kept a sliver of a few dozen bars and threw away the entire correct series. Keeping the
        // LARGEST contiguous segment between splices (or a splice and either edge) instead handles
        // both shapes with one rule: a genuine older-contract splice near the head still leaves the
        // correct, nearer-to-expiry segment as the larger one; a corrupted tail sliver near close
        // leaves the correct, earlier segment as the larger one. A signal whose time falls outside
        // the kept segment simply finds no option bars (BacktestTrade.NoData), the same outcome this
        // app already reports for any other strike with no tracked history, rather than silently
        // pricing it off the wrong contract.
        var ceUsedRaw = TrimToLargestSegment(ceRaw, ceSplices);
        var peUsedRaw = TrimToLargestSegment(peRaw, peSplices);

        // A confirmed real bug this catches that TrimToLargestSegment's splice-based trimming
        // cannot: a bar whose own resolved strike quietly drifted away from what spot at that EXACT
        // bar's own time implies it should be - no sudden jump for DetectPossibleSplices to see, just
        // a wrong value sitting in the middle of an otherwise-smooth series. A real run showed
        // exactly this shape: a Stop Loss triggered off a premium that never actually traded, on a
        // bar whose own resolved strike did not match what spot said at that instant. Judged against
        // spot AT EACH BAR'S OWN TIME (not one fixed reference for the whole window), so this does
        // NOT flag the ordinary, expected case of a strike legitimately re-centering as ATM moves
        // across the days in a wide lookback - only a bar that disagrees with its OWN day's ATM.
        ceUsedRaw = FilterToExpectedStrike(ceUsedRaw, spotBars1m, step, otmSteps, isCall: true);
        peUsedRaw = FilterToExpectedStrike(peUsedRaw, spotBars1m, step, otmSteps, isCall: false);

        var ceUsed = ceUsedRaw.Select(b => b.Bar).ToList();
        var peUsed = peUsedRaw.Select(b => b.Bar).ToList();

        // What strike Dhan itself actually resolved "ATM+-K" to, versus what this app expected from
        // its own real spot - the direct check for a mismatched contract resolution rather than a
        // genuinely-priced but merely surprising premium. Read off the LAST bar (closest to expiry,
        // most representative of "the ATM this run cared about") rather than averaging across a
        // series that may itself have re-centered as spot moved through the window.
        var ceResolvedStrike = ceUsedRaw.LastOrDefault(b => b.Strike is > 0).Strike;
        var peResolvedStrike = peUsedRaw.LastOrDefault(b => b.Strike is > 0).Strike;
        var spotDuringUsedWindow = ceUsed.Count > 0 ? spotBars1m.Where(b => b.Time >= ceUsed[0].Time).ToList() : spotBars1m;
        var referenceSpot = spotDuringUsedWindow.Count > 0 ? spotDuringUsedWindow[^1].Close : spotBars1m[^1].Close;
        var referenceAtm = step > 0 ? Math.Round(referenceSpot / step) * step : referenceSpot;
        var ceExpectedStrike = referenceAtm + otmSteps * step;
        var peExpectedStrike = referenceAtm - otmSteps * step;

        var timeframe = Math.Max(1, timeframeMinutes);
        var ceCandles1m = ceUsed.Select(c => c.ToCandle()).ToList();
        var peCandles1m = peUsed.Select(c => c.ToCandle()).ToList();
        var ceCandlesTf = BacktestUtil.AggregateCandles(ceCandles1m, timeframe);
        var peCandlesTf = BacktestUtil.AggregateCandles(peCandles1m, timeframe);

        // The WIDER (chartFromDay..chartToDay) series, not spotBars1m - what the page's own chart
        // plots, so the padding around the lookback window this method fetched actually reaches it.
        var spotChartCandlesTf = BacktestUtil.AggregateCandles(spotBarsForChart, timeframe);

        var context = new BacktestStrategyContext
        {
            Underlying = underlying,
            TimeframeMinutes = timeframe,
            Step = step,
            SpotBars = BacktestUtil.AggregateCandles(spotBars1m, timeframe),
            SpotBarsOneMinute = spotBars1m,
            ConfluenceSignalsAscending = Array.Empty<BacktestSignal>(),
            AllSignals = Array.Empty<BacktestSignal>(),
            ObvCeSeries = Array.Empty<ObvPoint>(),
            ObvPeSeries = Array.Empty<ObvPoint>(),
            CdvCeSeries = Array.Empty<ObvPoint>(),
            CdvPeSeries = Array.Empty<ObvPoint>(),
            // Ignores the strike argument on purpose - see this class's own doc comment.
            GetOptionBars = (_, isCall) => isCall ? ceCandlesTf : peCandlesTf,
            GetOptionBarsOneMinute = (_, isCall) => isCall ? ceCandles1m : peCandles1m,
            AtmCeBars = Array.Empty<Candle>(),
            AtmPeBars = Array.Empty<Candle>(),
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
            spotChartCandlesTf);
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
    /// all) using the ATM AS OF <paramref name="expiryDate"/>'s own window (a few real days of spot
    /// ending at toDay), NOT today's current spot - converting against today's price for a date that
    /// may be weeks or months in the past would round to a strike offset several steps away from the
    /// one that actually existed back then, which is a wrong-contract bug of this app's OWN making
    /// rather than anything Dhan itself did.</summary>
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

        var resolvedOtmSteps = otmSteps;
        if (absoluteStrike is { } strikeValue)
        {
            var step = StrikeStepByUnderlying[underlying];
            // A few days of REAL spot ending at toDay - the ATM this contract actually traded
            // against back then, not whatever spot happens to be right now (see this method's own
            // doc comment for why that distinction matters).
            var referenceFromDay = toDay.AddDays(-5);
            var (referenceSpotBars, referenceSpotError) = await _historicalData.GetIntradayCandlesAsync(
                instrument.SecurityId, instrument.DhanSegment, referenceFromDay, toDay, 1, cancellationToken);
            if (referenceSpotBars.Count == 0)
                return RollingOptionChartResult.Failed(
                    $"Could not resolve a reference spot price near {toDay:dd MMM yyyy} to convert {strikeValue:0.##} into a strike offset - {referenceSpotError ?? "no spot history in that window"}.");

            var referenceSpot = referenceSpotBars[^1].Close;
            var referenceAtm = step > 0 ? Math.Round(referenceSpot / step) * step : referenceSpot;
            var absoluteToken = step > 0 ? (int)Math.Round((strikeValue - referenceAtm) / step, MidpointRounding.AwayFromZero) : 0;
            // The token is symmetric in ABSOLUTE terms - "ATM+2" names the same real strike whether
            // asking for the CE or PE sitting at it - so this cancels back out via the same isCall
            // sign flip below, the same way RunAsync's own ceStrike/peStrike do for a shared
            // otmSteps; nothing extra needed here beyond computing the plain absolute offset.
            resolvedOtmSteps = isCall ? absoluteToken : -absoluteToken;
        }

        // Same sign convention RunAsync itself uses: otmSteps is "how far OTM for the side actually
        // being looked at", negated for PE since OTM sits BELOW spot for a put but above it for a
        // call - see StrikeToken/RunAsync's own ceStrike/peStrike computation.
        var strikeToken = StrikeToken(isCall ? resolvedOtmSteps : -resolvedOtmSteps);
        var optionType = isCall ? "CALL" : "PUT";

        var (raw, error) = await FetchAcrossSegmentsAsync(instrument.SecurityId, expiryFlag, segments, strikeToken, optionType, cancellationToken);
        var bars = raw.Select(b => b.Bar).ToList();
        var splices = DetectPossibleSplices(bars);

        return new RollingOptionChartResult(
            true, error, strikeToken, optionType, effectiveLookbackDays,
            raw.Select(b => new RollingOptionChartBar(b.Bar.Time, b.Bar.Open, b.Bar.High, b.Bar.Low, b.Bar.Close, b.Bar.Volume, b.Strike)).ToList(),
            splices, absoluteStrike);
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
    private async Task<(List<(CandleWithVolume Bar, decimal? Strike)> Bars, string? Error)> FetchAcrossSegmentsAsync(
        uint underlyingSecurityId, string expiryFlag, IReadOnlyList<FetchSegment> segments, string strikeToken, string optionType,
        CancellationToken cancellationToken)
    {
        var bars = new List<(CandleWithVolume Bar, decimal? Strike)>();
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

    /// <summary>Splits raw into the segments delimited by splices' own timestamps and returns the
    /// LARGEST one by bar count - see DetectPossibleSplices' own doc comment for why "largest", not
    /// "last", is the right one to trust: a genuine anomaly can now show up at either edge of the
    /// window (a too-old contract at the head, or Dhan's own rolling resolution flipping early near
    /// the target contract's real expiry at the tail), and the correct, single-contract data is
    /// whichever side of it is bigger, not always the side closest to the requested expiry.</summary>
    internal static List<(CandleWithVolume Bar, decimal? Strike)> TrimToLargestSegment(
        List<(CandleWithVolume Bar, decimal? Strike)> raw, IReadOnlyList<PossibleSplice> splices)
    {
        if (splices.Count == 0) return raw;

        List<(CandleWithVolume Bar, decimal? Strike)>? best = null;
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
    /// Deliberately compares against spot as of EACH bar's own time (the nearest spot bar at or
    /// before it), not one fixed reference for the whole window - a strike legitimately re-centers
    /// as ATM moves across the days a wide lookback spans, and that is not a bug; only a bar that
    /// disagrees with what ITS OWN day's ATM implies is dropped. A bar with no resolved strike at all
    /// (Dhan's response omitted the field) or no spot reference yet available is kept, not dropped -
    /// there is nothing to disprove it with, and this is a targeted removal of bars actively shown to
    /// be wrong, not a blanket "trust nothing unverified" filter.</summary>
    internal static List<(CandleWithVolume Bar, decimal? Strike)> FilterToExpectedStrike(
        List<(CandleWithVolume Bar, decimal? Strike)> bars, IReadOnlyList<Candle> spotBars, int step, int otmSteps, bool isCall)
    {
        if (step <= 0 || spotBars.Count == 0) return bars;

        var kept = new List<(CandleWithVolume Bar, decimal? Strike)>(bars.Count);
        var spotIndex = 0;

        foreach (var entry in bars)
        {
            while (spotIndex + 1 < spotBars.Count && spotBars[spotIndex + 1].Time <= entry.Bar.Time) spotIndex++;

            if (spotBars[spotIndex].Time > entry.Bar.Time || entry.Strike is not { } resolvedStrike)
            {
                kept.Add(entry); // no spot reference yet, or nothing reported to check - can't disprove it
                continue;
            }

            var expectedAtm = Math.Round(spotBars[spotIndex].Close / step) * step;
            var expectedStrike = isCall ? expectedAtm + otmSteps * step : expectedAtm - otmSteps * step;

            if (Math.Abs(resolvedStrike - expectedStrike) <= step / 2m) kept.Add(entry);
        }

        return kept;
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

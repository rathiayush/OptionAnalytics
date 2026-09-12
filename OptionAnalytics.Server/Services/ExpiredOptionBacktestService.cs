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
/// This app never needs "far" or even "next" as Dhan's own docs frame them: it always sends 1, and
/// gets the SPECIFIC contract the caller asked for by choosing fromDate instead - anchored to just
/// after the PREVIOUS contract's own expiry (see MaxLookbackDays), so that whatever expiry comes
/// "next" after fromDate can only be the one the caller actually wants. This is also what fixed the
/// contract-splicing a wide, undifferentiated lookback used to cause: a window that can never reach
/// past the prior contract's own expiry cannot roll onto it in the first place.</summary>
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

    /// <summary>Dhan's own "next expiry from fromDate" resolution (see this class's own doc
    /// comment) - always 1, never a caller-supplied or derived value. There is no reason for this
    /// app to ask for "far" (code 2): a run only ever wants one specific contract, and the exact
    /// one is chosen through fromDate's own anchor point instead.</summary>
    private const int ExpiryCode = 1;

    /// <summary>How far back GetAvailableExpiries offers dates for - see ExpiryCalendar's own doc
    /// comment for why this app cannot defensibly claim accuracy further back than the current
    /// Tuesday-expiry convention has been in effect (SEBI's November 2024 rule).</summary>
    private const int CalendarMonthsBack = 12;

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
    /// Descending (most recent first), since a recent expiry is usually the more useful default.
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

        var candidates = string.Equals(expiryFlag, "MONTH", StringComparison.OrdinalIgnoreCase)
            ? ExpiryCalendar.MonthlyExpiries(rangeStart, today)
            : ExpiryCalendar.WeeklyExpiries(rangeStart, today);

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

        // A no-op once SpotFeedHostedService's own startup resolve has already loaded the shared
        // instance (see EnsureLoadedAsync's freshness check) - only actually downloads/parses
        // anything on a cold request that beat that background resolve to it.
        await _instrumentMaster.EnsureLoadedAsync(cancellationToken);

        var instrument = _instrumentMaster.FindSpot(underlying);
        if (instrument is null)
            return ExpiredBacktestResult.Failed($"Could not resolve {underlying}'s Dhan security id yet - the scrip master may still be loading. Try again shortly.");

        // Clamped comfortably below the cadence's own real cycle length (see MaxLookbackDays) so
        // fromDay can never reach back far enough to land inside the PREVIOUS contract's own life -
        // that is what makes expiryCode=1 ("the next expiry from fromDay") resolve unambiguously to
        // THIS contract, every time, regardless of how many days of it are actually requested.
        var effectiveLookbackDays = Math.Clamp(lookbackDays, 1, MaxLookbackDays(expiryFlag));
        var toDay = expiryDate;
        var fromDay = expiryDate.AddDays(-effectiveLookbackDays);

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
        // makes on the same, single, paced cadence.
        var (ceRaw, ceError) = await _rollingOption.GetRollingOptionCandlesAsync(instrument.SecurityId, expiryFlag, ExpiryCode, ceStrike, "CALL", fromDay, toDay, 1, cancellationToken);
        var (peRaw, peError) = await _rollingOption.GetRollingOptionCandlesAsync(instrument.SecurityId, expiryFlag, ExpiryCode, peStrike, "PUT", fromDay, toDay, 1, cancellationToken);

        var ceBars1m = ceRaw.Select(b => b.Bar).ToList();
        var peBars1m = peRaw.Select(b => b.Bar).ToList();
        var ceSplices = DetectPossibleSplices(ceBars1m);
        var peSplices = DetectPossibleSplices(peBars1m);

        // Confirmed, not just theoretical (see DhanRollingOptionDataService's own doc comment): a
        // wide lookback's returned series can genuinely be several real contracts spliced end to
        // end, only the LAST of which is the one nearest the requested expiry. Trimming to the
        // segment after the last detected splice is what makes the strategy actually run against
        // just that one contract - a signal from BEFORE the trim point simply finds no option bars
        // (BacktestTrade.NoData), the same outcome this app already reports for any other strike
        // with no tracked history, rather than silently pricing it off the wrong contract.
        var ceUsedRaw = ceSplices.Count > 0 ? ceRaw.Where(b => b.Bar.Time >= ceSplices[^1]).ToList() : ceRaw;
        var peUsedRaw = peSplices.Count > 0 ? peRaw.Where(b => b.Bar.Time >= peSplices[^1]).ToList() : peRaw;
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

    private static string StrikeToken(int steps) => steps == 0 ? "ATM" : $"ATM{(steps > 0 ? "+" : "")}{steps}";

    /// <summary>How many days back of the target contract's own life fromDay may safely reach,
    /// without risking crossing into the PREVIOUS contract's own expiry - see this class's own doc
    /// comment for why that matters (it is what makes expiryCode=1 unambiguous). Set comfortably
    /// under each cadence's real cycle length (7 days weekly, ~28-31 monthly) rather than right up
    /// against it, since a holiday can shift an individual expiry by a day or two either way.</summary>
    internal static int MaxLookbackDays(string expiryFlag) =>
        string.Equals(expiryFlag, "MONTH", StringComparison.OrdinalIgnoreCase) ? 25 : 5;

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
    /// for a real premium).</summary>
    internal static List<DateTimeOffset> DetectPossibleSplices(IReadOnlyList<CandleWithVolume> bars)
    {
        const decimal SuspiciousRatio = 3m;
        var splices = new List<DateTimeOffset>();

        for (var i = 1; i < bars.Count && splices.Count < 10; i++)
        {
            var previousClose = bars[i - 1].Close;
            var thisOpen = bars[i].Open;
            if (previousClose <= 0 || thisOpen <= 0) continue;

            var ratio = thisOpen >= previousClose ? thisOpen / previousClose : previousClose / thisOpen;
            if (ratio >= SuspiciousRatio) splices.Add(bars[i].Time);
        }

        return splices;
    }
}

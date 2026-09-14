using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// EmaCrossAtmConfirmStrategy's own entry rule (spot's fast/slow EMA crosses, AND the pure ATM
/// option on that side makes the same cross on its own premium within a short window - optionally
/// also requiring the opposite leg to cross the other way), but with a different exit: no
/// take-profit at all, and no per-trade stop-loss either - just an optional MAXIMUM stop-loss safety
/// net (see maxSlPoints below). WITHIN a day, a position stays open until the OPPOSITE side confirms
/// the same way, at which point it closes AND immediately flips into the new direction from that
/// same instant - always in the market, intraday. Added at the user's own explicit request: "spot
/// crossover for bull, ATM also crossover for bull, we enter bull, but as soon as spot and ATM
/// breakdown we close bull but will enter bear" - no target, no ordinary stop, the opposite signal
/// is the only INTENDED exit.
///
/// Refinements the user asked for after the first version shipped:
///   - "Candle close is important": a cross now requires the candle to have actually CLOSED beyond
///     BOTH EMAs (EmaCrossoverDetector.ConfirmedDirectionSeries' own rule - the same noise filter
///     every live alert in this app already uses), not just the fast/slow EMA order flipping on a
///     single tick the way EmaCrossAtmFlowStrategy.CrossedUp checks it. In a flat/choppy stretch the
///     two EMAs can swap order on noise alone while price never really leaves their neighborhood -
///     this strategy is in the market for as long as a day's own signals keep it there, so a bare
///     order-flip whipsaw here is costlier than for a strategy that would have exited on its own
///     stop/target anyway. Kept as this class's OWN cross detection (ConfirmedCrossedUp/
///     ConfirmedCrossTimes below) rather than changed on the shared EmaCrossAtmFlowStrategy.CrossedUp/
///     EmaCrossAtmConfirmStrategy.CrossTimes helpers, since those two strategies already ship with
///     the simpler rule and were not what was asked to change.
///   - "Max SL should be there": maxSlPoints (0 = off) is a hard safety cap in absolute premium
///     points, checked bar by bar against the CURRENTLY open leg the same way OptionTradeSimulator's
///     own stop-loss is - if breached, the position closes there (ExitReason "MaxStopLoss") and the
///     strategy goes FLAT, waiting for the next confirmed signal in EITHER direction (not
///     automatically reversed the way a real opposite signal is - a safety-net exit is not itself a
///     view on the other direction).
///   - "We can not carry forward trade / we have to cut every day": unlike the first version
///     shipped, a position is FORCE-CLOSED at the end of every trading day (ExitReason "EndOfDay",
///     same name OptionTradeSimulator.Run uses for its own day-close), same "positions never carry
///     overnight" rule every other strategy in this app already follows. The very next trading day
///     starts flat - whichever direction confirms first (bullish or bearish, there is no "already
///     positioned" memory left over from the day before) opens a fresh trade, not necessarily the
///     opposite of what was cut.
///
/// Built as its own trade-construction loop rather than reusing OptionTradeSimulator.Run: Run's
/// rules (one position per day, but a signal arriving while a trade is still open is simply
/// SKIPPED rather than closing and reopening it) are still wrong for this strategy even with the
/// daily cut added back - the whole point INTRADAY is that the very next opposite signal is the one
/// thing allowed to end a trade on its own and must also open the next one in the same step, not be
/// dropped as "still busy". A same-direction signal while already positioned that way is dropped
/// instead - there is nothing to reverse into.
///
/// Only ever reads SpotBars plus GetOptionBars(strike, isCall), the same narrow contract
/// EmaCrossAtmConfirmStrategy relies on, so this runs on both Backtrack and Expired Backtest.
/// </summary>
public sealed class EmaCrossAtmReversalStrategy : IBacktestStrategy
{
    public string Key => "ema-cross-atm-reversal";
    public string Name => "EMA Crossover + ATM Reversal (no overnight carry)";
    public string Description => "Enters when spot's fast EMA crosses its slow EMA AND the pure ATM option on that side makes the same upward cross on its own premium within a short window - a cross means the candle actually CLOSED beyond both EMAs, not just the EMA order flipping. No take-profit and no ordinary stop-loss - just an optional maximum stop-loss safety net. The position stays open until the OPPOSITE side confirms the same way (it then closes and immediately flips into the new direction) or the trading day ends, whichever comes first - positions never carry overnight, and the next day starts flat.";

    private const decimal FlagOff = 0;
    private const decimal FlagOn = 1;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        new BacktestParameterSpec("otmSteps", "Strike to TRADE, steps from ATM (confirmation always checks pure ATM)", Default: 0, Min: -8, Max: 8, Step: 1),
        new BacktestParameterSpec("maxSlPoints", "Maximum stop loss (points, 0 = off)", Default: 100, Min: 0, Max: 2000, Step: 1),
        OptionTradeSimulator.SignalStartTimeParameter(),
        OptionTradeSimulator.ExcludeLastDaysParameter(),
        new BacktestParameterSpec("fastEmaPeriod", "Fast EMA (bars)", Default: 9, Min: 1, Max: 200, Step: 1),
        new BacktestParameterSpec("slowEmaPeriod", "Slow EMA (bars)", Default: 21, Min: 2, Max: 400, Step: 1),
        new BacktestParameterSpec("atmConfirmWithinBars", "ATM cross must land within (bars, 0 = same bar)", Default: 3, Min: 0, Max: 50, Step: 1),
        new BacktestParameterSpec("requireOppositeLegConfirm", "Also require the opposite leg to cross the other way", Default: FlagOff, Min: FlagOff, Max: FlagOn, Step: 1, Options: new[]
        {
            new BacktestParameterOption(FlagOn, "Yes - stricter (both legs must agree)"),
            new BacktestParameterOption(FlagOff, "No - same-leg confirmation only"),
        }),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Trades;

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private (IReadOnlyList<BacktestTrade> Trades, IReadOnlyList<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var fastPeriod = (int)parameters["fastEmaPeriod"];
        var slowPeriod = (int)parameters["slowEmaPeriod"];
        var confirmWithin = (int)parameters["atmConfirmWithinBars"];
        var requireOppositeLeg = parameters["requireOppositeLegConfirm"] >= (FlagOff + FlagOn) / 2;
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);
        var excludeLastDays = (int)parameters.GetValueOrDefault("excludeLastDays", 0);
        var isSell = parameters["side"] >= (OptionTradeSimulator.SideBuy + OptionTradeSimulator.SideSell) / 2;
        var otmSteps = (int)parameters["otmSteps"];
        var maxSlPoints = parameters.GetValueOrDefault("maxSlPoints", 0m);
        var step = context.Step;
        var underlying = context.Underlying;
        var sideLabel = isSell ? "Sell" : "Buy";

        var signals = new List<BacktestSignal>();
        var trades = new List<BacktestTrade>();

        if (fastPeriod >= slowPeriod || step <= 0) return (trades, signals);

        var bars = context.SpotBars;
        var spotConfirmed = EmaCrossoverDetector.ConfirmedDirectionSeries(bars, fastPeriod, slowPeriod);
        var window = TimeSpan.FromMinutes((double)Math.Max(0, confirmWithin) * Math.Max(1, context.TimeframeMinutes));

        // One specific absolute strike's own confirmed up/down cross times, computed once per
        // strike encountered and reused - same reasoning and cache shape as EmaCrossAtmConfirmStrategy,
        // just built off ConfirmedCrossTimes (see this class's own doc comment) instead of that
        // strategy's own CrossTimes.
        var ceCrossCache = new Dictionary<decimal, (List<DateTimeOffset> Up, List<DateTimeOffset> Down)>();
        var peCrossCache = new Dictionary<decimal, (List<DateTimeOffset> Up, List<DateTimeOffset> Down)>();

        (List<DateTimeOffset> Up, List<DateTimeOffset> Down) CrossTimesFor(decimal strike, bool isCall)
        {
            var cache = isCall ? ceCrossCache : peCrossCache;
            if (cache.TryGetValue(strike, out var cached)) return cached;

            var optionBars = context.GetOptionBars(strike, isCall);
            var result = (ConfirmedCrossTimes(optionBars, fastPeriod, slowPeriod, wantBullish: true),
                          ConfirmedCrossTimes(optionBars, fastPeriod, slowPeriod, wantBullish: false));
            cache[strike] = result;
            return result;
        }

        var strikeBarsCache = new Dictionary<(decimal Strike, bool IsCall), IReadOnlyList<Candle>>();
        IReadOnlyList<Candle> OptionBarsFor(decimal strike, bool isCall)
        {
            if (!strikeBarsCache.TryGetValue((strike, isCall), out var cached))
                strikeBarsCache[(strike, isCall)] = cached = context.GetOptionBars(strike, isCall);
            return cached;
        }

        // Skips taking a NEW entry this close to expiry (same meaning as everywhere else this
        // parameter appears) - it does not force-close a position already running from before the
        // cutoff, since this strategy has no day-boundary exit to fall back on.
        var excludeFromDay = excludeLastDays > 0 && bars.Count > 0
            ? BacktestUtil.IstDate(bars[^1].Time).AddDays(-(excludeLastDays - 1))
            : (DateOnly?)null;

        // The one leg currently held, if any - see this method's own doc comment. openWalkIndex is
        // how far the max-SL scan (below) has already checked THIS leg's own option bars - it only
        // ever moves forward, reset to 0 whenever a fresh leg opens, so the whole run's worth of
        // max-SL checking is O(bars) total rather than O(bars) PER open position.
        string? openDirection = null;
        var openIsCall = false;
        var openStrike = 0m;
        var openEntryTime = default(DateTimeOffset);
        var openEntryPrice = 0m;
        var openSignalTime = default(DateTimeOffset);
        decimal? openSpotPrice = null;
        var openOptionBars = (IReadOnlyList<Candle>)Array.Empty<Candle>();
        var openWalkIndex = 0;

        void CloseOpenPosition(DateTimeOffset time, decimal price, string reason)
        {
            var optionType = openIsCall ? "CE" : "PE";
            var pnl = isSell ? openEntryPrice - price : price - openEntryPrice;
            trades.Add(new BacktestTrade(underlying, openSignalTime, openDirection!, sideLabel, optionType,
                openStrike, openSpotPrice, openEntryTime, openEntryPrice, time, price, reason, pnl));
            openDirection = null;
        }

        // "We can not carry forward trade / have to cut every day" - forces whatever is open closed
        // the moment a new trading day starts, priced off the OPEN LEG's own last real print
        // STRICTLY before that new day (never a print from the new day itself - this always runs
        // BEFORE the new day's own first bar is otherwise processed). Scans forward from
        // openWalkIndex (never re-scanning bars already checked) so a max-SL breach in yesterday's
        // last few bars still wins over a plain end-of-day close, exactly as it would have
        // intraday - only the FINAL fallback (nothing breached) differs, closing on the day's last
        // print instead of continuing to look for a reversal.
        void CloseAtEndOfDay(DateTimeOffset newDayStartTime)
        {
            Candle? lastOfDay = null;
            while (openWalkIndex < openOptionBars.Count && openOptionBars[openWalkIndex].Time < newDayStartTime)
            {
                var ob = openOptionBars[openWalkIndex];
                openWalkIndex++;
                if (ob.Time <= openEntryTime) continue;

                if (maxSlPoints > 0)
                {
                    var stopPrice = isSell ? openEntryPrice + maxSlPoints : Math.Max(0, openEntryPrice - maxSlPoints);
                    var hit = isSell ? ob.High >= stopPrice : ob.Low <= stopPrice;
                    if (hit) { CloseOpenPosition(ob.Time, stopPrice, "MaxStopLoss"); return; }
                }
                lastOfDay = ob;
            }

            if (lastOfDay is { } last) CloseOpenPosition(last.Time, last.Close, "EndOfDay");
            else CloseOpenPosition(openEntryTime, openEntryPrice, "EndOfDay"); // opened and closed same bar, no further prints
        }

        DateOnly? currentDay = null;

        for (var i = 1; i < bars.Count; i++)
        {
            var bar = bars[i];

            // Nothing carries across an opening gap - a session's first bar can flip the EMA
            // relationship against the last bar of the PREVIOUS day with no real crossover in between.
            var day = BacktestUtil.IstDate(bar.Time);
            var isFirstBarOfDay = currentDay != day;
            currentDay = day;

            if (isFirstBarOfDay && openDirection is not null) CloseAtEndOfDay(bar.Time);
            if (isFirstBarOfDay) continue;

            // Max-SL safety net: scan the currently open leg's own option bars up to (and
            // including) this spot bar's own time, closing it the moment the level is breached -
            // in TIME ORDER relative to spot signal processing below, so whichever happens first
            // (this, or the next confirmed opposite signal) is genuinely what closed the trade.
            if (openDirection is not null && maxSlPoints > 0)
            {
                while (openWalkIndex < openOptionBars.Count && openOptionBars[openWalkIndex].Time <= bar.Time)
                {
                    var ob = openOptionBars[openWalkIndex];
                    openWalkIndex++;
                    if (ob.Time <= openEntryTime) continue; // this bar's own High/Low predates the position

                    var stopPrice = isSell ? openEntryPrice + maxSlPoints : Math.Max(0, openEntryPrice - maxSlPoints);
                    var hit = isSell ? ob.High >= stopPrice : ob.Low <= stopPrice;
                    if (hit)
                    {
                        CloseOpenPosition(ob.Time, stopPrice, "MaxStopLoss");
                        break;
                    }
                }
            }

            if (!ConfirmedCrossedUp(spotConfirmed, i, out var bullish)) continue;

            var direction = bullish ? "Bullish" : "Bearish";
            var summary = $"Spot {fastPeriod}/{slowPeriod} EMA closed beyond both lines, {(bullish ? "bullish" : "bearish")}";

            if (direction == openDirection)
            {
                signals.Add(new BacktestSignal(underlying, bar.Time, "Rejected", direction,
                    $"{summary} - already positioned {direction.ToLowerInvariant()}, nothing to reverse into"));
                continue;
            }

            if (signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes)
            {
                signals.Add(new BacktestSignal(underlying, bar.Time, "Rejected", direction,
                    $"{summary} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
                continue;
            }

            if (excludeFromDay is { } cutoff && day >= cutoff)
            {
                signals.Add(new BacktestSignal(underlying, bar.Time, "Rejected", direction,
                    $"{summary} - skipped, within {excludeLastDays} day(s) of expiry"));
                continue;
            }

            // Pure ATM as of THIS bar - independent of otmSteps, which only decides the strike the
            // trade itself is taken at (same convention as EmaCrossAtmConfirmStrategy).
            var atmStrike = Math.Round(bar.Close / step) * step;
            var sameLegName = bullish ? "CE" : "PE";
            var oppositeLegName = bullish ? "PE" : "CE";

            var (sameUp, _) = CrossTimesFor(atmStrike, bullish);
            if (!EmaCrossAtmFlowStrategy.CrossedWithin(sameUp, bar.Time, window))
            {
                signals.Add(new BacktestSignal(underlying, bar.Time, "Rejected", direction,
                    $"{summary} - but ATM {sameLegName} ({atmStrike:0.##}) made no {fastPeriod}/{slowPeriod} close-confirmed cross of its own within {confirmWithin} bar(s)"));
                continue;
            }

            if (requireOppositeLeg)
            {
                var (_, oppositeDown) = CrossTimesFor(atmStrike, !bullish);
                if (!EmaCrossAtmFlowStrategy.CrossedWithin(oppositeDown, bar.Time, window))
                {
                    signals.Add(new BacktestSignal(underlying, bar.Time, "Rejected", direction,
                        $"{summary}, ATM {sameLegName} confirmed - but ATM {oppositeLegName} made no opposite close-confirmed {fastPeriod}/{slowPeriod} cross within {confirmWithin} bar(s)"));
                    continue;
                }
            }

            // Confirmed - resolve the NEW leg's own strike/pricing at this exact bar before
            // touching whatever is currently open, so a flip prices both sides off the same instant.
            var newIsCall = isSell ? !bullish : bullish;
            var newStrike = newIsCall ? atmStrike + otmSteps * step : atmStrike - otmSteps * step;
            var newOptionBars = OptionBarsFor(newStrike, newIsCall);
            var newIndex = OptionTradeSimulator.FindAt(newOptionBars, bar.Time);

            // Close whatever was open FIRST, priced off ITS OWN leg at this same instant - a real
            // flip sells the old leg and buys the new one at (as close as the data allows to) the
            // same moment, regardless of whether the new leg itself turns out to have data.
            if (openDirection is not null)
            {
                var closeIndex = OptionTradeSimulator.FindAt(openOptionBars, bar.Time);
                if (closeIndex >= 0 && openOptionBars[closeIndex].Close > 0)
                {
                    CloseOpenPosition(bar.Time, openOptionBars[closeIndex].Close, "Reversed");
                }
                else
                {
                    trades.Add(BacktestTrade.NoData(underlying, openSignalTime, openDirection, sideLabel, openIsCall ? "CE" : "PE", openStrike, openSpotPrice));
                    openDirection = null;
                }
            }

            if (newIndex < 0 || newOptionBars[newIndex].Close <= 0)
            {
                var newOptionType = newIsCall ? "CE" : "PE";
                trades.Add(BacktestTrade.NoData(underlying, bar.Time, direction, sideLabel, newOptionType, newStrike, bar.Close));
                signals.Add(new BacktestSignal(underlying, bar.Time, "Rejected", direction,
                    $"{summary}, ATM confirmed - but no data for the {newOptionType} at {newStrike:0.##}"));
                continue; // flat now, waiting for the next confirmed signal in EITHER direction
            }

            var full = requireOppositeLeg
                ? $"{summary}, ATM {sameLegName} crossed up with it, and ATM {oppositeLegName} crossed down - both legs agree"
                : $"{summary}, ATM {sameLegName} crossed up with it";
            signals.Add(new BacktestSignal(underlying, bar.Time, "Entry", direction, full));

            openDirection = direction;
            openIsCall = newIsCall;
            openStrike = newStrike;
            openEntryTime = bar.Time;
            openEntryPrice = newOptionBars[newIndex].Close;
            openSignalTime = bar.Time;
            openSpotPrice = bar.Close;
            openOptionBars = newOptionBars;
            openWalkIndex = 0;
        }

        // Still open once the data runs out - the LAST trading day in the window never got a
        // following day's first bar to trigger CloseAtEndOfDay above. One final max-SL sweep over
        // whatever of the open leg's own bars were never reached by the main loop (its own series
        // can run past the last spot bar checked) first, same as CloseAtEndOfDay's own ordering.
        if (openDirection is not null && maxSlPoints > 0)
        {
            for (; openWalkIndex < openOptionBars.Count; openWalkIndex++)
            {
                var ob = openOptionBars[openWalkIndex];
                if (ob.Time <= openEntryTime) continue;

                var stopPrice = isSell ? openEntryPrice + maxSlPoints : Math.Max(0, openEntryPrice - maxSlPoints);
                var hit = isSell ? ob.High >= stopPrice : ob.Low <= stopPrice;
                if (hit)
                {
                    CloseOpenPosition(ob.Time, stopPrice, "MaxStopLoss");
                    break;
                }
            }
        }

        if (openDirection is not null)
        {
            // Same distinction OptionTradeSimulator.Run's own EndOfDay/Open exit makes: a position
            // opened on a day already fully in the past has unambiguously seen its whole session
            // close out (this run's data simply stops there) and reads as a completed EndOfDay
            // exit, exactly as CloseAtEndOfDay would have made it had there been a following day's
            // first bar to trigger it. Only a position opened TODAY - the still-live, in-progress
            // session - is genuinely unrealized and reported as "Open".
            var reason = BacktestUtil.IstDate(openEntryTime) < BacktestUtil.IstDate(DateTimeOffset.UtcNow) ? "EndOfDay" : "Open";
            var optionType = openIsCall ? "CE" : "PE";
            var lastIndex = openOptionBars.Count - 1;
            if (lastIndex >= 0 && openOptionBars[lastIndex].Time > openEntryTime)
            {
                var lastPrice = openOptionBars[lastIndex].Close;
                var pnl = isSell ? openEntryPrice - lastPrice : lastPrice - openEntryPrice;
                trades.Add(new BacktestTrade(underlying, openSignalTime, openDirection, sideLabel, optionType,
                    openStrike, openSpotPrice, openEntryTime, openEntryPrice, openOptionBars[lastIndex].Time, lastPrice, reason, pnl));
            }
            else
            {
                trades.Add(new BacktestTrade(underlying, openSignalTime, openDirection, sideLabel, optionType,
                    openStrike, openSpotPrice, openEntryTime, openEntryPrice, openEntryTime, openEntryPrice, reason, 0m));
            }
        }

        return (trades.OrderByDescending(t => t.SignalTimeUtc).ToList(), signals);
    }

    /// <summary>True at the bar where <paramref name="confirmedSeries"/> (see
    /// EmaCrossoverDetector.ConfirmedDirectionSeries) settles into a NEW confirmed bias different
    /// from the previous bar's - i.e. the candle has actually closed beyond both EMAs in that
    /// direction, not merely the fast/slow EMA order flipping (EmaCrossAtmFlowStrategy.CrossedUp's
    /// own, looser rule). A transition out of "no confirmed bias" (null) counts too - the first time
    /// a choppy stretch resolves into a real trend is exactly the moment this strategy cares about.</summary>
    internal static bool ConfirmedCrossedUp(IReadOnlyList<(DateTimeOffset Time, string? Direction)> confirmedSeries, int i, out bool bullish)
    {
        bullish = false;
        if (i <= 0 || i >= confirmedSeries.Count) return false;

        var current = confirmedSeries[i].Direction;
        var previous = confirmedSeries[i - 1].Direction;
        if (current is null || current == previous) return false;

        bullish = current == "Bullish";
        return true;
    }

    /// <summary>Every time <paramref name="bars"/>' own confirmed direction (close beyond both
    /// EMAs, not just their order flipping) settled into the WANTED bias - the close-confirmed
    /// counterpart to EmaCrossAtmConfirmStrategy.CrossTimes, built on ConfirmedCrossedUp above
    /// instead of EmaCrossAtmFlowStrategy.CrossedUp.</summary>
    internal static List<DateTimeOffset> ConfirmedCrossTimes(IReadOnlyList<Candle> bars, int fastPeriod, int slowPeriod, bool wantBullish)
    {
        var times = new List<DateTimeOffset>();
        if (bars.Count == 0) return times;

        var series = EmaCrossoverDetector.ConfirmedDirectionSeries(bars, fastPeriod, slowPeriod);

        DateOnly? currentDay = null;
        for (var i = 1; i < series.Count; i++)
        {
            var day = BacktestUtil.IstDate(bars[i].Time);
            var isFirstBarOfDay = currentDay != day;
            currentDay = day;
            if (isFirstBarOfDay) continue; // same overnight-gap rule spot uses

            if (ConfirmedCrossedUp(series, i, out var bullish) && bullish == wantBullish) times.Add(bars[i].Time);
        }

        return times;
    }
}

using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// EmaCrossAtmConfirmStrategy's own entry rule (spot's fast/slow EMA crosses, AND the pure ATM
/// option on that side makes the same cross on its own premium within a short window - optionally
/// also requiring the opposite leg to cross the other way), but with a completely different exit:
/// no stop-loss or take-profit at all. A position stays open - across days if that is how long it
/// takes, unlike every other strategy here (see OptionTradeSimulator's own "positions never carry
/// overnight" rule, deliberately NOT applied here) - until the OPPOSITE side confirms the same way,
/// at which point it closes AND immediately flips into the new direction from that same instant.
/// Always in the market from the first confirmed signal onward. Added at the user's own explicit
/// request: "spot crossover for bull, ATM also crossover for bull, we enter bull, but as soon as
/// spot and ATM breakdown we close bull but will enter bear" - no target, no stop, the opposite
/// signal is the only exit there is.
///
/// Built as its own trade-construction loop rather than reusing OptionTradeSimulator.Run: Run's
/// rules (one position per day, closed by stop/target/square-off/end-of-day, a signal arriving
/// while a trade is still open simply skipped) are all wrong for this strategy - the whole point is
/// that the very NEXT opposite signal, however many days later, is the one thing allowed to end a
/// trade, and it must also open the next one in the same step, not be dropped as "still busy". A
/// same-direction signal while already positioned that way is dropped instead - there is nothing to
/// reverse into.
///
/// Only ever reads SpotBars plus GetOptionBars(strike, isCall), the same narrow contract
/// EmaCrossAtmConfirmStrategy relies on, so this runs on both Backtrack and Expired Backtest.
/// </summary>
public sealed class EmaCrossAtmReversalStrategy : IBacktestStrategy
{
    public string Key => "ema-cross-atm-reversal";
    public string Name => "EMA Crossover + ATM Reversal (always in market)";
    public string Description => "Enters when spot's fast EMA crosses its slow EMA AND the pure ATM option on that side makes the same upward cross on its own premium within a short window - same confirmation as the ATM Confirmation strategy, but with NO stop loss or take profit. The position stays open, across days if needed, until the OPPOSITE side confirms the same way - it then closes and immediately flips into the new direction. Always in the market once the first signal fires.";

    private const decimal FlagOff = 0;
    private const decimal FlagOn = 1;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        new BacktestParameterSpec("otmSteps", "Strike to TRADE, steps from ATM (confirmation always checks pure ATM)", Default: 0, Min: -8, Max: 8, Step: 1),
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

    /// <summary>One leg currently held, tracked as plain locals rather than a record so the main
    /// loop below can mutate it in place bar by bar without allocating a new instance on every
    /// signal - there is only ever at most one at a time anyway.</summary>
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
        var step = context.Step;
        var underlying = context.Underlying;
        var sideLabel = isSell ? "Sell" : "Buy";

        var signals = new List<BacktestSignal>();
        var trades = new List<BacktestTrade>();

        if (fastPeriod >= slowPeriod || step <= 0) return (trades, signals);

        var bars = context.SpotBars;
        var spotFast = EmaCrossoverDetector.EmaSeries(bars, fastPeriod);
        var spotSlow = EmaCrossoverDetector.EmaSeries(bars, slowPeriod);
        var window = TimeSpan.FromMinutes((double)Math.Max(0, confirmWithin) * Math.Max(1, context.TimeframeMinutes));

        // One specific absolute strike's own up/down cross times, computed once per strike
        // encountered and reused - same reasoning and same cache shape as EmaCrossAtmConfirmStrategy.
        var ceCrossCache = new Dictionary<decimal, (List<DateTimeOffset> Up, List<DateTimeOffset> Down)>();
        var peCrossCache = new Dictionary<decimal, (List<DateTimeOffset> Up, List<DateTimeOffset> Down)>();

        (List<DateTimeOffset> Up, List<DateTimeOffset> Down) CrossTimesFor(decimal strike, bool isCall)
        {
            var cache = isCall ? ceCrossCache : peCrossCache;
            if (cache.TryGetValue(strike, out var cached)) return cached;

            var optionBars = context.GetOptionBars(strike, isCall);
            var result = (EmaCrossAtmConfirmStrategy.CrossTimes(optionBars, fastPeriod, slowPeriod, wantBullish: true),
                          EmaCrossAtmConfirmStrategy.CrossTimes(optionBars, fastPeriod, slowPeriod, wantBullish: false));
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
        // cutoff, since this strategy has no other exit mechanism to fall back on.
        var excludeFromDay = excludeLastDays > 0 && bars.Count > 0
            ? BacktestUtil.IstDate(bars[^1].Time).AddDays(-(excludeLastDays - 1))
            : (DateOnly?)null;

        // The one leg currently held, if any - see this method's own doc comment.
        string? openDirection = null;
        var openIsCall = false;
        var openStrike = 0m;
        var openEntryTime = default(DateTimeOffset);
        var openEntryPrice = 0m;
        var openSignalTime = default(DateTimeOffset);
        decimal? openSpotPrice = null;
        var openOptionBars = (IReadOnlyList<Candle>)Array.Empty<Candle>();

        DateOnly? currentDay = null;

        for (var i = 1; i < bars.Count; i++)
        {
            var bar = bars[i];

            // Nothing carries across an opening gap - a session's first bar can flip the EMA
            // relationship against the last bar of the PREVIOUS day with no real crossover in between.
            var day = BacktestUtil.IstDate(bar.Time);
            var isFirstBarOfDay = currentDay != day;
            currentDay = day;
            if (isFirstBarOfDay) continue;

            if (!EmaCrossAtmFlowStrategy.CrossedUp(spotFast, spotSlow, i, out var bullish)) continue;

            var direction = bullish ? "Bullish" : "Bearish";
            var summary = $"Spot {fastPeriod}/{slowPeriod} EMA crossed {(bullish ? "up" : "down")}";

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
                    $"{summary} - but ATM {sameLegName} ({atmStrike:0.##}) made no {fastPeriod}/{slowPeriod} cross of its own within {confirmWithin} bar(s)"));
                continue;
            }

            if (requireOppositeLeg)
            {
                var (_, oppositeDown) = CrossTimesFor(atmStrike, !bullish);
                if (!EmaCrossAtmFlowStrategy.CrossedWithin(oppositeDown, bar.Time, window))
                {
                    signals.Add(new BacktestSignal(underlying, bar.Time, "Rejected", direction,
                        $"{summary}, ATM {sameLegName} confirmed - but ATM {oppositeLegName} made no opposite {fastPeriod}/{slowPeriod} cross within {confirmWithin} bar(s)"));
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
                var closingOptionType = openIsCall ? "CE" : "PE";
                if (closeIndex >= 0 && openOptionBars[closeIndex].Close > 0)
                {
                    var exitPrice = openOptionBars[closeIndex].Close;
                    var pnl = isSell ? openEntryPrice - exitPrice : exitPrice - openEntryPrice;
                    trades.Add(new BacktestTrade(underlying, openSignalTime, openDirection, sideLabel, closingOptionType,
                        openStrike, openSpotPrice, openEntryTime, openEntryPrice, bar.Time, exitPrice, "Reversed", pnl));
                }
                else
                {
                    trades.Add(BacktestTrade.NoData(underlying, openSignalTime, openDirection, sideLabel, closingOptionType, openStrike, openSpotPrice));
                }
                openDirection = null;
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
        }

        // Still open at the end of the window - reported as an unrealized position at its own
        // latest available price, the same "Open" convention OptionTradeSimulator.Run uses for a
        // trade that has not yet met its own exit condition.
        if (openDirection is not null)
        {
            var optionType = openIsCall ? "CE" : "PE";
            var lastIndex = openOptionBars.Count - 1;
            if (lastIndex >= 0 && openOptionBars[lastIndex].Time > openEntryTime)
            {
                var lastPrice = openOptionBars[lastIndex].Close;
                var pnl = isSell ? openEntryPrice - lastPrice : lastPrice - openEntryPrice;
                trades.Add(new BacktestTrade(underlying, openSignalTime, openDirection, sideLabel, optionType,
                    openStrike, openSpotPrice, openEntryTime, openEntryPrice, openOptionBars[lastIndex].Time, lastPrice, "Open", pnl));
            }
            else
            {
                trades.Add(new BacktestTrade(underlying, openSignalTime, openDirection, sideLabel, optionType,
                    openStrike, openSpotPrice, openEntryTime, openEntryPrice, openEntryTime, openEntryPrice, "Open", 0m));
            }
        }

        return (trades.OrderByDescending(t => t.SignalTimeUtc).ToList(), signals);
    }
}

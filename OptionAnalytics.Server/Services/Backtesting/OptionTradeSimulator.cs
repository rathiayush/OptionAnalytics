using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// The shared "given entry signals, what trades result?" engine. Every strategy so far differs only
/// in WHEN it wants to enter - the mechanics after that (which leg to trade, entry at the next
/// bar's open, the points-based stop/target, the day-close exit, one position at a time) are
/// identical, so they live here once instead of being copy-pasted per strategy. A new strategy
/// supplies its own entry signals and gets all of this for free.
///
/// The rules, in one place:
///   - A buyer trades the leg matching the view (bullish -> CE); a seller trades the OPPOSITE leg
///     (bullish -> sell PE), collecting the premium and profiting as it decays.
///   - The strike is StrikeOffset steps from the ATM AS IT WAS AT THE SIGNAL - not whatever is ATM
///     now - so an old signal is judged against the strike it actually pointed at. The offset is
///     signed: positive is OTM for the traded leg, negative ITM, 0 is ATM itself.
///   - Entry is the OPEN of the bar AFTER the one immediately following the signal - not that very
///     next bar's own open. The signal bar's own close is never tradeable in real time (using ITS
///     open would be look-ahead bias), but the bar right after it isn't genuinely tradeable either:
///     this whole app only ever trusts a CLOSED bar (BacktestStrategyContext.GetOptionBars, every
///     state class's GetClosedCandles), so nothing - a live Strategy Trigger or this same replay -
///     can actually confirm "the signal fired" until that immediately-following bar has ALSO
///     closed, one full bar-length later. By the moment that confirmation exists and a live
///     Telegram alert can go out, that bar's own open is already stale; the first price still
///     genuinely open to act on is the one after THAT. Using the earlier, immediately-following
///     bar's open (as this used to) made every alert's own "Entry" price and time something nobody
///     receiving it could actually have gotten - in Backtrack's numbers as much as live.
///   - Stop-loss/take-profit are absolute premium points, and mirror for a seller (target below
///     entry, stop above) since a seller profits as the premium falls. Both are floored at 0 -
///     a premium cannot go negative.
///   - Positions never carry overnight: index option intraday strategies lose most of their
///     remaining time value to theta by the next morning, so anything still open at the day's last
///     bar exits there.
///   - One position at a time: a signal arriving while an earlier trade is still open is skipped,
///     same as a trader who cannot take a second position until the first closes.
///   - A signal whose target strike was never tracked produces a BacktestTrade.NoData row rather
///     than being silently dropped, so the page can show it was skipped and why.
/// </summary>
public static class OptionTradeSimulator
{
    public const decimal SideBuy = 0;
    public const decimal SideSell = 1;

    /// <summary>The two parameter specs every option strategy shares for its exit rules, so they
    /// stay worded and bounded identically across strategies.</summary>
    public static BacktestParameterSpec SideParameter() =>
        new("side", "Position", Default: SideBuy, Min: SideBuy, Max: SideSell, Step: 1, Options: new[]
        {
            new BacktestParameterOption(SideBuy, "Buy option"),
            new BacktestParameterOption(SideSell, "Sell option (opposite leg)"),
        });

    public static BacktestParameterSpec StrikeOffsetParameter() =>
        new("otmSteps", "Strike offset from ATM (+OTM / -ITM)", Default: 1, Min: -8, Max: 8, Step: 1);

    public static BacktestParameterSpec StopLossParameter() =>
        new("slPoints", "Stop loss (points)", Default: 10, Min: 0.05m, Max: 1000, Step: 0.5m);

    public static BacktestParameterSpec TakeProfitParameter() =>
        new("tpPoints", "Take profit (points)", Default: 20, Min: 0.05m, Max: 2000, Step: 0.5m);

    /// <summary>Runs <paramref name="entrySignals"/> (time-ascending; Direction "Bullish"/"Bearish")
    /// through the rules above and returns the resulting trades, most recent first.
    ///
    /// <paramref name="forcedExitTimes"/> (ascending, optional) is for strategies whose exit rule
    /// lives in the UNDERLYING rather than in the option's premium - FiveEmaStrategy's "get out when
    /// spot comes back and touches the 5 EMA" being the case it was added for. An open position
    /// closes at the close of the first bar at or after such a time, after the stop and target have
    /// been checked on that same bar (they are intra-bar price levels; this is an end-of-bar
    /// decision, so it cannot pre-empt them). Strategies without one pass nothing and behave exactly
    /// as before.</summary>
    public static IReadOnlyList<BacktestTrade> Run(
        BacktestStrategyContext context,
        IReadOnlyList<(DateTimeOffset Time, string Direction)> entrySignals,
        IReadOnlyDictionary<string, decimal> parameters,
        IReadOnlyList<DateTimeOffset>? forcedExitTimes = null)
    {
        if (entrySignals.Count == 0) return Array.Empty<BacktestTrade>();

        var isSell = parameters["side"] >= (SideBuy + SideSell) / 2;
        var otmSteps = (int)parameters["otmSteps"];
        var slPoints = parameters["slPoints"];
        var tpPoints = parameters["tpPoints"];

        var side = isSell ? "Sell" : "Buy";
        var underlying = context.Underlying;
        var step = context.Step;
        var spotByTime = context.SpotBars.ToDictionary(b => b.Time, b => b);
        var strikeCandleCache = new Dictionary<(decimal Strike, bool IsCall), IReadOnlyList<Candle>>();

        var trades = new List<BacktestTrade>();
        DateTimeOffset? busyUntil = null;

        foreach (var signal in entrySignals)
        {
            if (busyUntil is { } bu && signal.Time <= bu) continue; // still in an earlier trade

            var isBullish = signal.Direction == "Bullish";
            var isCall = isSell ? !isBullish : isBullish;
            var optionType = isCall ? "CE" : "PE";

            if (!spotByTime.TryGetValue(signal.Time, out var signalSpotBar))
            {
                trades.Add(BacktestTrade.NoData(underlying, signal.Time, signal.Direction, side, optionType, 0, null));
                continue;
            }

            var atmAtSignal = step > 0 ? Math.Round(signalSpotBar.Close / step) * step : signalSpotBar.Close;
            var strike = isCall ? atmAtSignal + otmSteps * step : atmAtSignal - otmSteps * step;

            if (!strikeCandleCache.TryGetValue((strike, isCall), out var optionBars))
            {
                optionBars = context.GetOptionBars(strike, isCall);
                strikeCandleCache[(strike, isCall)] = optionBars;
            }

            // The bar immediately after the signal is the one whose CLOSE confirms the signal even
            // fired (this whole app only ever trusts closed bars) - not itself tradeable, since
            // that confirmation doesn't exist until it's done. The real entry is the bar AFTER
            // that: the first open still genuinely available once the trade is knowable at all -
            // see this method's own doc comment for why.
            var confirmIndex = FindFirstAfter(optionBars, signal.Time);
            var entryIndex = confirmIndex < 0 ? -1 : confirmIndex + 1;
            if (entryIndex < 0 || entryIndex >= optionBars.Count || optionBars[entryIndex].Open <= 0)
            {
                trades.Add(BacktestTrade.NoData(underlying, signal.Time, signal.Direction, side, optionType, strike, signalSpotBar.Close));
                continue;
            }

            var entryBar = optionBars[entryIndex];
            var entryPrice = entryBar.Open;
            var takeProfitPrice = isSell ? Math.Max(0, entryPrice - tpPoints) : entryPrice + tpPoints;
            var stopLossPrice = isSell ? entryPrice + slPoints : Math.Max(0, entryPrice - slPoints);
            var entryDay = BacktestUtil.IstDate(entryBar.Time);

            var exitTime = entryBar.Time;
            var exitPrice = entryBar.Close;
            string? exitReason = null;
            var forcedExit = FirstAtOrAfter(forcedExitTimes, entryBar.Time);

            for (var i = entryIndex; i < optionBars.Count && BacktestUtil.IstDate(optionBars[i].Time) == entryDay; i++)
            {
                var bar = optionBars[i];
                // Conservative when a single bar's range spans both thresholds (a volatile bar
                // right after entry, most likely): check the stop first either way, so the worse
                // outcome for the trade wins rather than guessing which was touched first intra-bar.
                var stopHit = isSell ? bar.High >= stopLossPrice : bar.Low <= stopLossPrice;
                if (stopHit) { exitTime = bar.Time; exitPrice = stopLossPrice; exitReason = "StopLoss"; break; }

                var targetHit = isSell ? bar.Low <= takeProfitPrice : bar.High >= takeProfitPrice;
                if (targetHit) { exitTime = bar.Time; exitPrice = takeProfitPrice; exitReason = "TakeProfit"; break; }

                if (forcedExit is { } fx && bar.Time >= fx)
                {
                    exitTime = bar.Time; exitPrice = bar.Close; exitReason = "SignalExit"; break;
                }

                exitTime = bar.Time;
                exitPrice = bar.Close;
            }

            // The loop above falls through (no break) in two genuinely different situations that
            // must not be reported the same way: entryDay itself ended (its bars ran out because
            // the NEXT day's bars start instead, or - for the very last, still-in-progress trading
            // day - there simply is no next day yet) versus entryDay IS today and we only ran out
            // of bars because the session has not finished yet. The distinction is entryDay's own
            // date, not "did we hit optionBars.Count" - the array shape looks identical either way,
            // only how much more of today has yet to happen differs. A position opened on any
            // earlier day has unambiguously seen its whole session close out (today already exists
            // as a later date, so entryDay's own day is done regardless of exactly why its own bars
            // stopped); a position opened TODAY has not, and reporting it as an "End of Day" exit -
            // with a fixed exit time/price that reads as a completed, realized trade - would be
            // straightforwardly wrong: the position is still open, its P&L is unrealized, and the
            // next evaluation cycle (or day) can still move it before it actually closes.
            exitReason ??= entryDay < BacktestUtil.IstDate(DateTimeOffset.UtcNow) ? "EndOfDay" : "Open";

            busyUntil = exitTime;
            // The seller's P&L is the buyer's inverted: they sold at entry and buy back at exit.
            var pnlPoints = isSell ? entryPrice - exitPrice : exitPrice - entryPrice;

            trades.Add(new BacktestTrade(
                underlying, signal.Time, signal.Direction, side, optionType, strike, signalSpotBar.Close,
                entryBar.Time, entryPrice, exitTime, exitPrice, exitReason, pnlPoints));
        }

        return trades.OrderByDescending(t => t.SignalTimeUtc).ToList();
    }

    /// <summary>The earliest forced-exit time not before <paramref name="time"/> - null when the
    /// strategy supplied none, or when none of them fall after this entry.</summary>
    private static DateTimeOffset? FirstAtOrAfter(IReadOnlyList<DateTimeOffset>? times, DateTimeOffset time)
    {
        if (times is null) return null;
        foreach (var candidate in times)
            if (candidate >= time) return candidate;
        return null;
    }

    private static int FindFirstAfter(IReadOnlyList<Candle> bars, DateTimeOffset time)
    {
        for (var i = 0; i < bars.Count; i++)
        {
            if (bars[i].Time > time) return i;
        }
        return -1;
    }
}

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
///   - Entry is that contract's NEXT bar's open. The signal bar's own close is never tradeable in
///     real time, so entering on it would be look-ahead bias.
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
    /// through the rules above and returns the resulting trades, most recent first.</summary>
    public static IReadOnlyList<BacktestTrade> Run(
        BacktestStrategyContext context,
        IReadOnlyList<(DateTimeOffset Time, string Direction)> entrySignals,
        IReadOnlyDictionary<string, decimal> parameters)
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

            var entryIndex = FindFirstAfter(optionBars, signal.Time);
            if (entryIndex < 0 || optionBars[entryIndex].Open <= 0)
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
            var exitReason = "EndOfDay";

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

                exitTime = bar.Time;
                exitPrice = bar.Close;
            }

            busyUntil = exitTime;
            // The seller's P&L is the buyer's inverted: they sold at entry and buy back at exit.
            var pnlPoints = isSell ? entryPrice - exitPrice : exitPrice - entryPrice;

            trades.Add(new BacktestTrade(
                underlying, signal.Time, signal.Direction, side, optionType, strike, signalSpotBar.Close,
                entryBar.Time, entryPrice, exitTime, exitPrice, exitReason, pnlPoints));
        }

        return trades.OrderByDescending(t => t.SignalTimeUtc).ToList();
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

using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// The original Backtrack trade simulation, now just one IBacktestStrategy implementation among
/// however many get added later: on every Confluence signal, take a position in the CE or PE that
/// was StrikeOffset strikes away from ATM at the moment of the signal - not whatever is ATM right
/// now, so an old signal is judged against the strike it actually pointed at - entered at that
/// contract's own NEXT bar's open (the signal bar's own close is never tradeable in real time, so
/// entering on it would be look-ahead bias), then walked forward bar by bar against a stop-
/// loss/take-profit given in absolute premium points (not a percentage) until one hits or the
/// trading day ends (index option intraday strategies don't carry overnight - held past a day
/// boundary they lose most of their remaining time value to theta decay by next morning, so "still
/// open at day close" exits at that last bar rather than riding into the next day). At most one
/// trade is open at a time - a signal that arrives while an earlier trade is still open is
/// skipped, same as a trader who can't take a second position until the first is closed.
///
/// The "side" parameter picks how the same signal is traded, and the two are mirror images:
///
///   Buy  - express a bullish view by BUYING a CE, a bearish view by BUYING a PE. The position
///          gains as the premium rises, so take-profit sits above entry and stop-loss below, and
///          P&amp;L is exit - entry.
///   Sell - express the same view by SELLING the OPPOSITE leg: bullish sells a PE, bearish sells a
///          CE. The premium is collected up front and the position gains as it DECAYS, so the two
///          thresholds swap sides (take-profit below entry, stop-loss above) and P&amp;L is
///          entry - exit.
///
/// StrikeOffset is signed and always measured on the traded leg's own OTM side: positive moves OTM
/// (a higher strike for a CE, a lower one for a PE - so a sold CE moves further above spot and a
/// sold PE further below, the usual direction a writer wants), negative moves ITM the same number
/// of strikes the other way, 0 trades ATM itself.
///
/// A signal whose target strike was never tracked (fell outside the ATM+-8 window for this
/// underlying's whole in-memory history - only possible with a large |StrikeOffset| or a very wide
/// intraday move) produces a BacktestTrade.NoData entry instead of being silently dropped, so the
/// page can show it was skipped and why.
/// </summary>
public sealed class OtmConfluenceStrategy : IBacktestStrategy
{
    public string Key => "otm-confluence";
    public string Name => "OTM/ITM Confluence";
    public string Description => "On every spot+ATM-CE+ATM-PE Confluence signal, either buy the matching CE/PE or sell the opposite leg, N strikes from ATM (positive = OTM, negative = ITM); exit on a points-based stop-loss/take-profit or day close.";

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        new BacktestParameterSpec("side", "Position", Default: SideBuy, Min: SideBuy, Max: SideSell, Step: 1, Options: new[]
        {
            new BacktestParameterOption(SideBuy, "Buy option"),
            new BacktestParameterOption(SideSell, "Sell option (opposite leg)"),
        }),
        new BacktestParameterSpec("otmSteps", "Strike offset from ATM (+OTM / -ITM)", Default: 1, Min: -8, Max: 8, Step: 1),
        new BacktestParameterSpec("slPoints", "Stop loss (points)", Default: 10, Min: 0.05m, Max: 1000, Step: 0.5m),
        new BacktestParameterSpec("tpPoints", "Take profit (points)", Default: 20, Min: 0.05m, Max: 2000, Step: 0.5m),
    };

    private const decimal SideBuy = 0;
    private const decimal SideSell = 1;

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        if (context.ConfluenceSignalsAscending.Count == 0) return Array.Empty<BacktestTrade>();

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

        foreach (var signal in context.ConfluenceSignalsAscending)
        {
            if (busyUntil is { } bu && signal.TimeUtc <= bu) continue; // still in an earlier trade

            // A buyer trades the leg that matches the view (bullish -> CE); a seller trades the
            // opposite one (bullish -> sell PE), which is the whole point of the sell mode.
            var isBullish = signal.Direction == "Bullish";
            var isCall = isSell ? !isBullish : isBullish;
            var optionType = isCall ? "CE" : "PE";

            if (!spotByTime.TryGetValue(signal.TimeUtc, out var signalSpotBar))
            {
                trades.Add(BacktestTrade.NoData(underlying, signal.TimeUtc, signal.Direction, side, optionType, 0));
                continue;
            }

            var atmAtSignal = step > 0 ? Math.Round(signalSpotBar.Close / step) * step : signalSpotBar.Close;
            var strike = isCall ? atmAtSignal + otmSteps * step : atmAtSignal - otmSteps * step;

            if (!strikeCandleCache.TryGetValue((strike, isCall), out var optionBars))
            {
                optionBars = context.GetOptionBars(strike, isCall);
                strikeCandleCache[(strike, isCall)] = optionBars;
            }

            var entryIndex = FindFirstAfter(optionBars, signal.TimeUtc);
            if (entryIndex < 0)
            {
                trades.Add(BacktestTrade.NoData(underlying, signal.TimeUtc, signal.Direction, side, optionType, strike));
                continue;
            }

            var entryBar = optionBars[entryIndex];
            if (entryBar.Open <= 0)
            {
                trades.Add(BacktestTrade.NoData(underlying, signal.TimeUtc, signal.Direction, side, optionType, strike));
                continue;
            }

            var entryPrice = entryBar.Open;
            // A buyer profits as the premium rises and a seller as it falls, so the two thresholds
            // swap sides entirely. Both are floored at 0 - a premium can't go negative, and for a
            // seller a target below 0 just means "the option expiring worthless", which caps that
            // trade's gain at the whole premium collected.
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
                underlying, signal.TimeUtc, signal.Direction, side, optionType, strike,
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

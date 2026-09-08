using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// The shared "given entry signals, what trades result?" engine. Every strategy so far differs only
/// in WHEN it wants to enter - the mechanics after that (which leg to trade, entry pricing, the
/// points-based stop/target, the day-close exit, one position at a time) are identical, so they
/// live here once instead of being copy-pasted per strategy. A new strategy supplies its own entry
/// signals and gets all of this for free.
///
/// The rules, in one place:
///   - A buyer trades the leg matching the view (bullish -> CE); a seller trades the OPPOSITE leg
///     (bullish -> sell PE), collecting the premium and profiting as it decays.
///   - The strike is StrikeOffset steps from the ATM AS IT WAS AT THE SIGNAL - not whatever is ATM
///     now - so an old signal is judged against the strike it actually pointed at. The offset is
///     signed: positive is OTM for the traded leg, negative ITM, 0 is ATM itself.
///   - Entry is that contract's OWN close on the SAME bar the signal confirmed on - not a further
///     bar afterward. A signal at bar [s, s+timeframe) confirms the instant that bar closes, at
///     s+timeframe; that bar's Close is a real, already-traded price at that exact same instant
///     (the print that confirmed the signal in the first place), so entering there is not
///     look-ahead - the trader is not seeing anything that has not already happened. Waiting for a
///     FURTHER bar to open (this app's previous rule) added a full extra bar-length of pure latency
///     without removing any actual look-ahead risk, since a bar's open is exactly as unknowable as
///     its own close until wall-clock time reaches that same instant either way - it just measured
///     "the same instant" one bar later than it needed to. Real fill slippage away from this close
///     is what StrategyTrigger.SlippagePoints (the live LIMIT order's own marketable buffer) already
///     exists to absorb, not something an extra idle bar of waiting approximates any better.
///   - Only price action AFTER entry is checked for stop/target - the walk starts at the bar AFTER
///     the signal bar, never the signal bar's own High/Low, since that range happened before the
///     position existed.
///   - Stop-loss/take-profit are absolute premium points, and mirror for a seller (target below
///     entry, stop above) since a seller profits as the premium falls. Both are floored at 0 -
///     a premium cannot go negative.
///   - Positions never carry overnight: index option intraday strategies lose most of their
///     remaining time value to theta by the next morning, so anything still open at the day's last
///     bar exits there.
///   - SquareOffTimeParameter (0 = off, the default) forces every position closed by a fixed IST
///     time of day, every day, rather than riding all the way to the day's last bar - useful for a
///     strategy that should never hold into the volatile last few minutes of a session, or a rule
///     tuned to only ever be in the market during a specific window.
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

    /// <summary>Minutes past midnight IST, e.g. 915 = 15:15 (see IstClock.AtIstTime) - a plain
    /// number rather than a time value because the whole parameter pipeline (query string,
    /// controller parsing, IBacktestStrategy.Simulate's decimal dictionary) only ever carries
    /// decimals; the frontend renders this one specific key with a time-of-day picker instead of a
    /// bare number spinner. 0 (the default) disables it entirely - a position rides to the day's
    /// last bar exactly as before this parameter existed.</summary>
    public static BacktestParameterSpec SquareOffTimeParameter() =>
        new("squareOffMinutes", "Square off by (IST time, 0 = off)", Default: 0, Min: 0, Max: 1439, Step: 1);

    /// <summary>Minutes past midnight IST (see SquareOffTimeParameter's own doc comment for why
    /// this is a plain number, not IstClock.MinutesOfDay/FormatMinutesOfDay). Defaults to 555 =
    /// 09:15 IST - NSE's actual continuous-trading open, not the exchange's own displayed "market
    /// hours" start. The roughly 09:00-09:15 pre-open session is a call auction (a single matched
    /// price from collected orders, not tick-by-tick trading), so a bar timestamped inside it can
    /// print sharp, one-off moves that mean nothing about the continuous session about to start -
    /// no strategy here should ever read one as a real signal. Unlike SquareOffTimeParameter this
    /// is ON by default rather than requiring opt-in: excluding pre-open bars from ever producing a
    /// signal is a correctness fix each strategy's own logic should always apply, not a preference
    /// some triggers might want and others not. 0 still means off, for a strategy or a backtest
    /// that genuinely wants every bar considered regardless.</summary>
    public static BacktestParameterSpec SignalStartTimeParameter() =>
        new("signalStartMinutes", "No signals before (IST time, 0 = off)", Default: 555, Min: 0, Max: 1439, Step: 1);

    /// <summary>Runs <paramref name="entrySignals"/> (time-ascending; Direction "Bullish"/"Bearish")
    /// through the rules above and returns the resulting trades, most recent first.
    ///
    /// <paramref name="forcedExitTimes"/> (ascending, optional) is for strategies whose exit rule
    /// lives in the UNDERLYING rather than in the option's premium - FiveEmaStrategy's "get out when
    /// spot comes back and touches the 5 EMA" being the case it was added for. An open position
    /// closes at the close of the first bar at or after such a time, after the stop and target have
    /// been checked on that same bar (they are intra-bar price levels; this is an end-of-bar
    /// decision, so it cannot pre-empt them). Strategies without one pass nothing and behave exactly
    /// as before.
    ///
    /// <paramref name="signalExits"/> (optional, keyed by the SIGNAL's own time) is the per-trade
    /// counterpart, for a strategy whose exit level differs from trade to trade - a stop at each
    /// alert candle's own high/low, say, with a target a fixed multiple away. Keying by signal
    /// rather than sharing one ascending list matters: those levels belong to one specific trade,
    /// and a global list would let one trade's stop close a completely different one. It carries its own reason string too, so a row says WHICH of the two hit rather than a
    /// generic "SignalExit".
    ///
    /// slPoints/tpPoints of 0 disable the premium stop/target entirely - for a strategy exiting on
    /// an underlying condition instead, a premium stop is an optional safety net rather than the
    /// mechanism, and 0 is how it says "no net".</summary>
    public static IReadOnlyList<BacktestTrade> Run(
        BacktestStrategyContext context,
        IReadOnlyList<(DateTimeOffset Time, string Direction)> entrySignals,
        IReadOnlyDictionary<string, decimal> parameters,
        IReadOnlyList<DateTimeOffset>? forcedExitTimes = null,
        IReadOnlyDictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)>? signalExits = null)
    {
        if (entrySignals.Count == 0) return Array.Empty<BacktestTrade>();

        var isSell = parameters["side"] >= (SideBuy + SideSell) / 2;
        var otmSteps = (int)parameters["otmSteps"];
        var slPoints = parameters["slPoints"];
        var tpPoints = parameters["tpPoints"];
        // Optional and defaulted here rather than indexed, so a caller (existing tests included)
        // built before this parameter existed keeps working unchanged with it simply off.
        var squareOffMinutes = (int)parameters.GetValueOrDefault("squareOffMinutes", 0);

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

            // The signal's OWN bar, not the next one - see this class's own doc comment for why
            // that bar's Close is the entry price rather than look-ahead.
            var signalIndex = FindAt(optionBars, signal.Time);
            if (signalIndex < 0 || optionBars[signalIndex].Close <= 0)
            {
                trades.Add(BacktestTrade.NoData(underlying, signal.Time, signal.Direction, side, optionType, strike, signalSpotBar.Close));
                continue;
            }

            var signalBar = optionBars[signalIndex];
            var entryTime = signalBar.Time + TimeSpan.FromMinutes(context.TimeframeMinutes); // the instant the signal bar - and so the signal itself - actually closed
            var entryPrice = signalBar.Close;
            var takeProfitPrice = isSell ? Math.Max(0, entryPrice - tpPoints) : entryPrice + tpPoints;
            var stopLossPrice = isSell ? entryPrice + slPoints : Math.Max(0, entryPrice - slPoints);
            var entryDay = BacktestUtil.IstDate(entryTime);

            var exitTime = entryTime;
            var exitPrice = entryPrice;
            string? exitReason = null;
            var forcedExit = FirstAtOrAfter(forcedExitTimes, entryTime);
            var signalExit = signalExits is not null && signalExits.TryGetValue(signal.Time, out var se) ? se : ((DateTimeOffset Time, string Reason)?)null;
            // Recomputed fresh per trade off THIS entry's own day, not a caller-supplied list like
            // forcedExitTimes/signalExits above - every day gets the identical cutoff, so there is
            // nothing to look up. Still applies even when it falls before entryTime itself (a cutoff
            // earlier than an already-open position's own entry) - the position exits at the very
            // next bar rather than silently ignoring a square-off time the trade never respected.
            var squareOffTime = squareOffMinutes > 0 ? IstClock.AtIstTime(entryDay, squareOffMinutes) : (DateTimeOffset?)null;

            // Starts AFTER the signal bar, never at it - its own High/Low happened BEFORE entry
            // (which is at its very last instant, the close), so checking stop/target against that
            // range would be judging the trade against price action it was never exposed to.
            for (var i = signalIndex + 1; i < optionBars.Count && BacktestUtil.IstDate(optionBars[i].Time) == entryDay; i++)
            {
                var bar = optionBars[i];
                // Conservative when a single bar's range spans both thresholds (a volatile bar
                // right after entry, most likely): check the stop first either way, so the worse
                // outcome for the trade wins rather than guessing which was touched first intra-bar.
                var stopHit = slPoints > 0 && (isSell ? bar.High >= stopLossPrice : bar.Low <= stopLossPrice);
                if (stopHit) { exitTime = bar.Time; exitPrice = stopLossPrice; exitReason = "StopLoss"; break; }

                var targetHit = tpPoints > 0 && (isSell ? bar.Low <= takeProfitPrice : bar.High >= takeProfitPrice);
                if (targetHit) { exitTime = bar.Time; exitPrice = takeProfitPrice; exitReason = "TakeProfit"; break; }

                if (forcedExit is { } fx && bar.Time >= fx)
                {
                    exitTime = bar.Time; exitPrice = bar.Close; exitReason = "SignalExit"; break;
                }

                if (signalExit is { } sx && bar.Time >= sx.Time)
                {
                    exitTime = bar.Time; exitPrice = bar.Close; exitReason = sx.Reason; break;
                }

                if (squareOffTime is { } cutoff && bar.Time >= cutoff)
                {
                    exitTime = bar.Time; exitPrice = bar.Close; exitReason = "SquareOff"; break;
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
                entryTime, entryPrice, exitTime, exitPrice, exitReason, pnlPoints));
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

    /// <summary>The bar whose own bucket starts exactly at <paramref name="time"/> - the signal
    /// bar itself, since a signal's Time is always its own confirming bucket's start (see
    /// BacktestUtil.AggregateCandles). -1 if that bucket has no data yet for this contract (either
    /// genuinely never tracked, or - for a signal from this exact instant - not even one native
    /// minute of it has closed yet; self-corrects on the next evaluation).</summary>
    private static int FindAt(IReadOnlyList<Candle> bars, DateTimeOffset time)
    {
        for (var i = 0; i < bars.Count; i++)
        {
            if (bars[i].Time == time) return i;
        }
        return -1;
    }
}

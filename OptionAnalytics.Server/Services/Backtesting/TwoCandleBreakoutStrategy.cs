using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// The "Two-Candle" / "Traffic Light" breakout setup, applied to the underlying's spot bars.
///
/// The pattern: wait for any consecutive PAIR of opposite-coloured candles (green then red, or red
/// then green) to close. The moment that pair closes, its combined High and Low become the "alert
/// range" - a pending, unbroken pair rolls forward exactly like the 5 EMA strategy's alert candle:
/// any newer opposite-coloured pair replaces it, and nothing carries across a trading day.
///
///   BULLISH breakout (buy CE): a later candle CLOSES above the range's High.
///   BEARISH breakout (buy PE): a later candle CLOSES below the range's Low.
///
/// Two risk-management filters, both as taught:
///   - The 9:15 filter: the trading day's own FIRST candle can never be either half of a pair (it
///     often carries the open's erratic noise) - a pair needs at least the day's 2nd and 3rd candles.
///   - Max range cap: a pair whose combined High-Low range exceeds maxRangePoints is never armed at
///     all - an abnormally wide two-candle range wrecks the risk:reward math below. 0 disables the cap.
///
/// One deliberate divergence from the taught rule, and the reason this strategy needs its own
/// execution loop rather than OptionTradeSimulator.Run (which every other strategy in this app
/// shares): AS TAUGHT, the stop-loss is the range's own opposite extreme and the target is a
/// risk:reward multiple of that - both are SPOT price levels, not option-premium points, and unlike
/// the 5 EMA strategy's single spot-level exit (a touch of the EMA), this one needs TWO independent
/// spot levels tracked per trade (a different stop AND target on every single signal, derived from
/// that signal's own range) - OptionTradeSimulator's shared stop/target machinery is built around
/// one GLOBAL points value shared by every trade, which cannot express that. So this class detects
/// entries and simulates the whole trade (entry, stop, target, EOD) itself, walking the SPOT bars
/// throughout - the option leg is only ever priced at two exact instants: entry (the breakout bar's
/// own close, same no-look-ahead rule as everywhere else in this app) and exit (that same
/// contract's own close on whichever spot bar triggered the stop/target/EOD condition). There is no
/// option-premium price to exit "at" the way a points-based stop/target has one - the realised exit
/// is always this contract's own print at that instant, never the spot stop/target level itself.
///
/// Stop and target are both checked intra-bar (High/Low, not Close) against the two spot levels,
/// starting the bar AFTER the breakout bar - its own High/Low happened before entry existed. A bar
/// that could plausibly hit both is resolved conservatively, stop first, same as every other
/// strategy's points-based check in this app.
/// </summary>
public sealed class TwoCandleBreakoutStrategy : IBacktestStrategy
{
    public string Key => "two-candle-breakout";
    public string Name => "Two-Candle Breakout (Traffic Light)";
    public string Description => "Waits for a consecutive green+red (or red+green) candle pair, anchors the combined High/Low as a breakout range, and enters the moment a later candle closes beyond either side - stop at the range's opposite extreme, target a risk:reward multiple of that. The day's first candle is never part of a pair, and a pair whose range is abnormally wide is skipped outright.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        new BacktestParameterSpec("riskRewardRatio", "Target (multiple of risk, e.g. 2 = risk:reward 1:2)", Default: 2, Min: 1, Max: 5, Step: 0.5m),
        new BacktestParameterSpec("maxRangePoints", "Max two-candle range in spot points (0 = no cap)", Default: 100, Min: 0, Max: 1000, Step: 5),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Bullish breakouts only (buy CE)"),
            new BacktestParameterOption(DirectionShortOnly, "Bearish breakouts only (buy PE)"),
        }),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        SimulateTrades(context, DetectBreakouts(context, parameters).Breakouts, parameters);

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        DetectBreakouts(context, parameters).Signals;

    /// <summary>One confirmed breakout: which side broke, and the exact range (in spot points) that
    /// produced it - RangeHigh/RangeLow become the trade's target/stop reference in SimulateTrades.</summary>
    private readonly record struct Breakout(DateTimeOffset Time, string Direction, decimal RangeHigh, decimal RangeLow);

    /// <summary>Pure spot-bar walk: finds every traffic-light pair, tracks the pending (unbroken) one,
    /// and fires a Breakout the instant a later candle closes beyond its range. No option data is
    /// touched here - see this class's own doc comment for why that is a separate phase.</summary>
    private (List<Breakout> Breakouts, List<BacktestSignal> Signals) DetectBreakouts(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var direction = parameters["direction"];
        var maxRange = parameters["maxRangePoints"];
        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        var bars = context.SpotBars;
        var breakouts = new List<Breakout>();
        var signals = new List<BacktestSignal>();

        // The most recent unbroken traffic-light pair, if any - only one can be pending at a time,
        // the same "rolls forward to the newest qualifying one" rule the 5 EMA strategy's alert
        // candle uses.
        (Candle First, Candle Second)? pendingPair = null;
        DateOnly? currentDay = null;
        var dayBarIndex = 0;

        for (var i = 0; i < bars.Count; i++)
        {
            var bar = bars[i];

            var day = BacktestUtil.IstDate(bar.Time);
            if (currentDay != day)
            {
                currentDay = day;
                dayBarIndex = 0;
                pendingPair = null; // nothing carries overnight
            }
            else
            {
                dayBarIndex++;
            }

            // Step 1: does THIS bar CLOSE beyond the pending pair's range? Checked before a new pair
            // is considered below, so a bar can never break a pair it is itself half of.
            if (pendingPair is { } pair)
            {
                var rangeHigh = Math.Max(pair.First.High, pair.Second.High);
                var rangeLow = Math.Min(pair.First.Low, pair.Second.Low);

                if (bar.Close > rangeHigh)
                {
                    var summary = $"Traffic-light pair at {BacktestUtil.IstDate(pair.First.Time):dd MMM} (range {rangeLow:0.##}-{rangeHigh:0.##}) broke up";
                    if (takeLongs)
                    {
                        signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", "Bullish", summary));
                        breakouts.Add(new Breakout(bar.Time, "Bullish", rangeHigh, rangeLow));
                    }
                    else
                    {
                        signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bullish", $"{summary} - skipped, bearish only"));
                    }
                    pendingPair = null;
                }
                else if (bar.Close < rangeLow)
                {
                    var summary = $"Traffic-light pair at {BacktestUtil.IstDate(pair.First.Time):dd MMM} (range {rangeLow:0.##}-{rangeHigh:0.##}) broke down";
                    if (takeShorts)
                    {
                        signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", "Bearish", summary));
                        breakouts.Add(new Breakout(bar.Time, "Bearish", rangeHigh, rangeLow));
                    }
                    else
                    {
                        signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Bearish", $"{summary} - skipped, bullish only"));
                    }
                    pendingPair = null;
                }
            }

            // Step 2: do (bars[i-1], bar) form a NEW traffic-light pair? Needs dayBarIndex >= 2 -
            // i.e. bars[i-1] itself must not be the day's own first bar (dayBarIndex 0) - which is
            // the 9:15 filter: the day's first candle is never either half of a pair.
            if (dayBarIndex >= 2)
            {
                var prev = bars[i - 1];
                var prevIsUp = prev.Close >= prev.Open;
                var currIsUp = bar.Close >= bar.Open;
                if (prevIsUp != currIsUp)
                {
                    var rangeHigh = Math.Max(prev.High, bar.High);
                    var rangeLow = Math.Min(prev.Low, bar.Low);
                    var range = rangeHigh - rangeLow;
                    if (maxRange <= 0 || range <= maxRange)
                    {
                        pendingPair = (prev, bar);
                    }
                    else
                    {
                        signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", "Neutral",
                            $"Two-candle range {range:0.##} exceeds the {maxRange:0.##}-point cap - skipped"));
                    }
                }
            }
        }

        return (breakouts, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }

    /// <summary>Turns each confirmed breakout into a real trade: entry priced off the option's own
    /// close on the breakout bar, then a SPOT-bar walk (not an option-bar walk) checking the range-
    /// derived stop/target levels intra-bar, one position at a time. See this class's own doc
    /// comment for why the exit price is always the option's own close at the triggering bar, never
    /// the spot stop/target level itself.</summary>
    private static IReadOnlyList<BacktestTrade> SimulateTrades(
        BacktestStrategyContext context, IReadOnlyList<Breakout> breakouts, IReadOnlyDictionary<string, decimal> parameters)
    {
        var isSell = parameters["side"] >= (OptionTradeSimulator.SideBuy + OptionTradeSimulator.SideSell) / 2;
        var otmSteps = (int)parameters["otmSteps"];
        var riskReward = parameters["riskRewardRatio"];

        var side = isSell ? "Sell" : "Buy";
        var underlying = context.Underlying;
        var step = context.Step;
        var bars = context.SpotBars;
        var spotByTime = bars.ToDictionary(b => b.Time, b => b);
        var strikeCandleCache = new Dictionary<(decimal Strike, bool IsCall), IReadOnlyList<Candle>>();

        var trades = new List<BacktestTrade>();
        DateTimeOffset? busyUntil = null;

        foreach (var breakout in breakouts)
        {
            if (busyUntil is { } bu && breakout.Time <= bu) continue; // still in an earlier trade

            var isBullish = breakout.Direction == "Bullish";
            var isCall = isSell ? !isBullish : isBullish;
            var optionType = isCall ? "CE" : "PE";

            if (!spotByTime.TryGetValue(breakout.Time, out var signalSpotBar))
            {
                trades.Add(BacktestTrade.NoData(underlying, breakout.Time, breakout.Direction, side, optionType, 0, null));
                continue;
            }

            var atmAtSignal = step > 0 ? Math.Round(signalSpotBar.Close / step) * step : signalSpotBar.Close;
            var strike = isCall ? atmAtSignal + otmSteps * step : atmAtSignal - otmSteps * step;

            if (!strikeCandleCache.TryGetValue((strike, isCall), out var optionBars))
            {
                optionBars = context.GetOptionBars(strike, isCall);
                strikeCandleCache[(strike, isCall)] = optionBars;
            }

            var entrySignalIndex = FindAt(optionBars, breakout.Time);
            if (entrySignalIndex < 0 || optionBars[entrySignalIndex].Close <= 0)
            {
                trades.Add(BacktestTrade.NoData(underlying, breakout.Time, breakout.Direction, side, optionType, strike, signalSpotBar.Close));
                continue;
            }

            var entryTime = breakout.Time + TimeSpan.FromMinutes(context.TimeframeMinutes);
            var entryPrice = optionBars[entrySignalIndex].Close;
            var entryDay = BacktestUtil.IstDate(entryTime);

            // Stop is the range's own opposite extreme; target is that same risk distance x
            // riskReward in the favourable direction - both spot price levels, exactly as taught.
            var entrySpot = signalSpotBar.Close;
            var stopLevel = isBullish ? breakout.RangeLow : breakout.RangeHigh;
            var risk = isBullish ? entrySpot - stopLevel : stopLevel - entrySpot;
            var targetLevel = isBullish ? entrySpot + risk * riskReward : entrySpot - risk * riskReward;

            var exitTime = entryTime;
            string? exitReason = null;
            var spotSignalIndex = FindAt(bars, breakout.Time); // always found - breakout.Time came from walking `bars` itself

            for (var i = spotSignalIndex + 1; i < bars.Count && BacktestUtil.IstDate(bars[i].Time) == entryDay; i++)
            {
                var spotBar = bars[i];

                // Conservative when a single bar's range could plausibly span both levels: check
                // the stop first, same as every points-based stop/target check elsewhere in this app.
                var stopHit = isBullish ? spotBar.Low <= stopLevel : spotBar.High >= stopLevel;
                if (stopHit) { exitTime = spotBar.Time; exitReason = "StopLoss"; break; }

                var targetHit = isBullish ? spotBar.High >= targetLevel : spotBar.Low <= targetLevel;
                if (targetHit) { exitTime = spotBar.Time; exitReason = "TakeProfit"; break; }

                exitTime = spotBar.Time;
            }

            exitReason ??= entryDay < BacktestUtil.IstDate(DateTimeOffset.UtcNow) ? "EndOfDay" : "Open";

            // The option's own print at the bar spot triggered the exit on - falls back to
            // entryPrice (0 realised P&L) only if this contract has no candle at that exact instant,
            // which the entry lookup above already found data for at signal time; a gap between
            // entry and exit coverage is rare but not impossible.
            var exitOptionIndex = FindAt(optionBars, exitTime);
            var exitPrice = exitOptionIndex >= 0 && optionBars[exitOptionIndex].Close > 0 ? optionBars[exitOptionIndex].Close : entryPrice;

            busyUntil = exitTime;
            var pnlPoints = isSell ? entryPrice - exitPrice : exitPrice - entryPrice;

            trades.Add(new BacktestTrade(
                underlying, breakout.Time, breakout.Direction, side, optionType, strike, signalSpotBar.Close,
                entryTime, entryPrice, exitTime, exitPrice, exitReason, pnlPoints));
        }

        return trades.OrderByDescending(t => t.SignalTimeUtc).ToList();
    }

    private static int FindAt(IReadOnlyList<Candle> bars, DateTimeOffset time)
    {
        for (var i = 0; i < bars.Count; i++)
            if (bars[i].Time == time) return i;
        return -1;
    }
}

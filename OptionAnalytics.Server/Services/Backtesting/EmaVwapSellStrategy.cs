using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// A trend-alignment SELLING strategy, at the user's own explicit request:
///
///   Bullish alignment -> SELL PE           Bearish alignment -> SELL CE
///   EMA 7 > EMA 20                         EMA 7 < EMA 20
///   EMA 7 rising                           EMA 7 falling
///   Spot closes above EMA 7                Spot closes below EMA 7
///   Spot above session VWAP                Spot below session VWAP
///   (EMA 5 rising, as an early trigger)    (EMA 5 falling, as an early trigger)
///
/// EMA 7 vs EMA 20 is the trend filter; the ENTRY itself is edge-triggered on spot's own close
/// crossing EMA 7 (not "EMA 7 > EMA 20" merely being true, which could hold for hours and would
/// otherwise fire a fresh sell on every single bar it does) - the same "cross event, not a level
/// staying true" shape EmaCrossAtmFlowStrategy already uses for its own spot EMA cross. EMA 5's own
/// slope is checked at that same crossing bar as the "early trigger" agreeing, not a second
/// independent event of its own - see RequireFastEmaSlope.
///
/// VWAP here is SPOT's own session VWAP (VwapCalculator, off BacktestStrategyContext.
/// SpotVolumeBarsOneMinute) - real traded volume only exists for NIFTY/BANKNIFTY's index bars as of
/// Dhan's January 2026 rollout (see DhanHistoricalDataService's own doc comment); a run against an
/// underlying or a historical window this account's Dhan plan does not actually deliver volume for
/// simply finds no VWAP confirmation at any bar (VwapCalculator emits no point at all until real
/// volume appears) and so takes no trades - a visible "nothing to show" rather than a silently wrong
/// VWAP built off a fabricated volume proxy.
///
/// "The previous candle didn't just make a huge spike" (mentioned as a soft "preferably", with no
/// concrete threshold given) is MaxPrevCandleRangeMultiple - OFF (0) by default, since inventing a
/// number for a condition the user did not pin down would silently reject signals they never asked
/// to have rejected; a user who wants it tightens the multiplier themselves.
///
/// Selling is the point of this strategy - Side defaults to Sell (the opposite leg from the
/// alignment's own direction), unlike every other strategy here defaulting to Buy - though it stays
/// a plain OptionTradeSimulator parameter, still overridable to Buy like any other strategy's.
/// </summary>
public sealed class EmaVwapSellStrategy : IBacktestStrategy
{
    public string Key => "ema-vwap-sell";
    public string Name => "EMA/VWAP Trend Alignment (Sell)";
    public string Description => "Sells the opposite leg (PE for a bullish alignment, CE for a bearish one) when spot's own close crosses its mid EMA while the mid EMA sits on the trend side of the slow EMA and is itself rising/falling that way, spot is on the same side of its own session VWAP, and (optionally) the fast EMA's own slope agrees too as an early trigger.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    private const decimal FlagOff = 0;
    private const decimal FlagOn = 1;

    /// <summary>How many bars back of the previous bar the "didn't just spike" baseline averages
    /// over - fixed rather than its own tunable, since the condition itself is off by default and
    /// this is only the shape of the (opt-in) check, not a number the user asked to control.</summary>
    private const int PrevCandleBaselineBars = 10;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter() with { Default = OptionTradeSimulator.SideSell },
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.StopLossParameter(),
        OptionTradeSimulator.TakeProfitParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        OptionTradeSimulator.SignalStartTimeParameter(),
        OptionTradeSimulator.ExcludeLastDaysParameter(),
        new BacktestParameterSpec("fastEmaPeriod", "Fast EMA - early trigger (bars)", Default: 5, Min: 1, Max: 100, Step: 1),
        new BacktestParameterSpec("midEmaPeriod", "Mid EMA - spot crosses this to enter (bars)", Default: 7, Min: 1, Max: 200, Step: 1),
        new BacktestParameterSpec("slowEmaPeriod", "Slow EMA - trend filter (bars)", Default: 20, Min: 2, Max: 400, Step: 1),
        new BacktestParameterSpec("slopeLookbackBars", "EMA slope measured over (bars)", Default: 1, Min: 1, Max: 50, Step: 1),
        new BacktestParameterSpec("requireFastEmaSlope", "Also require the fast EMA's own slope to agree", Default: FlagOn, Min: FlagOff, Max: FlagOn, Step: 1, Options: new[]
        {
            new BacktestParameterOption(FlagOn, "Yes - fast EMA is an early trigger too"),
            new BacktestParameterOption(FlagOff, "No - mid/slow EMA and VWAP only"),
        }),
        new BacktestParameterSpec("maxPrevCandleRangeMultiple", "Reject if the previous candle's range exceeds (x its recent average, 0 = off)", Default: 0, Min: 0, Max: 20, Step: 0.5m),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Bullish alignment only"),
            new BacktestParameterOption(DirectionShortOnly, "Bearish alignment only"),
        }),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters, null);

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var fastPeriod = (int)parameters["fastEmaPeriod"];
        var midPeriod = (int)parameters["midEmaPeriod"];
        var slowPeriod = (int)parameters["slowEmaPeriod"];

        // Same "the periods must actually nest, or every comparison is nonsense" guard
        // EmaCrossAtmFlowStrategy applies to its own fast/slow pair.
        if (fastPeriod >= midPeriod || midPeriod >= slowPeriod) return (entries, signals);

        var slopeLookback = Math.Max(1, (int)parameters["slopeLookbackBars"]);
        var requireFastSlope = parameters["requireFastEmaSlope"] >= (FlagOff + FlagOn) / 2;
        var maxPrevRangeMultiple = parameters.GetValueOrDefault("maxPrevCandleRangeMultiple", 0m);
        var direction = parameters["direction"];
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);

        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;

        var bars = context.SpotBars;
        var fastEma = EmaCrossoverDetector.EmaSeries(bars, fastPeriod);
        var midEma = EmaCrossoverDetector.EmaSeries(bars, midPeriod);
        var slowEma = EmaCrossoverDetector.EmaSeries(bars, slowPeriod);
        var vwap = VwapCalculator.ComputeSeries(context.SpotVolumeBarsOneMinute);

        for (var i = Math.Max(1, slopeLookback); i < bars.Count; i++)
        {
            var bar = bars[i];
            var prevBar = bars[i - 1];

            if (fastEma[i] is not { } fast || midEma[i] is not { } mid || slowEma[i] is not { } slow) continue;
            if (midEma[i - 1] is not { } midPrevBar) continue;
            if (midEma[i - slopeLookback] is not { } midLookback || fastEma[i - slopeLookback] is not { } fastLookback) continue;

            // The entry event: spot's own close crossing the mid EMA - not "mid > slow" merely
            // being true, which can hold for a whole trend day and would otherwise re-sell on
            // every single bar of it.
            var crossedAbove = prevBar.Close <= midPrevBar && bar.Close > mid;
            var crossedBelow = prevBar.Close >= midPrevBar && bar.Close < mid;
            if (!crossedAbove && !crossedBelow) continue;

            var bullish = crossedAbove;

            if (bullish ? !takeLongs : !takeShorts)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bullish ? "Bullish" : "Bearish",
                    $"Spot crossed {(bullish ? "above" : "below")} the {midPeriod} EMA - skipped, {(bullish ? "bearish" : "bullish")} alignment only"));
                continue;
            }

            if (signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bullish ? "Bullish" : "Bearish",
                    $"Spot crossed {(bullish ? "above" : "below")} the {midPeriod} EMA - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
                continue;
            }

            var trendAgrees = bullish ? mid > slow : mid < slow;
            if (!trendAgrees)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bullish ? "Bullish" : "Bearish",
                    $"Spot crossed {(bullish ? "above" : "below")} the {midPeriod} EMA - but the {midPeriod}/{slowPeriod} EMA relationship does not agree yet"));
                continue;
            }

            var midSlopeAgrees = bullish ? mid > midLookback : mid < midLookback;
            if (!midSlopeAgrees)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bullish ? "Bullish" : "Bearish",
                    $"Spot crossed {(bullish ? "above" : "below")} the {midPeriod} EMA with the trend agreeing - but the {midPeriod} EMA's own slope over the last {slopeLookback} bar(s) does not"));
                continue;
            }

            if (requireFastSlope)
            {
                var fastSlopeAgrees = bullish ? fast > fastLookback : fast < fastLookback;
                if (!fastSlopeAgrees)
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bullish ? "Bullish" : "Bearish",
                        $"Spot crossed {(bullish ? "above" : "below")} the {midPeriod} EMA with the trend agreeing - but the {fastPeriod} EMA's own early-trigger slope does not, over the last {slopeLookback} bar(s)"));
                    continue;
                }
            }

            var vwapAtBar = BacktestUtil.LastValueAtOrBefore(vwap, bar.Time);
            if (vwapAtBar is not { } vwapValue)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bullish ? "Bullish" : "Bearish",
                    $"Spot crossed {(bullish ? "above" : "below")} the {midPeriod} EMA with the trend agreeing - but no session VWAP is available yet for {context.Underlying} at this bar (needs real traded volume on the spot/index feed)"));
                continue;
            }

            var vwapAgrees = bullish ? bar.Close > vwapValue : bar.Close < vwapValue;
            if (!vwapAgrees)
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bullish ? "Bullish" : "Bearish",
                    $"Spot crossed {(bullish ? "above" : "below")} the {midPeriod} EMA with the trend agreeing - but spot is not on the same side of session VWAP ({vwapValue:0.##})"));
                continue;
            }

            if (maxPrevRangeMultiple > 0 && IsPrevCandleASpike(bars, i - 1, maxPrevRangeMultiple))
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", bullish ? "Bullish" : "Bearish",
                    $"Spot crossed {(bullish ? "above" : "below")} the {midPeriod} EMA, trend/slope/VWAP all agreed - but skipped, the previous candle's own range looks like a spike"));
                continue;
            }

            var legName = bullish ? "PE" : "CE";
            var summary = $"Spot crossed {(bullish ? "above" : "below")} the {midPeriod} EMA, {midPeriod}/{slowPeriod} EMA trend and slope agree, spot is on the same side of session VWAP ({vwapValue:0.##}){(requireFastSlope ? $", and the {fastPeriod} EMA early trigger agrees" : "")} - selling the {legName}";
            signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", bullish ? "Bullish" : "Bearish", summary));
            entries.Add((bar.Time, bullish ? "Bullish" : "Bearish"));
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }

    /// <summary>Whether the candle at <paramref name="index"/> (the bar just before the crossing
    /// bar) has a High-Low range more than <paramref name="multiple"/> times the average range of
    /// the PrevCandleBaselineBars candles before it - the closest a plain range comparison gets to
    /// "didn't just make a huge spike" without inventing a fixed point/percent threshold the user
    /// never gave.</summary>
    private static bool IsPrevCandleASpike(IReadOnlyList<Candle> bars, int index, decimal multiple)
    {
        var from = Math.Max(0, index - PrevCandleBaselineBars);
        if (from >= index) return false;

        decimal totalRange = 0;
        var count = 0;
        for (var j = from; j < index; j++)
        {
            totalRange += bars[j].High - bars[j].Low;
            count++;
        }
        if (count == 0) return false;

        var averageRange = totalRange / count;
        if (averageRange <= 0) return false;

        var candleRange = bars[index].High - bars[index].Low;
        return candleRange > averageRange * multiple;
    }
}

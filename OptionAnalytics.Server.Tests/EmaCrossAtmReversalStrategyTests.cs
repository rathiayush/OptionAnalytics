using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers EmaCrossAtmReversalStrategy's own distinguishing behavior - no stop/target, a
/// position rides across a day boundary, and only an OPPOSITE confirmed signal ever closes it (and
/// immediately flips into the new direction) - using a directly-constructed BacktestStrategyContext,
/// the same harness EmaCrossAtmConfirmStrategyTests uses since this strategy shares its exact entry
/// confirmation (reused via EmaCrossAtmConfirmStrategy.CrossTimes).</summary>
public sealed class EmaCrossAtmReversalStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero); // 09:15 IST

    private static Candle Bar(DateTimeOffset time, decimal close) => new(time, close, close, close, close);

    private static BacktestStrategyContext Context(
        IReadOnlyList<Candle> spotBars, Func<decimal, bool, IReadOnlyList<Candle>> getOptionBars) => new()
    {
        Underlying = "NIFTY",
        TimeframeMinutes = 1,
        Step = 50,
        SpotBars = spotBars,
        SpotBarsOneMinute = spotBars,
        ConfluenceSignalsAscending = Array.Empty<BacktestSignal>(),
        AllSignals = Array.Empty<BacktestSignal>(),
        ObvCeSeries = Array.Empty<ObvPoint>(),
        ObvPeSeries = Array.Empty<ObvPoint>(),
        CdvCeSeries = Array.Empty<ObvPoint>(),
        CdvPeSeries = Array.Empty<ObvPoint>(),
        GetOptionBars = getOptionBars,
        GetOptionBarsOneMinute = getOptionBars,
        AtmCeBars = Array.Empty<Candle>(),
        AtmPeBars = Array.Empty<Candle>(),
        AtmCeVolumeBars = Array.Empty<CandleWithVolume>(),
        AtmPeVolumeBars = Array.Empty<CandleWithVolume>(),
        AtmStrike = null,
    };

    private static Dictionary<string, decimal> Parameters() => new()
    {
        ["side"] = OptionTradeSimulator.SideBuy,
        ["otmSteps"] = 0,
        ["fastEmaPeriod"] = 2,
        ["slowEmaPeriod"] = 5,
        ["atmConfirmWithinBars"] = 5,
        ["requireOppositeLegConfirm"] = 0,
        ["signalStartMinutes"] = 0,
        ["excludeLastDays"] = 0,
    };

    // One day's worth of bars: FLAT for the first 10, then a sharp move (up for wantBullish, down
    // otherwise) - the same "flat then breaks out" shape EmaCrossAtmConfirmStrategyTests already
    // relies on for a clean, unambiguous EMA(2,5) cross with no pre-existing directional bias to
    // fight against.
    private static List<Candle> DayBars(DateTimeOffset dayStart, decimal start, bool wantBullish)
    {
        var bars = new List<Candle>();
        for (var i = 0; i < 10; i++) bars.Add(Bar(dayStart.AddMinutes(i), start));
        var slope = wantBullish ? 1 : -1;
        for (var i = 10; i < 30; i++) bars.Add(Bar(dayStart.AddMinutes(i), start + slope * (i - 9) * 2));
        return bars;
    }

    [Fact]
    public void ReversesIntoTheOppositeDirection_AcrossDayBoundary_WithNoStopOrTarget()
    {
        var day2Start = T0.AddDays(1);

        // Day 1: spot/CE/PE all turn BULLISH at bar 10 (spot and CE rise, PE falls).
        var spotDay1 = DayBars(T0, 24000m, wantBullish: true);
        var ceDay1 = DayBars(T0, 100m, wantBullish: true);
        var peDay1 = DayBars(T0, 200m, wantBullish: false);

        // Day 2: the mirror image - spot/CE/PE all turn BEARISH at bar 10 (spot and CE fall, PE
        // rises) - proving the position rides straight across the day boundary with no forced
        // close, unlike every other strategy here, until this real opposite signal ends it.
        // Each leg's day-2 fixture continues from where its OWN day-1 series ended, not a fresh
        // fixed base - an artificial jump at the boundary would itself register as a discontinuity
        // right when EMA continuity matters, throwing off exactly when the real cross happens.
        var spotDay2 = DayBars(day2Start, spotDay1[^1].Close, wantBullish: false);
        var ceDay2 = DayBars(day2Start, ceDay1[^1].Close, wantBullish: false); // CE falls - bearish confirmation on the same leg
        var peDay2 = DayBars(day2Start, peDay1[^1].Close, wantBullish: true); // PE rises

        var spot = spotDay1.Concat(spotDay2).ToList();
        var ceBars = ceDay1.Concat(ceDay2).ToList();
        var peBars = peDay1.Concat(peDay2).ToList();

        IReadOnlyList<Candle> GetOptionBars(decimal strike, bool isCall) => isCall ? ceBars : peBars;

        var context = Context(spot, GetOptionBars);
        var trades = new EmaCrossAtmReversalStrategy().Simulate(context, Parameters());

        Assert.Equal(2, trades.Count);
        // Newest first (OrderByDescending SignalTimeUtc) - the bearish flip is still open, the
        // bullish leg it replaced is the one that got closed out.
        var bearishOpen = trades[0];
        var bullishClosed = trades[1];

        Assert.Equal("Bearish", bearishOpen.Direction);
        Assert.Equal("Open", bearishOpen.ExitReason);

        Assert.Equal("Bullish", bullishClosed.Direction);
        Assert.Equal("Reversed", bullishClosed.ExitReason);
        // CE rose from ~100 toward ~140 before the reversal closed it out - a real, positive P&L,
        // not a stop/target level (there is none).
        Assert.True(bullishClosed.PnlPoints > 0, $"expected a positive P&L on the closed bullish leg, got {bullishClosed.PnlPoints}");

        // The whole point: no forced day-boundary exit anywhere in the trade list.
        Assert.DoesNotContain(trades, t => t.ExitReason is "EndOfDay" or "SquareOff" or "StopLoss" or "TakeProfit");
    }

    // Rise, then fall back to base, then rise again - a fast(2)/slow(5) EMA pair genuinely CANNOT
    // cross "up" twice in a row without an intervening "down" cross first (they are the same two
    // lines flipping order back and forth), so testing "a repeated bullish confirmation is ignored"
    // needs this real up-down-up shape, not two rises glued together (which never produces a second
    // cross event at all - the lines simply stay in the same order the whole way through).
    private static List<Candle> UpDownUpBars(DateTimeOffset dayStart, decimal baseValue)
    {
        var bars = new List<Candle>();
        for (var i = 0; i < 10; i++) bars.Add(Bar(dayStart.AddMinutes(i), baseValue));
        for (var i = 10; i < 20; i++) bars.Add(Bar(dayStart.AddMinutes(i), baseValue + (i - 9) * 2));
        var peak = baseValue + 20;
        for (var i = 20; i < 30; i++) bars.Add(Bar(dayStart.AddMinutes(i), peak - (i - 19) * 2));
        for (var i = 30; i < 40; i++) bars.Add(Bar(dayStart.AddMinutes(i), baseValue + (i - 29) * 2));
        return bars;
    }

    [Fact]
    public void RepeatedSameDirectionSignal_IsIgnored_NotASecondTrade()
    {
        // Spot and CE both rise (bullish #1, confirmed), fall back (a bearish spot cross that PE -
        // held flat throughout - never confirms, so it stays rejected and the bullish position is
        // never actually closed), then rise again (bullish #2). Already positioned bullish the
        // whole time, so #2 must be dropped rather than opening a redundant second trade.
        var spot = UpDownUpBars(T0, 24000m);
        var ceBars = UpDownUpBars(T0, 100m);
        var peBars = Enumerable.Range(0, 40).Select(i => Bar(T0.AddMinutes(i), 200m)).ToList();

        IReadOnlyList<Candle> GetOptionBars(decimal strike, bool isCall) => isCall ? ceBars : peBars;

        var context = Context(spot, GetOptionBars);
        var trades = new EmaCrossAtmReversalStrategy().Simulate(context, Parameters());
        var signals = new EmaCrossAtmReversalStrategy().EntrySignals(context, Parameters());

        Assert.Single(trades);
        Assert.Equal("Bullish", trades[0].Direction);
        Assert.Equal("Open", trades[0].ExitReason);
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish" && s.Summary.Contains("already positioned", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void NoOptionDataAtAll_NoEntry()
    {
        var spot = DayBars(T0, 24000m, wantBullish: true);
        IReadOnlyList<Candle> GetOptionBars(decimal strike, bool isCall) => Array.Empty<Candle>();

        var context = Context(spot, GetOptionBars);
        var trades = new EmaCrossAtmReversalStrategy().Simulate(context, Parameters());

        Assert.Empty(trades);
    }

    // ---- ConfirmedCrossedUp: "candle close is important" -------------------------------------

    [Fact]
    public void ConfirmedCrossedUp_OnlyFiresOnATransitionIntoANewConfirmedDirection()
    {
        var t = Enumerable.Range(0, 6).Select(i => T0.AddMinutes(i)).ToArray();
        var series = new List<(DateTimeOffset Time, string? Direction)>
        {
            (t[0], null),      // no confirmed bias yet
            (t[1], null),      // still nothing - the EMA order may have flipped, but price never
                               // closed beyond both lines (exactly the noise ConfirmedDirectionSeries
                               // filters out and CrossedUp's own looser rule would have missed)
            (t[2], "Bullish"), // resolves into a real, close-confirmed bullish bias
            (t[3], "Bullish"), // stays bullish - not a fresh cross, must not re-fire
            (t[4], null),      // drops back to unconfirmed (choppy) - not itself a cross
            (t[5], "Bearish"), // resolves into bearish
        };

        Assert.False(EmaCrossAtmReversalStrategy.ConfirmedCrossedUp(series, 1, out _)); // null -> null
        Assert.True(EmaCrossAtmReversalStrategy.ConfirmedCrossedUp(series, 2, out var bullishAt2));
        Assert.True(bullishAt2);
        Assert.False(EmaCrossAtmReversalStrategy.ConfirmedCrossedUp(series, 3, out _)); // repeat, ignored
        Assert.False(EmaCrossAtmReversalStrategy.ConfirmedCrossedUp(series, 4, out _)); // Bullish -> null, not a cross
        Assert.True(EmaCrossAtmReversalStrategy.ConfirmedCrossedUp(series, 5, out var bullishAt5));
        Assert.False(bullishAt5);
    }

    [Fact]
    public void ConfirmedCrossTimes_MatchesTheSharpMoveShape_AndSkipsTheFirstBarOfEachDay()
    {
        var bars = new List<Candle>();
        for (var i = 0; i < 5; i++) bars.Add(Bar(T0.AddMinutes(i), 100));
        for (var i = 5; i < 15; i++) bars.Add(Bar(T0.AddMinutes(i), 100 + (i - 4) * 10)); // sharp, sustained rise
        for (var i = 15; i < 25; i++) bars.Add(Bar(T0.AddMinutes(i), 200 - (i - 14) * 10)); // sharp, sustained fall

        var upTimes = EmaCrossAtmReversalStrategy.ConfirmedCrossTimes(bars, fastPeriod: 2, slowPeriod: 5, wantBullish: true);
        var downTimes = EmaCrossAtmReversalStrategy.ConfirmedCrossTimes(bars, fastPeriod: 2, slowPeriod: 5, wantBullish: false);

        Assert.NotEmpty(upTimes);
        Assert.NotEmpty(downTimes);
        Assert.True(upTimes.Max() < downTimes.Min());
        Assert.Empty(EmaCrossAtmReversalStrategy.ConfirmedCrossTimes(Array.Empty<Candle>(), 2, 5, wantBullish: true));
    }

    // ---- Max stop loss -------------------------------------------------------------------------

    [Fact]
    public void MaxStopLoss_ClosesThePosition_EvenWithNoOppositeSignalAtAll()
    {
        // Spot: one clean bullish turn, then it just keeps trending - no further cross of any kind,
        // so the ONLY thing that can end this trade is the max-SL safety net, never a reversal.
        var spot = DayBars(T0, 24000m, wantBullish: true);

        // CE: confirms the same bullish turn (rising through bar ~19, matching spot's own timing),
        // then craters - a decline that has nothing to do with any spot signal, purely a premium
        // move that must trip the safety net on its own.
        var ceBars = new List<Candle>();
        for (var i = 0; i < 10; i++) ceBars.Add(Bar(T0.AddMinutes(i), 100));
        for (var i = 10; i < 20; i++) ceBars.Add(Bar(T0.AddMinutes(i), 100 + (i - 9) * 2));
        var peak = ceBars[^1].Close;
        for (var i = 20; i < 30; i++) ceBars.Add(Bar(T0.AddMinutes(i), peak - (i - 19) * 10)); // steep drop

        var peBars = Enumerable.Range(0, 30).Select(i => Bar(T0.AddMinutes(i), 200m)).ToList();

        IReadOnlyList<Candle> GetOptionBars(decimal strike, bool isCall) => isCall ? ceBars : peBars;

        var parameters = Parameters();
        parameters["maxSlPoints"] = 30m;

        var context = Context(spot, GetOptionBars);
        var trades = new EmaCrossAtmReversalStrategy().Simulate(context, parameters);

        var trade = Assert.Single(trades);
        Assert.Equal("Bullish", trade.Direction);
        Assert.Equal("MaxStopLoss", trade.ExitReason);
        Assert.Equal(trade.EntryPrice - 30m, trade.ExitPrice);
        Assert.Equal(-30m, trade.PnlPoints);
    }

    [Fact]
    public void MaxStopLossOfZero_MeansNoSafetyNet_PositionStaysOpenThroughTheDrop()
    {
        var spot = DayBars(T0, 24000m, wantBullish: true);
        var ceBars = new List<Candle>();
        for (var i = 0; i < 10; i++) ceBars.Add(Bar(T0.AddMinutes(i), 100));
        for (var i = 10; i < 20; i++) ceBars.Add(Bar(T0.AddMinutes(i), 100 + (i - 9) * 2));
        var peak = ceBars[^1].Close;
        for (var i = 20; i < 30; i++) ceBars.Add(Bar(T0.AddMinutes(i), peak - (i - 19) * 10));
        var peBars = Enumerable.Range(0, 30).Select(i => Bar(T0.AddMinutes(i), 200m)).ToList();

        IReadOnlyList<Candle> GetOptionBars(decimal strike, bool isCall) => isCall ? ceBars : peBars;

        var parameters = Parameters();
        parameters["maxSlPoints"] = 0m;

        var context = Context(spot, GetOptionBars);
        var trades = new EmaCrossAtmReversalStrategy().Simulate(context, parameters);

        var trade = Assert.Single(trades);
        Assert.Equal("Open", trade.ExitReason);
        Assert.Equal(ceBars[^1].Close, trade.ExitPrice);
    }
}

using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers OptionTradeSimulator.Run's stop-loss/take-profit checks specifically: they must
/// fire off the option contract's own intra-bar High/Low, not just its Close, since a real position
/// is stopped or targeted the instant price actually trades through the level intra-bar - waiting
/// for the bar to CLOSE past it would report trades as riding further than a real position ever
/// could have. Despite OptionTradeSimulatorSquareOffTests' doc comment claiming stop/target were
/// "already exercised via the individual strategies' own tests", no test anywhere in this project
/// actually asserted a "StopLoss" or "TakeProfit" ExitReason before this file - every fixture below
/// is built so Close alone would MISS the level and only checking High/Low catches it, so these
/// tests would fail if OptionTradeSimulator.Run were ever changed to check Close instead.</summary>
public sealed class OptionTradeSimulatorStopTargetTests
{
    // 04:00 UTC == 09:30 IST - matches the T0 convention this project's other tests already use.
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan Ist = TimeSpan.FromHours(5.5);

    private static Candle Bar(DateTimeOffset time, decimal open, decimal high, decimal low, decimal close) =>
        new(time, open, high, low, close);

    private static BacktestStrategyContext Context(IReadOnlyList<Candle> spotBars, IReadOnlyList<Candle> optionBars) => new()
    {
        Underlying = "NIFTY",
        TimeframeMinutes = 1,
        Step = 50,
        SpotBars = spotBars,
        SpotBarsOneMinute = spotBars,
        SpotVolumeBarsOneMinute = Array.Empty<CandleWithVolume>(),
        ConfluenceSignalsAscending = Array.Empty<BacktestSignal>(),
        AllSignals = Array.Empty<BacktestSignal>(),
        ObvCeSeries = Array.Empty<ObvPoint>(),
        ObvPeSeries = Array.Empty<ObvPoint>(),
        CdvCeSeries = Array.Empty<ObvPoint>(),
        CdvPeSeries = Array.Empty<ObvPoint>(),
        GetOptionBars = (_, _) => optionBars,
        GetOptionBarsOneMinute = (_, _) => optionBars,
        AtmCeBars = Array.Empty<Candle>(),
        AtmPeBars = Array.Empty<Candle>(),
        AtmCeVolumeBars = Array.Empty<CandleWithVolume>(),
        AtmPeVolumeBars = Array.Empty<CandleWithVolume>(),
        AtmStrike = null,
        OpenInterest = null,
    };

    private static Dictionary<string, decimal> Parameters(decimal side, decimal slPoints = 10, decimal tpPoints = 20) => new()
    {
        ["side"] = side,
        ["otmSteps"] = 0,
        ["slPoints"] = slPoints,
        ["tpPoints"] = tpPoints,
    };

    [Fact]
    public void Run_BuyTargetTouchedIntraBarButCloseFallsShort_ExitsTakeProfitAtTheTargetPrice()
    {
        var spotBars = new[] { Bar(T0, 24000, 24000, 24000, 24000) };
        var optionBars = new[]
        {
            Bar(T0, 100, 100, 100, 100), // signal bar - entry at Close = 100, target = 120, stop = 90
            Bar(T0.AddMinutes(1), 101, 125, 99, 105), // High 125 touches the 120 target; Close (105) alone never would
        };
        var context = Context(spotBars, optionBars);

        var trades = OptionTradeSimulator.Run(context, new[] { (T0, "Bullish") }, Parameters(OptionTradeSimulator.SideBuy));

        var trade = Assert.Single(trades);
        Assert.Equal("TakeProfit", trade.ExitReason);
        Assert.Equal(120, trade.ExitPrice);
        // The triggering bar is [09:31,09:32) - its own real close instant is 09:32, not its
        // 09:31 start label (see Run's own barCloseTime comment).
        Assert.Equal(new DateTimeOffset(2026, 1, 5, 9, 32, 0, Ist), trade.ExitTimeUtc);
    }

    [Fact]
    public void Run_BuyStopTouchedIntraBarButCloseStaysAbove_ExitsStopLossAtTheStopPrice()
    {
        var spotBars = new[] { Bar(T0, 24000, 24000, 24000, 24000) };
        var optionBars = new[]
        {
            Bar(T0, 100, 100, 100, 100), // entry at 100, stop = 90
            Bar(T0.AddMinutes(1), 99, 105, 85, 95), // Low 85 touches the 90 stop; Close (95) alone never would
        };
        var context = Context(spotBars, optionBars);

        var trades = OptionTradeSimulator.Run(context, new[] { (T0, "Bullish") }, Parameters(OptionTradeSimulator.SideBuy));

        var trade = Assert.Single(trades);
        Assert.Equal("StopLoss", trade.ExitReason);
        Assert.Equal(90, trade.ExitPrice);
    }

    [Fact]
    public void Run_SellStopIsAboveEntry_TouchedIntraBarByHighButCloseStaysBelow_ExitsStopLoss()
    {
        // A seller's stop mirrors a buyer's target: it sits ABOVE entry (the premium rising against
        // a short) and so is checked against the bar's High, exactly like a buyer's take-profit is.
        var spotBars = new[] { Bar(T0, 24000, 24000, 24000, 24000) };
        var optionBars = new[]
        {
            Bar(T0, 100, 100, 100, 100), // sold at 100, stop = 110
            Bar(T0.AddMinutes(1), 101, 130, 99, 105), // High 130 touches the 110 stop; Close (105) alone never would
        };
        var context = Context(spotBars, optionBars);

        var trades = OptionTradeSimulator.Run(context, new[] { (T0, "Bullish") }, Parameters(OptionTradeSimulator.SideSell));

        var trade = Assert.Single(trades);
        Assert.Equal("Sell", trade.Side);
        Assert.Equal("StopLoss", trade.ExitReason);
        Assert.Equal(110, trade.ExitPrice);
    }

    [Fact]
    public void Run_SellTargetIsBelowEntry_TouchedIntraBarByLowButCloseStaysAbove_ExitsTakeProfit()
    {
        // A seller's target mirrors a buyer's stop: it sits BELOW entry (the premium decaying in
        // the short's favor) and so is checked against the bar's Low.
        var spotBars = new[] { Bar(T0, 24000, 24000, 24000, 24000) };
        var optionBars = new[]
        {
            Bar(T0, 100, 100, 100, 100), // sold at 100, target = 80
            Bar(T0.AddMinutes(1), 99, 105, 60, 95), // Low 60 touches the 80 target; Close (95) alone never would
        };
        var context = Context(spotBars, optionBars);

        var trades = OptionTradeSimulator.Run(context, new[] { (T0, "Bullish") }, Parameters(OptionTradeSimulator.SideSell));

        var trade = Assert.Single(trades);
        Assert.Equal("Sell", trade.Side);
        Assert.Equal("TakeProfit", trade.ExitReason);
        Assert.Equal(80, trade.ExitPrice);
    }

    [Fact]
    public void Run_SameBarTouchesBothStopAndTarget_StopWinsAsTheConservativeOutcome()
    {
        // A single volatile bar spanning both the 90 stop and the 120 target right after entry -
        // OptionTradeSimulator.Run deliberately checks the stop first in this ambiguous case (see
        // its own doc comment), reporting the worse outcome for the trade rather than guessing
        // which level intra-bar price actually reached first.
        var spotBars = new[] { Bar(T0, 24000, 24000, 24000, 24000) };
        var optionBars = new[]
        {
            Bar(T0, 100, 100, 100, 100),
            Bar(T0.AddMinutes(1), 100, 130, 80, 100), // spans both the 90 stop and the 120 target
        };
        var context = Context(spotBars, optionBars);

        var trades = OptionTradeSimulator.Run(context, new[] { (T0, "Bullish") }, Parameters(OptionTradeSimulator.SideBuy));

        var trade = Assert.Single(trades);
        Assert.Equal("StopLoss", trade.ExitReason);
        Assert.Equal(90, trade.ExitPrice);
    }

    [Fact]
    public void Run_SignalBarsOwnHighLowSpanBothLevels_NeverTriggersOnTheSignalBarItself()
    {
        // The signal bar's own High/Low happened BEFORE entry (entry is at its very last instant,
        // the Close) - a position was never exposed to that range, so it must not be judged against
        // it even though this bar alone would otherwise touch both the stop and the target.
        var spotBars = new[] { Bar(T0, 24000, 24000, 24000, 24000) };
        var optionBars = new[]
        {
            Bar(T0, 100, 130, 70, 100), // signal/entry bar - its own 130 high / 70 low must be ignored
            Bar(T0.AddMinutes(1), 100, 100, 100, 100), // flat afterward - nothing left to trigger on
        };
        var context = Context(spotBars, optionBars);

        var trades = OptionTradeSimulator.Run(context, new[] { (T0, "Bullish") }, Parameters(OptionTradeSimulator.SideBuy));

        var trade = Assert.Single(trades);
        Assert.NotEqual("StopLoss", trade.ExitReason);
        Assert.NotEqual("TakeProfit", trade.ExitReason);
    }
}

using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers OptionTradeSimulator.Run's maxHoldingBars handling - a per-trade duration cap
/// SINCE ENTRY (unlike squareOffMinutes' shared daily clock cutoff - see
/// OptionTradeSimulatorSquareOffTests for that one). Stop/target has its own dedicated coverage in
/// OptionTradeSimulatorStopTargetTests; these isolate the max-holding cutoff by disabling stop/
/// target (slPoints/tpPoints = 0) so it is the only thing that can end the trade.</summary>
public sealed class OptionTradeSimulatorMaxHoldingTimeTests
{
    // 04:00 UTC == 09:30 IST - matches the T0 convention OptionTradeSimulatorSquareOffTests already uses.
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero);

    private static IReadOnlyList<Candle> FlatBars(DateTimeOffset start, int count, decimal price = 100m)
    {
        var bars = new List<Candle>();
        var time = start;
        for (var i = 0; i < count; i++)
        {
            bars.Add(new Candle(time, price, price, price, price));
            time = time.AddMinutes(1);
        }
        return bars;
    }

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
    };

    private static Dictionary<string, decimal> Parameters(decimal maxHoldingBars) => new()
    {
        ["side"] = OptionTradeSimulator.SideBuy,
        ["otmSteps"] = 0,
        ["slPoints"] = 0,
        ["tpPoints"] = 0,
        ["maxHoldingBars"] = maxHoldingBars,
    };

    [Fact]
    public void Run_MaxHoldingBarsReached_ExitsAtThatBarWithMaxHoldingTimeReason()
    {
        var spotBars = FlatBars(T0, 1);
        var optionBars = FlatBars(T0, 30); // 09:30 through 09:59 IST, flat premium
        var context = Context(spotBars, optionBars);

        // Entry fills at 09:31 (signal's own bar close). 5 bars held -> deadline is 4 bars later,
        // 09:35 - the first bar whose own START reaches it; its Close only actually becomes known at
        // 09:36, its real close instant (same barCloseTime reasoning every other forced exit here uses).
        var trades = OptionTradeSimulator.Run(context, new[] { (T0, "Bullish") }, Parameters(5));

        var trade = Assert.Single(trades);
        Assert.Equal("MaxHoldingTime", trade.ExitReason);
        Assert.Equal(new DateTimeOffset(2026, 1, 5, 9, 36, 0, TimeSpan.FromHours(5.5)), trade.ExitTimeUtc);
    }

    [Fact]
    public void Run_MaxHoldingDisabled_NeverFiresMaxHoldingExit()
    {
        var spotBars = FlatBars(T0, 1);
        var optionBars = FlatBars(T0, 30);
        var context = Context(spotBars, optionBars);

        // Same bars as above, but off (0) - the trade must ride past where a 5-bar cap would have
        // cut it off instead of exiting there.
        var trades = OptionTradeSimulator.Run(context, new[] { (T0, "Bullish") }, Parameters(0));

        var trade = Assert.Single(trades);
        Assert.NotEqual("MaxHoldingTime", trade.ExitReason);
    }

    [Fact]
    public void Run_MaxHoldingBarsOfOne_ExitsAtTheVeryFirstBarAfterEntry()
    {
        // "Held for 1 bar" means the position never survives past the very first bar checked after
        // its own entry - the deadline lands exactly at entryTime itself.
        var spotBars = FlatBars(T0, 1);
        var optionBars = FlatBars(T0, 30);
        var context = Context(spotBars, optionBars);

        var trades = OptionTradeSimulator.Run(context, new[] { (T0, "Bullish") }, Parameters(1));

        var trade = Assert.Single(trades);
        Assert.Equal("MaxHoldingTime", trade.ExitReason);
        // Entry fills at 09:31; the very first bar checked is [09:31,09:32) - its own real close
        // instant is 09:32.
        Assert.Equal(new DateTimeOffset(2026, 1, 5, 9, 32, 0, TimeSpan.FromHours(5.5)), trade.ExitTimeUtc);
    }
}

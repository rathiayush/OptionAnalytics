using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers OptionTradeSimulator.Run's squareOffMinutes handling - the daily IST cutoff
/// that forces an open position closed at a fixed time of day, every day, instead of riding to
/// whatever the day's own last bar happens to be. Stop/target has its own dedicated coverage in
/// OptionTradeSimulatorStopTargetTests; these isolate the square-off cutoff by disabling stop/
/// target (slPoints/tpPoints = 0) so it is the only thing that can end the trade.</summary>
public sealed class OptionTradeSimulatorSquareOffTests
{
    // 04:00 UTC == 09:30 IST - matches the T0 convention EmaCrossoverStrategyTests already uses.
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

    private static Dictionary<string, decimal> Parameters(decimal squareOffMinutes) => new()
    {
        ["side"] = OptionTradeSimulator.SideBuy,
        ["otmSteps"] = 0,
        ["slPoints"] = 0,
        ["tpPoints"] = 0,
        ["squareOffMinutes"] = squareOffMinutes,
    };

    [Fact]
    public void Run_SquareOffTimeReached_ExitsAtThatBarWithSquareOffReason()
    {
        var spotBars = FlatBars(T0, 1);
        var optionBars = FlatBars(T0, 30); // 09:30 through 09:59 IST, flat premium
        var context = Context(spotBars, optionBars);

        // 575 = 9*60+35 -> 09:35 IST.
        var trades = OptionTradeSimulator.Run(context, new[] { (T0, "Bullish") }, Parameters(575));

        var trade = Assert.Single(trades);
        Assert.Equal("SquareOff", trade.ExitReason);
        Assert.Equal(new DateTimeOffset(2026, 1, 5, 9, 35, 0, TimeSpan.FromHours(5.5)), trade.ExitTimeUtc);
    }

    [Fact]
    public void Run_SquareOffDisabled_NeverFiresSquareOffExit()
    {
        var spotBars = FlatBars(T0, 1);
        var optionBars = FlatBars(T0, 30);
        var context = Context(spotBars, optionBars);

        // Same bars as above, but off (0) - the trade must ride past where 09:35 would have cut
        // it off instead of exiting there.
        var trades = OptionTradeSimulator.Run(context, new[] { (T0, "Bullish") }, Parameters(0));

        var trade = Assert.Single(trades);
        Assert.NotEqual("SquareOff", trade.ExitReason);
    }

    [Fact]
    public void Run_SquareOffBeforeEntry_ExitsAtTheVeryNextBar()
    {
        // A cutoff earlier than the trade's own entry (09:31 IST) still applies - the position
        // exits at the first bar checked rather than silently riding past a cutoff it never
        // respected.
        var spotBars = FlatBars(T0, 1);
        var optionBars = FlatBars(T0, 30);
        var context = Context(spotBars, optionBars);

        // 570 = 09:30 IST - at/before the signal bar itself.
        var trades = OptionTradeSimulator.Run(context, new[] { (T0, "Bullish") }, Parameters(570));

        var trade = Assert.Single(trades);
        Assert.Equal("SquareOff", trade.ExitReason);
        Assert.Equal(new DateTimeOffset(2026, 1, 5, 9, 31, 0, TimeSpan.FromHours(5.5)), trade.ExitTimeUtc);
    }
}

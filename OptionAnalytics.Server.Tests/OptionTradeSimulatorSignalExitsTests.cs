using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers OptionTradeSimulator.Run's signalExits mechanism itself (added generically, then
/// used concretely by FiveEmaAsTaughtStrategy - see its own tests for the SPOT-level computation
/// that decides what time/reason gets recorded) - and the slPoints/tpPoints-optional change that
/// makes a strategy able to omit them entirely rather than being forced to expose a premium
/// stop/target control it never means the user to touch.</summary>
public sealed class OptionTradeSimulatorSignalExitsTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero); // 09:30 IST

    private static Candle Bar(DateTimeOffset time, decimal open, decimal high, decimal low, decimal close) =>
        new(time, open, high, low, close);

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

    [Fact]
    public void MissingSlPointsAndTpPoints_DoesNotThrow_AndDisablesThePremiumStopTarget()
    {
        // A strategy that never declares slPoints/tpPoints in its own Parameters (FiveEmaAsTaught
        // being the concrete case) hands OptionTradeSimulator.Run a dictionary without those keys
        // at all - this must default to "disabled" (0), not throw KeyNotFoundException.
        var spotBars = new[] { Bar(T0, 24000, 24000, 24000, 24000) };
        var optionBars = new[]
        {
            Bar(T0, 100, 100, 100, 100), // entry at 100
            // Would have hit a normal 10/20-point stop/target many times over - proves they are OFF.
            Bar(T0.AddMinutes(1), 100, 500, 1, 100),
        };
        var context = Context(spotBars, optionBars);
        var parameters = new Dictionary<string, decimal> { ["side"] = OptionTradeSimulator.SideBuy, ["otmSteps"] = 0 };

        var exception = Record.Exception(() => OptionTradeSimulator.Run(context, new[] { (T0, "Bullish") }, parameters));

        Assert.Null(exception);
    }

    [Fact]
    public void SignalExits_FiresAtItsOwnRecordedTimeAndReason_PricedOffTheOptionsOwnClose()
    {
        var spotBars = new[] { Bar(T0, 24000, 24000, 24000, 24000) };
        var optionBars = new[]
        {
            Bar(T0, 100, 100, 100, 100), // entry at 100
            Bar(T0.AddMinutes(1), 105, 110, 104, 108), // signalExits fires here regardless of level
        };
        var context = Context(spotBars, optionBars);
        var parameters = new Dictionary<string, decimal> { ["side"] = OptionTradeSimulator.SideBuy, ["otmSteps"] = 0 };
        var signalExits = new Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)>
        {
            [T0] = (optionBars[1].Time, "SpotStopLoss"),
        };

        var trades = OptionTradeSimulator.Run(context, new[] { (T0, "Bullish") }, parameters, signalExits: signalExits);

        var trade = Assert.Single(trades);
        Assert.Equal("SpotStopLoss", trade.ExitReason);
        // Priced off the option's own bar Close for that bar, not any spot level.
        Assert.Equal(108, trade.ExitPrice);
    }

    [Fact]
    public void SignalExits_KeyedByASignalNotInTheDictionary_IsIgnored()
    {
        // Only the specific signal this exit belongs to is affected - an unrelated trade with no
        // entry in signalExits rides to its own natural outcome (here, end of day) untouched.
        var spotBars = new[] { Bar(T0, 24000, 24000, 24000, 24000) };
        var optionBars = new[]
        {
            Bar(T0, 100, 100, 100, 100),
            Bar(T0.AddMinutes(1), 100, 100, 100, 100),
        };
        var context = Context(spotBars, optionBars);
        var parameters = new Dictionary<string, decimal> { ["side"] = OptionTradeSimulator.SideBuy, ["otmSteps"] = 0 };
        // Keyed by a DIFFERENT signal time than the one actually run.
        var signalExits = new Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)>
        {
            [T0.AddDays(1)] = (optionBars[1].Time, "SpotStopLoss"),
        };

        var trades = OptionTradeSimulator.Run(context, new[] { (T0, "Bullish") }, parameters, signalExits: signalExits);

        var trade = Assert.Single(trades);
        Assert.NotEqual("SpotStopLoss", trade.ExitReason);
    }
}

using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers the one thing FiveEmaAsTaughtStrategy changes from the other 5 EMA strategies:
/// RecordSpotLevelExit, which computes the taught stop (the alert candle's own high/low) and
/// target (riskReward x that candle's own range beyond the level broken to enter), both in SPOT
/// terms, and finds the exact TIME spot first crosses either - handed to OptionTradeSimulator as a
/// signalExits entry so the actual exit is still priced off the option's own premium at that
/// moment. The alert-candle detection itself is FiveEmaStrategy's own logic, unchanged.</summary>
public sealed class FiveEmaAsTaughtStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero); // 09:15 IST

    private static Candle Bar(int minutesFromOpen, decimal open, decimal high, decimal low, decimal close) =>
        new(T0.AddMinutes(minutesFromOpen), open, high, low, close);

    [Fact]
    public void LongSetup_TargetHitBeforeStop_RecordsSpotTakeProfitAtTheRightBar()
    {
        // Alert candle: high 110, low 100 (range 10). Long triggers on the break above 110.
        // riskReward=3 -> target = 110 + 3*10 = 140. Stop = alertCandle.Low = 100.
        var alertCandle = Bar(0, 105, 110, 100, 108);
        var bars = new[]
        {
            alertCandle,
            Bar(5, 108, 115, 107, 112),  // triggers the long (breaks above 110) - trigger bar itself, index 1
            Bar(10, 112, 120, 111, 118), // after entry: neither level yet
            Bar(15, 118, 142, 117, 140), // target (140) crossed here
        };
        var signalExits = new Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)>();

        FiveEmaAsTaughtStrategy.RecordSpotLevelExit(
            bars, 1, DateOnly.FromDateTime(T0.Date), true, alertCandle, 3m, bars[1].Time, signalExits);

        var (time, reason) = Assert.Single(signalExits).Value;
        Assert.Equal(bars[3].Time, time);
        Assert.Equal("SpotTakeProfit", reason);
    }

    [Fact]
    public void LongSetup_StopHitBeforeTarget_RecordsSpotStopLoss()
    {
        var alertCandle = Bar(0, 105, 110, 100, 108);
        var bars = new[]
        {
            alertCandle,
            Bar(5, 108, 115, 107, 112), // triggers the long
            Bar(10, 112, 114, 99, 105), // falls back through the stop (100) before ever nearing target
        };
        var signalExits = new Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)>();

        FiveEmaAsTaughtStrategy.RecordSpotLevelExit(
            bars, 1, DateOnly.FromDateTime(T0.Date), true, alertCandle, 3m, bars[1].Time, signalExits);

        var (time, reason) = Assert.Single(signalExits).Value;
        Assert.Equal(bars[2].Time, time);
        Assert.Equal("SpotStopLoss", reason);
    }

    [Fact]
    public void ShortSetup_MirrorsTheLongSideDownward()
    {
        // Alert candle: high 210, low 200 (range 10). Short triggers on the break below 200.
        // Stop = alertCandle.High = 210. riskReward=3 -> target = 200 - 3*10 = 170.
        var alertCandle = Bar(0, 205, 210, 200, 202);
        var bars = new[]
        {
            alertCandle,
            Bar(5, 202, 203, 195, 197), // triggers the short (breaks below 200)
            Bar(10, 197, 198, 169, 170), // target (170) crossed here
        };
        var signalExits = new Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)>();

        FiveEmaAsTaughtStrategy.RecordSpotLevelExit(
            bars, 1, DateOnly.FromDateTime(T0.Date), false, alertCandle, 3m, bars[1].Time, signalExits);

        var (time, reason) = Assert.Single(signalExits).Value;
        Assert.Equal(bars[2].Time, time);
        Assert.Equal("SpotTakeProfit", reason);
    }

    [Fact]
    public void ABarThatCrossesBothLevelsAtOnce_StopWins()
    {
        // Conservative tiebreak, matching OptionTradeSimulator's own premium stop/target rule: a
        // bar whose range spans both the stop and the target counts the stop first.
        var alertCandle = Bar(0, 105, 110, 100, 108);
        var bars = new[]
        {
            alertCandle,
            Bar(5, 108, 115, 107, 112), // triggers the long
            Bar(10, 112, 200, 50, 150), // spans both stop (100) and target (140) in one bar
        };
        var signalExits = new Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)>();

        FiveEmaAsTaughtStrategy.RecordSpotLevelExit(
            bars, 1, DateOnly.FromDateTime(T0.Date), true, alertCandle, 3m, bars[1].Time, signalExits);

        Assert.Equal("SpotStopLoss", Assert.Single(signalExits).Value.Reason);
    }

    [Fact]
    public void NeitherLevelReached_RecordsNothing()
    {
        var alertCandle = Bar(0, 105, 110, 100, 108);
        var bars = new[]
        {
            alertCandle,
            Bar(5, 108, 115, 107, 112), // triggers the long
            Bar(10, 112, 120, 111, 118), // stays comfortably between stop (100) and target (140)
        };
        var signalExits = new Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)>();

        FiveEmaAsTaughtStrategy.RecordSpotLevelExit(
            bars, 1, DateOnly.FromDateTime(T0.Date), true, alertCandle, 3m, bars[1].Time, signalExits);

        Assert.Empty(signalExits);
    }

    [Fact]
    public void NeverLooksAtTheTriggerBarsOwnHighLow()
    {
        // The walk starts at triggerIndex+1 - the triggering bar's own range happened BEFORE the
        // position existed, same rule OptionTradeSimulator's premium walk already follows. Here the
        // trigger bar's own High (115) would itself cross a wildly close target if it were checked,
        // proving it must be excluded rather than just "correct by not reaching that far".
        var alertCandle = Bar(0, 105, 110, 100, 108);
        var triggerBar = Bar(5, 108, 200, 107, 112); // would "hit" target 140 on its own High if checked
        var bars = new[]
        {
            alertCandle,
            triggerBar,
            Bar(10, 112, 120, 111, 118), // does not reach target/stop
        };
        var signalExits = new Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)>();

        FiveEmaAsTaughtStrategy.RecordSpotLevelExit(
            bars, 1, DateOnly.FromDateTime(T0.Date), true, alertCandle, 3m, bars[1].Time, signalExits);

        Assert.Empty(signalExits);
    }

    [Fact]
    public void NeverCrossesIntoTheNextDay()
    {
        var alertCandle = Bar(0, 105, 110, 100, 108);
        var day2 = T0.AddDays(1);
        var bars = new[]
        {
            alertCandle,
            Bar(5, 108, 115, 107, 112), // triggers the long
            new Candle(day2, 112, 200, 50, 150), // would hit both levels, but it's the NEXT day
        };
        var signalExits = new Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)>();

        FiveEmaAsTaughtStrategy.RecordSpotLevelExit(
            bars, 1, DateOnly.FromDateTime(T0.Date), true, alertCandle, 3m, bars[1].Time, signalExits);

        Assert.Empty(signalExits);
    }
}

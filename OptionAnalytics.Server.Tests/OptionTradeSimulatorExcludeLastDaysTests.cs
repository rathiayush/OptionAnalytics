using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers OptionTradeSimulator.Run's excludeLastDays handling - skipping any entry within
/// N calendar day(s) of the window's own last day (the real expiry date, for an Expired Backtest
/// run), added for option selling near a weekly/monthly expiry where too little premium is left to
/// sell profitably. Stop/target has its own dedicated coverage elsewhere; these isolate the
/// exclusion by disabling stop/target (slPoints/tpPoints = 0) so every trade rides to its own day's
/// end and the only thing that changes between cases is which signals are excluded outright.</summary>
public sealed class OptionTradeSimulatorExcludeLastDaysTests
{
    // Three distinct trading days, 04:00 UTC == 09:30 IST each (matches the T0 convention other
    // OptionTradeSimulator tests already use).
    private static readonly DateTimeOffset Day1 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset Day2 = new(2026, 1, 6, 4, 0, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset Day3 = new(2026, 1, 7, 4, 0, 0, TimeSpan.Zero);

    private static Candle Bar(DateTimeOffset time, decimal price = 100m) => new(time, price, price, price, price);

    private static IReadOnlyList<Candle> FlatBars(DateTimeOffset start, int count, decimal price = 100m)
    {
        var bars = new List<Candle>();
        for (var i = 0; i < count; i++) bars.Add(Bar(start.AddMinutes(i), price));
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

    private static Dictionary<string, decimal> Parameters(decimal excludeLastDays) => new()
    {
        ["side"] = OptionTradeSimulator.SideSell,
        ["otmSteps"] = 0,
        ["slPoints"] = 0,
        ["tpPoints"] = 0,
        ["excludeLastDays"] = excludeLastDays,
    };

    private static IReadOnlyList<BacktestTrade> RunAllThreeDays(decimal excludeLastDays)
    {
        var spotBars = new List<Candle> { Bar(Day1), Bar(Day2), Bar(Day3) };
        var optionBars = FlatBars(Day1, 5).Concat(FlatBars(Day2, 5)).Concat(FlatBars(Day3, 5)).ToList();
        var context = Context(spotBars, optionBars);
        var signals = new[] { (Day1, "Bullish"), (Day2, "Bullish"), (Day3, "Bullish") };

        return OptionTradeSimulator.Run(context, signals, Parameters(excludeLastDays));
    }

    [Fact]
    public void Off_AllThreeDaysTrade()
    {
        var trades = RunAllThreeDays(excludeLastDays: 0);

        Assert.Equal(3, trades.Count);
    }

    [Fact]
    public void ExcludeLastDay_SkipsOnlyTheWindowsFinalDay()
    {
        // The window's last day is Day3 (the "real expiry"), so excludeLastDays=1 drops only
        // Day3's own signal - Day1 and Day2 still trade normally.
        var trades = RunAllThreeDays(excludeLastDays: 1);

        Assert.Equal(2, trades.Count);
        Assert.DoesNotContain(trades, t => t.SignalTimeUtc == Day3);
    }

    [Fact]
    public void ExcludeLastTwoDays_SkipsTheFinalTwoDaysOnly()
    {
        var trades = RunAllThreeDays(excludeLastDays: 2);

        var trade = Assert.Single(trades);
        Assert.Equal(Day1, trade.SignalTimeUtc);
    }

    [Fact]
    public void ExcludeAllThreeDays_LeavesNoTradesAtAll()
    {
        var trades = RunAllThreeDays(excludeLastDays: 3);

        Assert.Empty(trades);
    }

    [Fact]
    public void ExcludedEntry_IsDroppedOutright_NotReportedAsNoData()
    {
        // A deliberate exclusion is not a data gap - it must never show up as BacktestTrade.NoData,
        // which specifically means "this app tried and found nothing tracked".
        var trades = RunAllThreeDays(excludeLastDays: 3);

        Assert.DoesNotContain(trades, t => t.ExitReason == "NoData");
    }
}

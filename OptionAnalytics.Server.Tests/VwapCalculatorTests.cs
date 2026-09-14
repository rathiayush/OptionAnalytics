using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

public sealed class VwapCalculatorTests
{
    private static readonly DateTimeOffset Day1Start = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero); // 09:15 IST
    private static readonly DateTimeOffset Day2Start = new(2026, 1, 6, 3, 45, 0, TimeSpan.Zero); // next trading day, 09:15 IST

    [Fact]
    public void AccumulatesTypicalPriceWeightedByVolume_WithinOneDay()
    {
        var bars = new[]
        {
            new CandleWithVolume(Day1Start, 99, 102, 98, 100, 100),
            new CandleWithVolume(Day1Start.AddMinutes(1), 100, 104, 100, 102, 200),
        };

        var series = VwapCalculator.ComputeSeries(bars);

        Assert.Equal(2, series.Count);
        Assert.Equal(100m, series[0].Obv); // typical(100) with nothing else yet -> just that bar's own typical price
        // cumPV = 100*100 + 102*200 = 10000 + 20400 = 30400; cumV = 300 -> 101.333...
        Assert.Equal(101.3333m, Math.Round(series[1].Obv, 4));
    }

    [Fact]
    public void ResetsToZero_AtEachNewIstTradingDay()
    {
        var bars = new[]
        {
            new CandleWithVolume(Day1Start, 99, 102, 98, 100, 100),
            new CandleWithVolume(Day1Start.AddMinutes(1), 100, 104, 100, 102, 200),
            new CandleWithVolume(Day2Start, 106, 110, 106, 108, 50),
        };

        var series = VwapCalculator.ComputeSeries(bars);

        Assert.Equal(3, series.Count);
        // Day 2's first bar must not carry any of day 1's accumulated volume forward - its VWAP is
        // exactly that bar's own typical price, not blended with the previous day's close.
        Assert.Equal(108m, series[2].Obv);
    }

    [Fact]
    public void EmitsNoPoint_ForABarBeforeTheDaysFirstRealVolume()
    {
        var bars = new[]
        {
            new CandleWithVolume(Day1Start, 99, 102, 98, 100, 0),
            new CandleWithVolume(Day1Start.AddMinutes(1), 100, 104, 100, 102, 0),
            new CandleWithVolume(Day1Start.AddMinutes(2), 101, 106, 101, 104, 50),
        };

        var series = VwapCalculator.ComputeSeries(bars);

        // Only the third bar (the first with any real volume) produces a VWAP point - a caller
        // looking up "VWAP as of the first or second bar's time" correctly finds nothing at all,
        // not a fabricated zero or the bar's own price standing in for it.
        var point = Assert.Single(series);
        Assert.Equal(Day1Start.AddMinutes(2), point.Time);
    }
}

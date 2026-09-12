using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers VwmaCloseCrossStrategy.VwmaSeries - the whole strategy's arithmetic, pulled out
/// for direct testing because the live CDV/Dhan state the rest of it reads has no test harness.
///
/// The case worth pinning hardest is the volume fallback: an index has no volume of its own, so this
/// VWMA borrows the ATM option chain's, and a window with none of that must degrade to an unweighted
/// mean rather than going undefined - otherwise the line would vanish for the early part of every
/// session, suppressing exactly the signals a morning-heavy strategy wants.</summary>
public sealed class VwmaCloseCrossStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero);

    private static DateTimeOffset At(int minute) => T0.AddMinutes(minute);

    private static Candle Bar(int minute, decimal close) => new(At(minute), close, close, close, close);

    [Fact]
    public void WeightsEachCloseByItsOwnVolume()
    {
        // Two bars, 100 at weight 1 and 200 at weight 3: (100*1 + 200*3) / 4 = 175, NOT the
        // unweighted 150. This is the entire point of the "volume weighted" part.
        var bars = new[] { Bar(0, 100), Bar(1, 200) };
        var volume = new Dictionary<DateTimeOffset, long> { [At(0)] = 1, [At(1)] = 3 };

        var series = VwmaCloseCrossStrategy.VwmaSeries(bars, volume, period: 2);

        Assert.Null(series[0]); // not enough bars to average yet
        Assert.Equal(175m, series[1]);
    }

    [Fact]
    public void NoVolumeAtAll_FallsBackToTheUnweightedMean()
    {
        // The whole window is missing from the volume map - before the ATM contracts started being
        // tracked, say. The line must still exist, as the plain average of the same closes.
        var bars = new[] { Bar(0, 100), Bar(1, 200) };

        var series = VwmaCloseCrossStrategy.VwmaSeries(bars, new Dictionary<DateTimeOffset, long>(), period: 2);

        Assert.Equal(150m, series[1]);
    }

    [Fact]
    public void ZeroVolumeBarsAreIgnoredRatherThanDraggingTheAverage()
    {
        // A bar that did not trade contributes no weight, so it must not pull the line toward its
        // price. Only the 200-close carries volume here, so the line sits exactly on it.
        var bars = new[] { Bar(0, 100), Bar(1, 200) };
        var volume = new Dictionary<DateTimeOffset, long> { [At(0)] = 0, [At(1)] = 5 };

        var series = VwmaCloseCrossStrategy.VwmaSeries(bars, volume, period: 2);

        Assert.Equal(200m, series[1]);
    }

    [Fact]
    public void TheWindowRollsRatherThanCoveringEverythingSoFar()
    {
        // A 2-bar VWMA at index 2 must average bars 1 and 2 only - a cumulative average would keep
        // the first bar's 100 in forever and the line would stop tracking price.
        var bars = new[] { Bar(0, 100), Bar(1, 200), Bar(2, 300) };
        var volume = new Dictionary<DateTimeOffset, long> { [At(0)] = 1, [At(1)] = 1, [At(2)] = 1 };

        var series = VwmaCloseCrossStrategy.VwmaSeries(bars, volume, period: 2);

        Assert.Equal(150m, series[1]); // (100 + 200) / 2
        Assert.Equal(250m, series[2]); // (200 + 300) / 2 - bar 0 has rolled off
    }

    [Fact]
    public void ShorterHistoryThanThePeriod_HasNoLineAtAll()
    {
        // Never average a partial window: a 20-bar VWMA over 3 bars is not a 20-bar VWMA, and
        // signalling off it would fire on a line that means something different every bar.
        var bars = new[] { Bar(0, 100), Bar(1, 200), Bar(2, 300) };

        var series = VwmaCloseCrossStrategy.VwmaSeries(bars, new Dictionary<DateTimeOffset, long>(), period: 20);

        Assert.All(series, v => Assert.Null(v));
    }

    [Fact]
    public void VolumeByTime_SumsBothLegsInTheSameBucket()
    {
        // The weight is meant to say "how much did the chain trade around this price", which is CE
        // and PE together - taking one leg alone would halve the weight of a two-sided bar.
        var context = ContextWith(
            ce: new[] { new CandleWithVolume(At(0), 10, 10, 10, 10, 7) },
            pe: new[] { new CandleWithVolume(At(0), 20, 20, 20, 20, 5) });

        var byTime = VwmaCloseCrossStrategy.VolumeByTime(context);

        Assert.Equal(12, byTime[At(0)]);
    }

    private static BacktestStrategyContext ContextWith(CandleWithVolume[] ce, CandleWithVolume[] pe) => new()
    {
        Underlying = "NIFTY",
        TimeframeMinutes = 1,
        Step = 50,
        SpotBars = Array.Empty<Candle>(),
        ConfluenceSignalsAscending = Array.Empty<BacktestSignal>(),
        AllSignals = Array.Empty<BacktestSignal>(),
        ObvCeSeries = Array.Empty<ObvPoint>(),
        ObvPeSeries = Array.Empty<ObvPoint>(),
        CdvCeSeries = Array.Empty<ObvPoint>(),
        CdvPeSeries = Array.Empty<ObvPoint>(),
        GetOptionBars = (_, _) => Array.Empty<Candle>(),
        AtmCeBars = Array.Empty<Candle>(),
        AtmPeBars = Array.Empty<Candle>(),
        AtmCeVolumeBars = ce,
        AtmPeVolumeBars = pe,
        AtmStrike = null,
    };
}

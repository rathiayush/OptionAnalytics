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
    public void MatchesTradingViewsTaVwma()
    {
        // ta.vwma(src, len) is sma(src*volume, len) / sma(volume, len); the len divisor cancels,
        // leaving sum(src*vol)/sum(vol). Worked by hand over three bars:
        // (10*1 + 20*2 + 30*3) / (1+2+3) = 140/6.
        var bars = new[] { Bar(0, 10), Bar(1, 20), Bar(2, 30) };
        var volume = new Dictionary<DateTimeOffset, long> { [At(0)] = 1, [At(1)] = 2, [At(2)] = 3 };

        var series = VwmaCloseCrossStrategy.VwmaSeries(bars, volume, period: 3);

        Assert.Equal(140m / 6m, series[2]);
    }

    [Theory]
    // TradingView's own source set, computed its way - hl2 = (H+L)/2, hlc3 = (H+L+C)/3,
    // ohlc4 = (O+H+L+C)/4 - on a bar of O=10 H=20 L=30 C=40 (deliberately not a real candle shape,
    // so each formula lands on a distinct number rather than coinciding).
    [InlineData(0, 40)]  // close
    [InlineData(1, 10)]  // open
    [InlineData(2, 20)]  // high
    [InlineData(3, 30)]  // low
    [InlineData(4, 25)]  // hl2   = (20+30)/2
    [InlineData(5, 30)]  // hlc3  = (20+30+40)/3
    [InlineData(6, 25)]  // ohlc4 = (10+20+30+40)/4
    public void SourcePrice_MatchesTradingViewsFormulas(int source, decimal expected)
    {
        var bar = new Candle(At(0), Open: 10, High: 20, Low: 30, Close: 40);

        Assert.Equal(expected, VwmaCloseCrossStrategy.SourcePrice(bar, source));
    }

    [Fact]
    public void TheSourceChangesTheLineNotJustItsLabel()
    {
        // Same bars, same volume, different source - the hl2 line must differ from the close line,
        // otherwise the input is decorative.
        var bars = new[]
        {
            new Candle(At(0), Open: 10, High: 30, Low: 10, Close: 20),
            new Candle(At(1), Open: 20, High: 60, Low: 20, Close: 40),
        };
        var volume = new Dictionary<DateTimeOffset, long> { [At(0)] = 1, [At(1)] = 1 };

        var onClose = VwmaCloseCrossStrategy.VwmaSeries(bars, volume, period: 2, source: 0);
        var onHl2 = VwmaCloseCrossStrategy.VwmaSeries(bars, volume, period: 2, source: 4);

        Assert.Equal(30m, onClose[1]); // (20 + 40) / 2
        Assert.Equal(30m, onHl2[1]);   // ((30+10)/2 + (60+20)/2) / 2 = (20 + 40) / 2
        Assert.Equal(onClose[1], onHl2[1]); // coincide here by construction...

        // ...so shift one bar's range to prove they genuinely track different inputs.
        var skewed = new[]
        {
            bars[0],
            new Candle(At(1), Open: 20, High: 100, Low: 20, Close: 40),
        };
        var skewedHl2 = VwmaCloseCrossStrategy.VwmaSeries(skewed, volume, period: 2, source: 4);

        Assert.NotEqual(onClose[1], skewedHl2[1]);
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

    [Fact]
    public void VolumeByTime_PrefersTheFuturesVolumeWhenItExists()
    {
        // The front-month future is the honest weight for an index - the most liquid single
        // instrument on the underlying - so when it is available the option chain's volume must not
        // be mixed in or added on top. The answer here is the future's 99, not 99+12.
        var context = ContextWith(
            ce: new[] { new CandleWithVolume(At(0), 10, 10, 10, 10, 7) },
            pe: new[] { new CandleWithVolume(At(0), 20, 20, 20, 20, 5) },
            futures: new[] { new CandleWithVolume(At(0), 100, 100, 100, 100, 99) });

        var byTime = VwmaCloseCrossStrategy.VolumeByTime(context);

        Assert.Equal(99, byTime[At(0)]);
    }

    [Fact]
    public void VolumeByTime_FallsBackToOptionVolumeWhenNoFutureResolved()
    {
        // No future (none listed, or Dhan served nothing) must not mean no weights at all - the
        // option chain is a worse measure of the underlying's activity but far better than none.
        var context = ContextWith(
            ce: new[] { new CandleWithVolume(At(0), 10, 10, 10, 10, 7) },
            pe: new[] { new CandleWithVolume(At(0), 20, 20, 20, 20, 5) },
            futures: Array.Empty<CandleWithVolume>());

        var byTime = VwmaCloseCrossStrategy.VolumeByTime(context);

        Assert.Equal(12, byTime[At(0)]);
    }

    private static BacktestStrategyContext ContextWith(CandleWithVolume[] ce, CandleWithVolume[] pe, CandleWithVolume[]? futures = null) => new()
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
        FuturesVolumeBars = futures ?? Array.Empty<CandleWithVolume>(),
        AtmStrike = null,
    };
}

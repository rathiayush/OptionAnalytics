using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers EmaCrossAtmFlowStrategy's three confirmation gates in isolation - the cross
/// detector, the "did the option leg cross recently enough" window, the "is flow rising" test, and
/// the OBV/CDV mode combination. Pulled out because the strategy as a whole reads live CDV/Dhan
/// state this project has no harness for.</summary>
public sealed class EmaCrossAtmFlowStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero);

    private static DateTimeOffset At(int minute) => T0.AddMinutes(minute);

    // ---- CrossedUp -----------------------------------------------------------------------------

    [Fact]
    public void CrossedUp_DetectsTheBarTheLinesActuallyCrossOn()
    {
        // fast goes from below slow to above it at index 1 - that bar, and only that bar, is the
        // cross.
        var fast = new decimal?[] { 5m, 15m };
        var slow = new decimal?[] { 10m, 10m };

        Assert.True(EmaCrossAtmFlowStrategy.CrossedUp(fast, slow, 1, out var bullish));
        Assert.True(bullish);
    }

    [Fact]
    public void CrossedUp_ReportsTheBearishCrossToo()
    {
        var fast = new decimal?[] { 15m, 5m };
        var slow = new decimal?[] { 10m, 10m };

        Assert.True(EmaCrossAtmFlowStrategy.CrossedUp(fast, slow, 1, out var bullish));
        Assert.False(bullish);
    }

    [Fact]
    public void CrossedUp_StayingOnTheSameSideIsNotACross()
    {
        // Already above and still above: a state, not an event. Signalling here would re-enter on
        // every bar of a trend instead of once at its start.
        var fast = new decimal?[] { 15m, 20m };
        var slow = new decimal?[] { 10m, 10m };

        Assert.False(EmaCrossAtmFlowStrategy.CrossedUp(fast, slow, 1, out _));
    }

    [Fact]
    public void CrossedUp_NeedsBothBarsReadable()
    {
        // A null on either side is "no opinion yet" - the EMA has not warmed up - and must never be
        // read as a cross.
        var fast = new decimal?[] { null, 15m };
        var slow = new decimal?[] { 10m, 10m };

        Assert.False(EmaCrossAtmFlowStrategy.CrossedUp(fast, slow, 1, out _));
        Assert.False(EmaCrossAtmFlowStrategy.CrossedUp(fast, slow, 0, out _)); // no previous bar at all
    }

    // ---- CrossedWithin -------------------------------------------------------------------------

    [Fact]
    public void CrossedWithin_AcceptsACrossInsideTheBackwardWindow()
    {
        var crosses = new[] { At(8) };

        Assert.True(EmaCrossAtmFlowStrategy.CrossedWithin(crosses, At(10), TimeSpan.FromMinutes(5)));
    }

    [Fact]
    public void CrossedWithin_RejectsACrossOlderThanTheWindow()
    {
        var crosses = new[] { At(2) };

        Assert.False(EmaCrossAtmFlowStrategy.CrossedWithin(crosses, At(10), TimeSpan.FromMinutes(5)));
    }

    [Fact]
    public void CrossedWithin_NeverLooksForward()
    {
        // The confirming cross happens AFTER the entry bar. Counting it would be look-ahead: at the
        // moment of entry it had not happened and could not have been acted on.
        var crosses = new[] { At(12) };

        Assert.False(EmaCrossAtmFlowStrategy.CrossedWithin(crosses, At(10), TimeSpan.FromMinutes(5)));
    }

    [Fact]
    public void CrossedWithin_ZeroWindowMeansTheSameBarOnly()
    {
        Assert.True(EmaCrossAtmFlowStrategy.CrossedWithin(new[] { At(10) }, At(10), TimeSpan.Zero));
        Assert.False(EmaCrossAtmFlowStrategy.CrossedWithin(new[] { At(9) }, At(10), TimeSpan.Zero));
    }

    // ---- IsRising ------------------------------------------------------------------------------

    [Fact]
    public void IsRising_ComparesAgainstTheValueOneWindowBack()
    {
        var series = new[] { new ObvPoint(At(0), 100), new ObvPoint(At(5), 120), new ObvPoint(At(10), 140) };

        Assert.True(EmaCrossAtmFlowStrategy.IsRising(series, At(10), TimeSpan.FromMinutes(5)));
    }

    [Fact]
    public void IsRising_FallingOrFlatIsNotRising()
    {
        var falling = new[] { new ObvPoint(At(5), 200), new ObvPoint(At(10), 150) };
        Assert.False(EmaCrossAtmFlowStrategy.IsRising(falling, At(10), TimeSpan.FromMinutes(5)));

        // Exactly equal is not rising either - "not falling" is a weaker claim than the filter makes.
        var flat = new[] { new ObvPoint(At(5), 150), new ObvPoint(At(10), 150) };
        Assert.False(EmaCrossAtmFlowStrategy.IsRising(flat, At(10), TimeSpan.FromMinutes(5)));
    }

    [Fact]
    public void IsRising_ReadsTheLastPointAtOrBeforeEachEnd()
    {
        // The flow series need not have a point exactly on the spot bar's timestamp - it is read as
        // "the last value known by then", which is what makes this work across series that do not
        // share an index.
        var series = new[] { new ObvPoint(At(1), 100), new ObvPoint(At(7), 130) };

        Assert.True(EmaCrossAtmFlowStrategy.IsRising(series, At(10), TimeSpan.FromMinutes(5)));
    }

    [Fact]
    public void IsRising_NoReadingAtEitherEndIsNotRising()
    {
        // Nothing before the window starts: "no data" must not pass a filter whose whole job is to
        // require evidence.
        var series = new[] { new ObvPoint(At(9), 100), new ObvPoint(At(10), 200) };

        Assert.False(EmaCrossAtmFlowStrategy.IsRising(series, At(10), TimeSpan.FromMinutes(5)));
        Assert.False(EmaCrossAtmFlowStrategy.IsRising(Array.Empty<ObvPoint>(), At(10), TimeSpan.FromMinutes(5)));
    }

    // ---- FlowConfirms --------------------------------------------------------------------------

    [Theory]
    [InlineData(0, true, false, true)]    // OBV only  - OBV rising is enough
    [InlineData(0, false, true, false)]   // OBV only  - CDV rising does not count
    [InlineData(1, false, true, true)]    // CDV only
    [InlineData(1, true, false, false)]   // CDV only  - OBV rising does not count
    [InlineData(2, true, false, true)]    // Either
    [InlineData(2, false, false, false)]  // Either    - neither rising fails
    [InlineData(3, true, true, true)]     // Both
    [InlineData(3, true, false, false)]   // Both      - one is not enough
    public void FlowConfirms_HonoursEachMode(int mode, bool obvRising, bool cdvRising, bool expected)
    {
        Assert.Equal(expected, EmaCrossAtmFlowStrategy.FlowConfirms(mode, obvRising, cdvRising));
    }

    // ---- CrossUpTimes --------------------------------------------------------------------------

    [Fact]
    public void CrossUpTimes_IgnoresTheFirstBarOfEachDay()
    {
        // An overnight gap can flip the EMA relationship with no trade in between. A "cross" on the
        // first bar of a session is that gap, not a move anyone could have traded.
        var day1 = Enumerable.Range(0, 40).Select(i => Bar(T0.AddMinutes(i), 100 - i)).ToList();
        var day2Start = T0.AddDays(1);
        var day2 = Enumerable.Range(0, 40).Select(i => Bar(day2Start.AddMinutes(i), 500 + i)).ToList();

        var times = EmaCrossAtmFlowStrategy.CrossUpTimes(day1.Concat(day2).ToList(), 3, 8);

        Assert.DoesNotContain(day2Start, times);
    }

    private static Candle Bar(DateTimeOffset time, decimal close) => new(time, close, close, close, close);
}

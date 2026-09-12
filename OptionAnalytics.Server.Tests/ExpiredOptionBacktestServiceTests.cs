using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers ExpiredOptionBacktestService.ComputeExpiryCode - the derivation from an actual
/// calendar expiry date to Dhan's own expiryCode parameter (see that method's own doc comment for
/// why counting whole cycles is robust even though the exact weekday a weekly expiry lands on can
/// shift around a holiday).</summary>
public sealed class ExpiredOptionBacktestServiceTests
{
    [Fact]
    public void Weekly_CountsWholeSevenDayCycles()
    {
        // A 30-day lookback is a little over 4 weeks - rounds to the nearest whole cycle count.
        var code = ExpiredOptionBacktestService.ComputeExpiryCode("WEEK", new DateOnly(2024, 8, 1), new DateOnly(2024, 8, 29));

        Assert.Equal(4, code);
    }

    [Fact]
    public void Weekly_ExactlyOneWeekApart_IsOne()
    {
        var code = ExpiredOptionBacktestService.ComputeExpiryCode("WEEK", new DateOnly(2024, 8, 1), new DateOnly(2024, 8, 8));

        Assert.Equal(1, code);
    }

    [Fact]
    public void Weekly_SameDay_IsZero()
    {
        var code = ExpiredOptionBacktestService.ComputeExpiryCode("WEEK", new DateOnly(2024, 8, 1), new DateOnly(2024, 8, 1));

        Assert.Equal(0, code);
    }

    [Fact]
    public void Monthly_CountsCalendarMonthsElapsed_RegardlessOfDayOfMonth()
    {
        // Spans a month boundary with mismatched days-of-month - exact by calendar month, not by
        // any fixed day-count approximation (a monthly expiry happens once per month regardless of
        // holidays, unlike weekly's fixed-cadence approximation).
        var code = ExpiredOptionBacktestService.ComputeExpiryCode("MONTH", new DateOnly(2024, 6, 15), new DateOnly(2024, 8, 29));

        Assert.Equal(2, code);
    }

    [Fact]
    public void Monthly_SameCalendarMonth_IsZero()
    {
        var code = ExpiredOptionBacktestService.ComputeExpiryCode("MONTH", new DateOnly(2024, 8, 1), new DateOnly(2024, 8, 29));

        Assert.Equal(0, code);
    }

    [Fact]
    public void ClampsToTheEndpointsSupportedRange()
    {
        // A very wide lookback must never ask Dhan for an expiryCode past what the endpoint
        // documents (0-10), even though the raw cycle count would be far larger.
        var weekly = ExpiredOptionBacktestService.ComputeExpiryCode("WEEK", new DateOnly(2020, 1, 1), new DateOnly(2024, 8, 29));
        var monthly = ExpiredOptionBacktestService.ComputeExpiryCode("MONTH", new DateOnly(2020, 1, 1), new DateOnly(2024, 8, 29));

        Assert.Equal(10, weekly);
        Assert.Equal(10, monthly);
    }

    [Fact]
    public void NeverNegative_EvenIfCalledWithAnInvertedRange()
    {
        var code = ExpiredOptionBacktestService.ComputeExpiryCode("WEEK", new DateOnly(2024, 8, 29), new DateOnly(2024, 8, 1));

        Assert.Equal(0, code);
    }

    private static CandleWithVolume Bar(DateTimeOffset time, decimal open, decimal close) =>
        new(time, open, Math.Max(open, close), Math.Min(open, close), close, 0);

    [Fact]
    public void DetectPossibleSplices_SmoothDecay_FindsNothing()
    {
        // A real option premium decaying smoothly toward its own expiry - no bar-to-bar jump should
        // ever read as a possible splice.
        var start = new DateTimeOffset(2024, 8, 1, 9, 15, 0, TimeSpan.FromHours(5.5));
        var bars = new List<CandleWithVolume>();
        for (var i = 0; i < 20; i++)
            bars.Add(Bar(start.AddMinutes(i), 100m - i, 100m - i - 1));

        var splices = ExpiredOptionBacktestService.DetectPossibleSplices(bars);

        Assert.Empty(splices);
    }

    [Fact]
    public void DetectPossibleSplices_FlagsALargeJumpBetweenConsecutiveBars()
    {
        var t0 = new DateTimeOffset(2024, 8, 1, 9, 15, 0, TimeSpan.FromHours(5.5));
        var t1 = t0.AddMinutes(1);
        // A near-worthless, about-to-expire contract's last print (close 2) spliced onto a fresh
        // contract's own much higher opening premium (open 40) - a 20x jump, the exact shape a real
        // single contract's own premium never produces minute to minute.
        var bars = new List<CandleWithVolume> { Bar(t0, 3m, 2m), Bar(t1, 40m, 38m) };

        var splices = ExpiredOptionBacktestService.DetectPossibleSplices(bars);

        Assert.Equal(new[] { t1 }, splices);
    }

    [Fact]
    public void DetectPossibleSplices_IgnoresZeroOrNegativePrices()
    {
        // A genuinely worthless expired print (0) must never divide-by-zero or read as an infinite
        // jump - skipped rather than flagged.
        var t0 = new DateTimeOffset(2024, 8, 1, 9, 15, 0, TimeSpan.FromHours(5.5));
        var bars = new List<CandleWithVolume> { Bar(t0, 0m, 0m), Bar(t0.AddMinutes(1), 5m, 4m) };

        var splices = ExpiredOptionBacktestService.DetectPossibleSplices(bars);

        Assert.Empty(splices);
    }

    [Fact]
    public void DetectPossibleSplices_CapsAtTenEvenWithManyJumps()
    {
        var t0 = new DateTimeOffset(2024, 8, 1, 9, 15, 0, TimeSpan.FromHours(5.5));
        var bars = new List<CandleWithVolume>();
        for (var i = 0; i < 30; i++)
        {
            // Alternates 2 <-> 40 every bar - every single transition qualifies as a big jump.
            var price = i % 2 == 0 ? 2m : 40m;
            bars.Add(Bar(t0.AddMinutes(i), price, price));
        }

        var splices = ExpiredOptionBacktestService.DetectPossibleSplices(bars);

        Assert.Equal(10, splices.Count);
    }
}

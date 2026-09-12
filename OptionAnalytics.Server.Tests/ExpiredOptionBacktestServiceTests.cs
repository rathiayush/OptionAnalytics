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
}

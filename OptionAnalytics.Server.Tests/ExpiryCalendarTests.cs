using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers ExpiryCalendar - the computed real-expiry dates that
/// ExpiredOptionBacktestService.GetAvailableExpiries restricts its own "give me an expiry date"
/// input to, replacing the free-form date field that let a non-real expiry break the fromDate
/// anchoring this whole feature depends on (see that class's own doc comment).</summary>
public sealed class ExpiryCalendarTests
{
    [Fact]
    public void WeeklyExpiries_ReturnsEveryTuesdayInRange()
    {
        // 1 Aug 2026 (Sat) to 31 Aug 2026 (Mon) - Tuesdays are 4, 11, 18, 25.
        var expiries = ExpiryCalendar.WeeklyExpiries(new DateOnly(2026, 8, 1), new DateOnly(2026, 8, 31));

        Assert.Equal(
            new[] { new DateOnly(2026, 8, 4), new DateOnly(2026, 8, 11), new DateOnly(2026, 8, 18), new DateOnly(2026, 8, 25) },
            expiries);
    }

    [Fact]
    public void WeeklyExpiries_EveryResultIsActuallyATuesday()
    {
        var expiries = ExpiryCalendar.WeeklyExpiries(new DateOnly(2025, 1, 1), new DateOnly(2026, 12, 31));

        Assert.NotEmpty(expiries);
        Assert.All(expiries, d => Assert.Equal(DayOfWeek.Tuesday, d.DayOfWeek));
    }

    [Fact]
    public void MonthlyExpiries_ReturnsTheLastTuesdayOfEachMonth()
    {
        // Confirmed by hand: 25 Aug 2026 is the last Tuesday of August (1 Sep 2026 is also a
        // Tuesday, exactly one week later, so Aug has no Tuesday after the 25th).
        var expiries = ExpiryCalendar.MonthlyExpiries(new DateOnly(2026, 8, 1), new DateOnly(2026, 9, 30));

        Assert.Equal(new[] { new DateOnly(2026, 8, 25), new DateOnly(2026, 9, 29) }, expiries);
    }

    [Fact]
    public void MonthlyExpiries_EveryResultIsActuallyATuesday()
    {
        var expiries = ExpiryCalendar.MonthlyExpiries(new DateOnly(2025, 1, 1), new DateOnly(2026, 12, 31));

        Assert.NotEmpty(expiries);
        Assert.All(expiries, d => Assert.Equal(DayOfWeek.Tuesday, d.DayOfWeek));
    }

    [Fact]
    public void MonthlyExpiries_ExcludesAMonthWhoseOwnLastTuesdayFallsOutsideTheRange()
    {
        // Range ends BEFORE August's own last Tuesday (25th) - August must not appear.
        var expiries = ExpiryCalendar.MonthlyExpiries(new DateOnly(2026, 8, 1), new DateOnly(2026, 8, 20));

        Assert.Empty(expiries);
    }

    [Fact]
    public void InvertedRange_ReturnsEmpty()
    {
        Assert.Empty(ExpiryCalendar.WeeklyExpiries(new DateOnly(2026, 8, 31), new DateOnly(2026, 8, 1)));
        Assert.Empty(ExpiryCalendar.MonthlyExpiries(new DateOnly(2026, 8, 31), new DateOnly(2026, 8, 1)));
    }
}

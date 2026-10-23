using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers OiReplayService.ResolvePreviousTradingDayAsync directly (internal +
/// InternalsVisibleTo, same reasoning as VolumeProfileTests' own doc comment) - the actual question
/// worth pinning down here, straight from a real "what about a market holiday/weekend" concern: does
/// it correctly skip weekends outright, does it correctly keep walking back one more day whenever a
/// candidate reports no data (a holiday) instead of giving up on the first miss, and does it
/// correctly stop trying (returning null, not loop forever) once its own attempt budget runs out.
/// hasDataAsync is faked per test with specific dates marked as "no data" - no real network/DB
/// involved, so a multi-day holiday stretch is exercised exactly the same way a single-day one is.</summary>
public sealed class PreviousTradingDayResolutionTests
{
    // 2026-09-28 is a Monday - 09-27 Sunday, 09-26 Saturday, 09-25 Friday, 09-24 Thursday, 09-23 Wednesday.
    private static readonly DateOnly Monday = new(2026, 9, 28);
    private static readonly DateOnly Friday = new(2026, 9, 25);
    private static readonly DateOnly Thursday = new(2026, 9, 24);
    private static readonly DateOnly Wednesday = new(2026, 9, 23);

    [Fact]
    public async Task ResolvePreviousTradingDayAsync_FromAMonday_SkipsTheWeekendAndResolvesToFriday()
    {
        var checkedDates = new List<DateOnly>();
        var result = await OiReplayService.ResolvePreviousTradingDayAsync(Monday, date =>
        {
            checkedDates.Add(date);
            return Task.FromResult(true); // every weekday candidate "has data"
        });

        Assert.Equal(Friday, result);
        // Never even asked about the weekend - Saturday/Sunday are skipped outright, not "checked and
        // found empty" the way a real holiday is.
        Assert.DoesNotContain(checkedDates, d => d.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday);
        Assert.Equal(new[] { Friday }, checkedDates);
    }

    [Fact]
    public async Task ResolvePreviousTradingDayAsync_HolidayOnTheNearestWeekday_KeepsWalkingBackToTheNextOne()
    {
        // Friday itself is a market holiday (no data) - the day BEFORE the weekend it's adjacent to,
        // exactly the "a holiday next to a weekend" shape a real NSE calendar produces.
        var noDataDates = new HashSet<DateOnly> { Friday };
        var checkedDates = new List<DateOnly>();

        var result = await OiReplayService.ResolvePreviousTradingDayAsync(Monday, date =>
        {
            checkedDates.Add(date);
            return Task.FromResult(!noDataDates.Contains(date));
        });

        Assert.Equal(Thursday, result);
        Assert.Equal(new[] { Friday, Thursday }, checkedDates);
    }

    [Fact]
    public async Task ResolvePreviousTradingDayAsync_TwoConsecutiveHolidays_StillResolvesToTheNextRealWeekday()
    {
        // A two-day holiday stretch (Thursday AND Friday both out) - still resolves correctly to
        // Wednesday, confirming this isn't limited to recovering from just a single miss.
        var noDataDates = new HashSet<DateOnly> { Friday, Thursday };

        var result = await OiReplayService.ResolvePreviousTradingDayAsync(Monday, date => Task.FromResult(!noDataDates.Contains(date)));

        Assert.Equal(Wednesday, result);
    }

    [Fact]
    public async Task ResolvePreviousTradingDayAsync_NothingFoundWithinTheAttemptBudget_ReturnsNullRatherThanLoopingForever()
    {
        var checkedDates = new List<DateOnly>();
        var result = await OiReplayService.ResolvePreviousTradingDayAsync(Monday, date =>
        {
            checkedDates.Add(date);
            return Task.FromResult(false); // every candidate this ever tries reports no data
        });

        Assert.Null(result);
        // A bounded number of REAL weekday attempts, not an unbounded/infinite walk backward.
        Assert.True(checkedDates.Count > 0);
        Assert.True(checkedDates.Count <= 7);
        Assert.DoesNotContain(checkedDates, d => d.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday);
    }

    [Fact]
    public async Task ResolvePreviousTradingDayAsync_AFailedCall_StopsTheWalkInsteadOfAskingDayAfterDay()
    {
        var checkedDates = new List<DateOnly>();
        var result = await OiReplayService.ResolvePreviousTradingDayAsync(Monday, date =>
        {
            checkedDates.Add(date);
            return Task.FromResult(false);
        }, () => true); // every call failed (a Dhan error, not an empty holiday)

        Assert.Null(result);
        Assert.Equal(new[] { Friday }, checkedDates);
    }
}

using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers OiReplayLiveFeedService.ResolveNearestExpiryCore - which real listed expiry date
/// the live tick feed (and its own REST-quote fallback) tracks for a WEEK/MONTH combo. A previous
/// version filtered WEEK to exclude whatever IsMonthly classified as "the month's own monthly",
/// which broke during the final week before that monthly expiry: NSE lists no separate, closer
/// weekly for that week at all, so the "nearest weekly" a WEEK combo should track IS the monthly
/// contract that week - the old code instead skipped straight past it to next month's first weekly,
/// a real, confirmed live bug (a strike's own tracked premium abruptly jumping mid-session to a
/// wildly different value once live ticks for the wrong, further-dated contract started arriving).</summary>
public sealed class OiReplayLiveFeedServiceTests
{
    [Fact]
    public void Week_FinalWeekBeforeMonthly_ResolvesToTheMonthlyDateItself_NotNextMonth()
    {
        // 29 Sep 2026 is genuinely September's own monthly expiry (confirmed in
        // ExpiryCalendarTests.MonthlyExpiries_ReturnsTheLastTuesdayOfEachMonth) - from 28 Sep 2026,
        // it is also the SINGLE NEAREST listed date, with no separate, closer weekly in between.
        var listed = new[] { new DateOnly(2026, 9, 29), new DateOnly(2026, 10, 6), new DateOnly(2026, 10, 13), new DateOnly(2026, 10, 27) };

        var resolved = OiReplayLiveFeedService.ResolveNearestExpiryCore(listed, "WEEK");

        Assert.Equal(new DateOnly(2026, 9, 29), resolved);
    }

    [Fact]
    public void Week_OrdinaryWeek_ResolvesToTheSingleNearestListedDate()
    {
        var listed = new[] { new DateOnly(2026, 10, 6), new DateOnly(2026, 10, 13), new DateOnly(2026, 10, 27) };

        var resolved = OiReplayLiveFeedService.ResolveNearestExpiryCore(listed, "WEEK");

        Assert.Equal(new DateOnly(2026, 10, 6), resolved);
    }

    [Fact]
    public void Month_ResolvesToTheNearestDateClassifiedAsItsOwnMonthsLast()
    {
        var listed = new[] { new DateOnly(2026, 9, 29), new DateOnly(2026, 10, 6), new DateOnly(2026, 10, 13), new DateOnly(2026, 10, 27) };

        var resolved = OiReplayLiveFeedService.ResolveNearestExpiryCore(listed, "MONTH");

        Assert.Equal(new DateOnly(2026, 9, 29), resolved);
    }

    [Fact]
    public void Month_SkipsPastAnAlreadyExpiredMonthlyToTheNextOne()
    {
        // No 29 Sep candidate at all here (already past) - October's own last listed date (27th) is
        // the nearest MONTH can resolve to.
        var listed = new[] { new DateOnly(2026, 10, 6), new DateOnly(2026, 10, 13), new DateOnly(2026, 10, 27) };

        var resolved = OiReplayLiveFeedService.ResolveNearestExpiryCore(listed, "MONTH");

        Assert.Equal(new DateOnly(2026, 10, 27), resolved);
    }

    [Fact]
    public void EmptyListed_ResolvesToNull()
    {
        Assert.Null(OiReplayLiveFeedService.ResolveNearestExpiryCore(Array.Empty<DateOnly>(), "WEEK"));
        Assert.Null(OiReplayLiveFeedService.ResolveNearestExpiryCore(Array.Empty<DateOnly>(), "MONTH"));
    }
}

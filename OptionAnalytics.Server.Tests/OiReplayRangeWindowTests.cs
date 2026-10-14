using OptionAnalytics.Server;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// Covers the date maths the OI range endpoint rests on (OiReplayRangeWindows) and the runtime
/// self-check it is trusted through (OiReplayDayComparer) - both pure, both reachable directly
/// (internal + InternalsVisibleTo, the same reasoning OiReplayService.ComputeVolumeProfile's own
/// tests already use), so the dangerous part (which contract a window can resolve to) is pinned down
/// without a single Dhan call.
///
/// September 2026 throughout: Tuesdays (the current NSE expiry weekday - see ExpiryCalendar) are the
/// 1st, 8th, 15th, 22nd and 29th, and the 29th is also that month's LAST Tuesday, i.e. its monthly
/// expiry. Fixed past dates, so these tests say the same thing whenever they are run.
/// </summary>
public sealed class OiReplayRangeWindowTests
{
    private static readonly DateOnly Today = new(2026, 10, 10);

    private static DateOnly D(int day) => new(2026, 9, day);

    [Fact]
    public void ARangeInsideOneWeeklyCycle_IsOneWindow_EndingBeforeItsExpiry()
    {
        // Wed 2 Sep .. Mon 7 Sep: all inside the cycle that expires Tue 8 Sep.
        var (windows, error) = OiReplayRangeWindows.Build("WEEK", D(2), D(7), Today);

        Assert.Null(error);
        var window = Assert.Single(windows);
        Assert.Equal(D(2), window.From);
        Assert.Equal(D(7), window.To);
        Assert.Equal(D(8), window.Expiry);
        // Always Dhan's "the 1st expiry from fromDate" - the one anchoring this app has confirmed
        // against real responses (see ExpiredOptionBacktestService.BuildFetchSegments).
        Assert.Equal(1, window.ExpiryCode);
    }

    [Fact]
    public void ARangeCrossingAWeeklyExpiry_IsOneWindowPerCycle_EachAnchoredInsideItsOwn()
    {
        // Wed 2 Sep .. Fri 11 Sep crosses Tue 8 Sep's expiry.
        var (windows, error) = OiReplayRangeWindows.Build("WEEK", D(2), D(11), Today);

        Assert.Null(error);
        Assert.Equal(2, windows.Count);

        Assert.Equal((D(2), D(7), D(8), 1), (windows[0].From, windows[0].To, windows[0].Expiry, windows[0].ExpiryCode));
        // The older cycle's expiry day (8 Sep) is in NO window, and the next window starts the day
        // after it - so one call's window can never hold two contracts' days.
        Assert.Equal((D(9), D(11), D(15), 1), (windows[1].From, windows[1].To, windows[1].Expiry, windows[1].ExpiryCode));
    }

    [Fact]
    public void NoWindowEverContainsAnExpiryOfItsOwnCadence()
    {
        // A three-week stretch, so every weekly expiry inside it has to be cut around.
        var (windows, error) = OiReplayRangeWindows.Build("WEEK", D(1), D(21), Today);

        Assert.Null(error);
        var expiries = ExpiryCalendar.WeeklyExpiries(D(1), D(21));
        Assert.NotEmpty(expiries);
        foreach (var window in windows)
            Assert.DoesNotContain(expiries, e => e >= window.From && e <= window.To);
    }

    [Fact]
    public void AMonthlyRangeInsideOneCycle_IsOneWindow_AnchoredToThatMonthsExpiry()
    {
        // BANKNIFTY's only cadence: Wed 2 Sep .. Fri 18 Sep all belong to the 29 Sep monthly contract.
        var (windows, error) = OiReplayRangeWindows.Build("MONTH", D(2), D(18), Today);

        Assert.Null(error);
        var window = Assert.Single(windows);
        Assert.Equal((D(2), D(18), D(29), 1), (window.From, window.To, window.Expiry, window.ExpiryCode));
    }

    [Fact]
    public void AMonthlyRangeCrossingTheMonthlyExpiry_IsSplitAtIt()
    {
        var (windows, error) = OiReplayRangeWindows.Build("MONTH", D(25), new DateOnly(2026, 10, 2), Today);

        Assert.Null(error);
        Assert.Equal(2, windows.Count);
        Assert.Equal((D(25), D(28), D(29), 1), (windows[0].From, windows[0].To, windows[0].Expiry, windows[0].ExpiryCode));
        // October's own monthly expiry is the last Tuesday, 27 Oct - the second window is anchored
        // the day after September's and ends at the caller's own `to`.
        Assert.Equal((new DateOnly(2026, 9, 30), new DateOnly(2026, 10, 2), new DateOnly(2026, 10, 27), 1),
            (windows[1].From, windows[1].To, windows[1].Expiry, windows[1].ExpiryCode));
    }

    [Fact]
    public void ARangeOfJustAnExpiryDay_HasNoWindowAtAll_AndIsNotAnError()
    {
        // 8 Sep is an expiry Tuesday: deliberately left to the per-day path (see
        // OiReplayRangeWindows' own doc comment on why the boundary day is never bulk-fetched).
        var (windows, error) = OiReplayRangeWindows.Build("WEEK", D(8), D(8), Today);

        Assert.Null(error);
        Assert.Empty(windows);
    }

    [Fact]
    public void ARangeWiderThanTheCap_IsRefusedWithAReason()
    {
        var (windows, error) = OiReplayRangeWindows.Build("WEEK", new DateOnly(2026, 8, 1), D(5), Today);

        Assert.Empty(windows);
        Assert.NotNull(error);
        Assert.Contains("36 days is too wide", error);
        Assert.Contains("31", error);
    }

    [Fact]
    public void ExactlyTheCap_IsAccepted()
    {
        var from = new DateOnly(2026, 9, 1);
        var to = from.AddDays(OiReplayRangeWindows.MaxRangeDays - 1);

        var (windows, error) = OiReplayRangeWindows.Build("WEEK", from, to, Today);

        Assert.Null(error);
        Assert.NotEmpty(windows);
    }

    [Fact]
    public void AnInvertedRange_IsRefused()
    {
        var (_, error) = OiReplayRangeWindows.Build("WEEK", D(10), D(2), Today);

        Assert.Equal("'to' date must not be before 'from' date.", error);
    }

    [Fact]
    public void ARangeStartingInTheFuture_IsRefused()
    {
        var (_, error) = OiReplayRangeWindows.Build("WEEK", Today.AddDays(1), Today.AddDays(3), Today);

        Assert.NotNull(error);
        Assert.Contains("in the future", error);
    }

    [Fact]
    public void AWindowIsNeverClampedPastToday()
    {
        // The current cycle: its expiry has not happened yet, so the window can only reach "now".
        var today = new DateOnly(2026, 9, 3);
        var (windows, error) = OiReplayRangeWindows.Build("WEEK", D(2), D(7), today);

        Assert.Null(error);
        var window = Assert.Single(windows);
        Assert.Equal(today, window.To);
    }

    [Fact]
    public void TradingDayCandidates_SkipWeekendsAndTheFuture()
    {
        // 4 Sep is a Friday, 5-6 Sep the weekend, 7 Sep a Monday.
        var days = OiReplayRangeWindows.TradingDayCandidates(D(3), D(9), D(8));

        Assert.Equal(new[] { D(3), D(4), D(7), D(8) }, days);
    }

    [Fact]
    public void ByDay_PutsEachItemOnItsOwnIstDay_AndKeepsAnEmptyDayPresent()
    {
        // 03:45 UTC is 09:15 IST the same day; 18:45 UTC is 00:15 IST the NEXT day - the boundary
        // that matters, since Dhan's timestamps are absolute instants, not IST dates.
        var items = new[]
        {
            new DateTimeOffset(2026, 9, 3, 3, 45, 0, TimeSpan.Zero),
            new DateTimeOffset(2026, 9, 3, 9, 59, 0, TimeSpan.Zero),
            new DateTimeOffset(2026, 9, 3, 18, 45, 0, TimeSpan.Zero),
        };

        var byDay = OiReplayRangeWindows.ByDay(items, t => t, new[] { D(3), D(4), D(7) });

        Assert.Equal(2, byDay[D(3)].Count);
        Assert.Single(byDay[D(4)]);
        // Present and empty, never missing - a caller walking the days cannot silently skip one.
        Assert.True(byDay.ContainsKey(D(7)));
        Assert.Empty(byDay[D(7)]);
    }

    [Fact]
    public void ByDay_DropsAnythingOutsideTheRequestedDays()
    {
        var items = new[] { new DateTimeOffset(2026, 9, 9, 3, 45, 0, TimeSpan.Zero) };

        var byDay = OiReplayRangeWindows.ByDay(items, t => t, new[] { D(3), D(4) });

        Assert.All(byDay.Values, Assert.Empty);
    }

    // ---- The runtime self-check (OiReplayDayComparer) -------------------------------------------

    private static readonly DateOnly CheckedDay = new(2026, 9, 3);

    private static OiReplayPoint Point(decimal strike, int minute, long oi, decimal price) =>
        new(IstClock.AtIstTime(CheckedDay, 9 * 60 + 15 + minute), strike, oi, 12m, price, price, price, price, 100);

    private static OiReplayResult Day(IEnumerable<OiReplayPoint> ce, IEnumerable<OiReplayPoint> pe) =>
        new(true, null, "NIFTY", CheckedDay, 1, 50, "WEEK", 1,
            Array.Empty<Candle>(), Array.Empty<Candle>(), ce.ToList(), pe.ToList(),
            Array.Empty<FuturesBar>(), null, false, null);

    [Fact]
    public void TwoIdenticalDays_Match()
    {
        var ce = new[] { Point(25000, 0, 1_000, 120m), Point(25050, 1, 2_000, 95m) };
        var pe = new[] { Point(25000, 0, 1_500, 110m) };

        var comparison = OiReplayDayComparer.Compare(CheckedDay, Day(ce, pe), Day(ce, pe));

        Assert.True(comparison.Match);
        Assert.Empty(comparison.Differences);
        Assert.Equal(2, comparison.RangeCePoints);
        Assert.Equal(2, comparison.PerDayCePoints);
    }

    [Fact]
    public void ADifferentOpenInterestValue_IsAReportedDifference()
    {
        var perDay = Day(new[] { Point(25000, 0, 1_000, 120m) }, Array.Empty<OiReplayPoint>());
        var range = Day(new[] { Point(25000, 0, 1_001, 120m) }, Array.Empty<OiReplayPoint>());

        var comparison = OiReplayDayComparer.Compare(CheckedDay, range, perDay);

        Assert.False(comparison.Match);
        Assert.Contains(comparison.Differences, d => d.Contains("open interest 1001") && d.Contains("1000") && d.Contains("25000"));
    }

    [Fact]
    public void ADifferentPremium_IsAReportedDifference()
    {
        var perDay = Day(new[] { Point(25000, 0, 1_000, 120m) }, Array.Empty<OiReplayPoint>());
        var range = Day(new[] { Point(25000, 0, 1_000, 120.05m) }, Array.Empty<OiReplayPoint>());

        var comparison = OiReplayDayComparer.Compare(CheckedDay, range, perDay);

        Assert.False(comparison.Match);
        Assert.Contains(comparison.Differences, d => d.Contains("premium"));
    }

    [Fact]
    public void AMinuteMissingFromTheRangeFetch_IsAReportedDifference()
    {
        var perDay = Day(new[] { Point(25000, 0, 1_000, 120m), Point(25000, 1, 1_010, 121m) }, Array.Empty<OiReplayPoint>());
        var range = Day(new[] { Point(25000, 0, 1_000, 120m) }, Array.Empty<OiReplayPoint>());

        var comparison = OiReplayDayComparer.Compare(CheckedDay, range, perDay);

        Assert.False(comparison.Match);
        Assert.Contains(comparison.Differences, d => d.Contains("missing from the range fetch"));
    }

    [Fact]
    public void AnExtraStrikeInTheRangeFetch_IsAReportedDifference()
    {
        var perDay = Day(new[] { Point(25000, 0, 1_000, 120m) }, Array.Empty<OiReplayPoint>());
        var range = Day(new[] { Point(25000, 0, 1_000, 120m), Point(25100, 0, 900, 70m) }, Array.Empty<OiReplayPoint>());

        var comparison = OiReplayDayComparer.Compare(CheckedDay, range, perDay);

        Assert.False(comparison.Match);
        Assert.Contains(comparison.Differences, d => d.Contains("not in the per-day fetch"));
    }

    [Fact]
    public void AnUnsuccessfulRangeDay_NeverMatches_EvenWithNothingToCompare()
    {
        var perDay = Day(Array.Empty<OiReplayPoint>(), Array.Empty<OiReplayPoint>());
        var failed = OiReplayResult.Failed("NIFTY", CheckedDay, 1, "Dhan is not authenticated");

        var comparison = OiReplayDayComparer.Compare(CheckedDay, failed, perDay);

        Assert.False(comparison.Match);
        Assert.Contains(comparison.Differences, d => d.Contains("range fetch did not succeed"));
    }

    [Fact]
    public void OneSideBeingIncomplete_IsAReportedDifference()
    {
        var ce = new[] { Point(25000, 0, 1_000, 120m) };
        var perDay = Day(ce, Array.Empty<OiReplayPoint>());
        var range = Day(ce, Array.Empty<OiReplayPoint>()) with { OptionErrors = new[] { "ATM+4 CALL: Too many requests" } };

        var comparison = OiReplayDayComparer.Compare(CheckedDay, range, perDay);

        Assert.False(comparison.Match);
        Assert.Contains(comparison.Differences, d => d.Contains("strike series failed"));
    }

    [Fact]
    public void AWholesaleMismatch_ReportsTheFirstFewAndSaysHowManyMore()
    {
        var perDay = Day(Enumerable.Range(0, 60).Select(i => Point(25000 + i * 50, i % 3, 1_000 + i, 100m + i)), Array.Empty<OiReplayPoint>());
        var range = Day(Array.Empty<OiReplayPoint>(), Array.Empty<OiReplayPoint>());

        var comparison = OiReplayDayComparer.Compare(CheckedDay, range, perDay);

        Assert.False(comparison.Match);
        Assert.Equal(OiReplayDayComparer.MaxDifferencesReported + 1, comparison.Differences.Count);
        Assert.Contains("more difference(s)", comparison.Differences[^1]);
    }
}

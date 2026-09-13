using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers ExpiredOptionBacktestService.MaxLookbackDays - the cap that keeps fromDay
/// anchored INSIDE the target contract's own life, which is what lets this app always send
/// expiryCode=1 ("the next expiry from fromDay") and have it resolve unambiguously to that one
/// contract - see that class's own top-of-file doc comment for the full reasoning, including why
/// Dhan's Annexure-documented near/next/far enum (and the confirmed rejection of 0) made an
/// arbitrary "how many cycles out" derivation the wrong model in the first place.</summary>
public sealed class ExpiredOptionBacktestServiceTests
{
    [Fact]
    public void MaxLookbackDays_IsTheSameGenerousSanityCapForBothCadences()
    {
        // Neither cadence uses this as a real safety boundary any more - BuildFetchSegments
        // computes its own directly from ExpiryCalendar's real expiry dates. This is just an
        // outer guard against a wildly large raw input, so it no longer differs by flag.
        Assert.Equal(ExpiredOptionBacktestService.MaxLookbackDays("WEEK"), ExpiredOptionBacktestService.MaxLookbackDays("MONTH"));
        Assert.Equal(ExpiredOptionBacktestService.MaxLookbackDays("WEEK"), ExpiredOptionBacktestService.MaxLookbackDays("nonsense"));
    }

    // 25 Aug 2026 - the same real monthly expiry ExpiryCalendarTests uses. Its own two preceding
    // real monthly expiries (also last-Tuesdays, hand-verified the same way): 28 Jul 2026 and
    // 30 Jun 2026.
    private static readonly DateOnly TargetExpiry = new(2026, 8, 25);
    private static readonly DateOnly PrevExpiry = new(2026, 7, 28);
    private static readonly DateOnly PrevPrevExpiry = new(2026, 6, 30);

    // Also 25 Aug 2026, but as a WEEKLY expiry this time (every Tuesday is one) - its own two
    // preceding real weekly expiries are simply the Tuesdays right before it: 18 Aug and 11 Aug.
    private static readonly DateOnly WeeklyTargetExpiry = new(2026, 8, 25);
    private static readonly DateOnly WeeklyPrevExpiry = new(2026, 8, 18);
    private static readonly DateOnly WeeklyPrevPrevExpiry = new(2026, 8, 11);

    [Fact]
    public void BuildFetchSegments_Monthly_ShortLookback_IsOneSegmentUnchangedFromBefore()
    {
        // Entirely within segment 1's own range (after PrevExpiry) - the original, single-segment
        // mechanism, untouched by the multi-segment extension.
        var segments = ExpiredOptionBacktestService.BuildFetchSegments("MONTH", TargetExpiry, new DateOnly(2026, 8, 10));

        var segment = Assert.Single(segments);
        Assert.Equal(new DateOnly(2026, 8, 10), segment.From);
        Assert.Equal(TargetExpiry, segment.To);
        Assert.Equal(1, segment.ExpiryCode);
    }

    [Fact]
    public void BuildFetchSegments_Monthly_ExactlyAtTheSegment1Boundary_IsStillOneSegment()
    {
        // requestedFromDay == PrevExpiry+1 exactly - the boundary case, must not spuriously add a
        // second, empty-ranged segment.
        var segments = ExpiredOptionBacktestService.BuildFetchSegments("MONTH", TargetExpiry, PrevExpiry.AddDays(1));

        var segment = Assert.Single(segments);
        Assert.Equal(PrevExpiry.AddDays(1), segment.From);
        Assert.Equal(1, segment.ExpiryCode);
    }

    [Fact]
    public void BuildFetchSegments_Monthly_ReachingPastPrevExpiry_AddsAnOlderSegment()
    {
        // 45 days back from 25 Aug reaches into July - the exact case ("Aug traded in July too")
        // this whole extension exists for. Two segments, oldest first: the older one covering
        // [requestedFromDay, PrevExpiry] at code 2, the original one covering
        // [PrevExpiry+1, TargetExpiry] at code 1 - no gap, no overlap between them.
        var requestedFromDay = TargetExpiry.AddDays(-45);
        var segments = ExpiredOptionBacktestService.BuildFetchSegments("MONTH", TargetExpiry, requestedFromDay);

        Assert.Equal(2, segments.Count);
        Assert.Equal(requestedFromDay, segments[0].From);
        Assert.Equal(PrevExpiry, segments[0].To);
        Assert.Equal(2, segments[0].ExpiryCode);
        Assert.Equal(PrevExpiry.AddDays(1), segments[1].From);
        Assert.Equal(TargetExpiry, segments[1].To);
        Assert.Equal(1, segments[1].ExpiryCode);
    }

    [Fact]
    public void BuildFetchSegments_Monthly_ReachingPastPrevPrevExpiryToo_ClampsToTheOlderSegmentsOwnStart()
    {
        // A lookback wide enough to want a THIRD real cycle back - clamped to what 2 segments can
        // reach (PrevPrevExpiry+1), the same "clamped, not rejected" behavior the rest of this
        // feature already uses for an over-long request, rather than adding a third segment this
        // app has no expiryCode value ready for.
        var segments = ExpiredOptionBacktestService.BuildFetchSegments("MONTH", TargetExpiry, TargetExpiry.AddDays(-90));

        Assert.Equal(2, segments.Count);
        Assert.Equal(PrevPrevExpiry.AddDays(1), segments[0].From);
        Assert.Equal(2, segments[0].ExpiryCode);
    }

    [Fact]
    public void BuildFetchSegments_Weekly_ShortLookback_IsOneSegment()
    {
        var segments = ExpiredOptionBacktestService.BuildFetchSegments("WEEK", WeeklyTargetExpiry, WeeklyTargetExpiry.AddDays(-3));

        var segment = Assert.Single(segments);
        Assert.Equal(WeeklyTargetExpiry.AddDays(-3), segment.From);
        Assert.Equal(WeeklyTargetExpiry, segment.To);
        Assert.Equal(1, segment.ExpiryCode);
    }

    [Fact]
    public void BuildFetchSegments_Weekly_ReachingPastPrevExpiry_AddsAnOlderSegment()
    {
        // 10 days back from 25 Aug reaches past 18 Aug's own expiry into the week before it - the
        // same "one cadence traded during the previous one's own cycle" shape the monthly case
        // was built for, just on a weekly cycle length instead.
        var requestedFromDay = WeeklyTargetExpiry.AddDays(-10);
        var segments = ExpiredOptionBacktestService.BuildFetchSegments("WEEK", WeeklyTargetExpiry, requestedFromDay);

        Assert.Equal(2, segments.Count);
        Assert.Equal(requestedFromDay, segments[0].From);
        Assert.Equal(WeeklyPrevExpiry, segments[0].To);
        Assert.Equal(2, segments[0].ExpiryCode);
        Assert.Equal(WeeklyPrevExpiry.AddDays(1), segments[1].From);
        Assert.Equal(WeeklyTargetExpiry, segments[1].To);
        Assert.Equal(1, segments[1].ExpiryCode);
    }

    [Fact]
    public void BuildFetchSegments_Weekly_ReachingPastPrevPrevExpiryToo_ClampsToTheOlderSegmentsOwnStart()
    {
        var segments = ExpiredOptionBacktestService.BuildFetchSegments("WEEK", WeeklyTargetExpiry, WeeklyTargetExpiry.AddDays(-30));

        Assert.Equal(2, segments.Count);
        Assert.Equal(WeeklyPrevPrevExpiry.AddDays(1), segments[0].From);
        Assert.Equal(2, segments[0].ExpiryCode);
    }

    [Fact]
    public void ClampSegmentsToToday_SegmentEntirelyInThePast_IsLeftUnchanged()
    {
        var segments = new[] { new ExpiredOptionBacktestService.FetchSegment(PrevExpiry.AddDays(1), TargetExpiry, 1) };
        var today = TargetExpiry.AddDays(30); // TargetExpiry itself is now well in the past

        var clamped = ExpiredOptionBacktestService.ClampSegmentsToToday(segments, today);

        var segment = Assert.Single(clamped);
        Assert.Equal(TargetExpiry, segment.To);
    }

    [Fact]
    public void ClampSegmentsToToday_SegmentReachingPastToday_IsShortenedToToday()
    {
        // TargetExpiry (25 Aug) is a not-yet-expired contract here - today sits partway through the
        // segment's own [PrevExpiry+1, TargetExpiry] range.
        var segments = new[] { new ExpiredOptionBacktestService.FetchSegment(PrevExpiry.AddDays(1), TargetExpiry, 1) };
        var today = TargetExpiry.AddDays(-10);

        var clamped = ExpiredOptionBacktestService.ClampSegmentsToToday(segments, today);

        var segment = Assert.Single(clamped);
        Assert.Equal(PrevExpiry.AddDays(1), segment.From);
        Assert.Equal(today, segment.To);
    }

    [Fact]
    public void ClampSegmentsToToday_SegmentEntirelyPastToday_IsDroppedOutright()
    {
        // The pathological two-segment case: the older segment still has real data up to today, but
        // the nearer one (anchored right after a PrevExpiry that is itself still in the future)
        // would otherwise come out inverted (From left past the newly-clamped To).
        var olderSegment = new ExpiredOptionBacktestService.FetchSegment(TargetExpiry.AddDays(-60), TargetExpiry.AddDays(-20), 2);
        var nearerSegment = new ExpiredOptionBacktestService.FetchSegment(TargetExpiry.AddDays(-19), TargetExpiry, 1);
        var today = TargetExpiry.AddDays(-20); // exactly the older segment's own end

        var clamped = ExpiredOptionBacktestService.ClampSegmentsToToday(new[] { olderSegment, nearerSegment }, today);

        var segment = Assert.Single(clamped);
        Assert.Equal(olderSegment.From, segment.From);
        Assert.Equal(today, segment.To);
    }

    private static CandleWithVolume Bar(DateTimeOffset time, decimal open, decimal close) =>
        new(time, open, Math.Max(open, close), Math.Min(open, close), close, 0);

    private static (CandleWithVolume Bar, decimal? Strike) RawBar(DateTimeOffset time, decimal open, decimal close) =>
        (Bar(time, open, close), null);

    [Fact]
    public void TrimToLargestSegment_NoSplices_ReturnsEverythingUnchanged()
    {
        var t0 = new DateTimeOffset(2024, 8, 1, 9, 15, 0, TimeSpan.FromHours(5.5));
        var raw = new List<(CandleWithVolume Bar, decimal? Strike)> { RawBar(t0, 10m, 10m), RawBar(t0.AddMinutes(1), 10m, 10m) };

        var trimmed = ExpiredOptionBacktestService.TrimToLargestSegment(raw, Array.Empty<PossibleSplice>());

        Assert.Same(raw, trimmed);
    }

    [Fact]
    public void TrimToLargestSegment_SpliceNearTheEnd_KeepsTheLargerHeadNotTheTinyTail()
    {
        // The real bug this exists to fix: a splice landing in the final few bars (Dhan's own
        // rolling resolution flipping to the next contract right before the target's own real
        // close) used to keep only that tiny tail and discard the entire correct head.
        var t0 = new DateTimeOffset(2024, 8, 1, 9, 15, 0, TimeSpan.FromHours(5.5));
        var raw = new List<(CandleWithVolume Bar, decimal? Strike)>();
        for (var i = 0; i < 100; i++) raw.Add(RawBar(t0.AddMinutes(i), 10m, 10m));
        var spliceTime = t0.AddMinutes(97); // 97 head bars, only 3 tail bars
        var splices = new List<PossibleSplice> { new(spliceTime, 10m, 50m) };

        var trimmed = ExpiredOptionBacktestService.TrimToLargestSegment(raw, splices);

        Assert.Equal(97, trimmed.Count);
        Assert.All(trimmed, b => Assert.True(b.Bar.Time < spliceTime));
    }

    [Fact]
    public void TrimToLargestSegment_SpliceNearTheStart_KeepsTheLargerTailNotTheTinyHead()
    {
        // The ORIGINAL motivating case: a too-wide lookback crossing into an older, different
        // contract near the head of the window - the correct, nearer-to-expiry data is the tail.
        var t0 = new DateTimeOffset(2024, 8, 1, 9, 15, 0, TimeSpan.FromHours(5.5));
        var raw = new List<(CandleWithVolume Bar, decimal? Strike)>();
        for (var i = 0; i < 100; i++) raw.Add(RawBar(t0.AddMinutes(i), 10m, 10m));
        var spliceTime = t0.AddMinutes(3); // 3 head bars, 97 tail bars
        var splices = new List<PossibleSplice> { new(spliceTime, 10m, 50m) };

        var trimmed = ExpiredOptionBacktestService.TrimToLargestSegment(raw, splices);

        Assert.Equal(97, trimmed.Count);
        Assert.All(trimmed, b => Assert.True(b.Bar.Time >= spliceTime));
    }

    [Fact]
    public void TrimToLargestSegment_TwoSplices_KeepsTheLargestOfAllThreeSegments()
    {
        var t0 = new DateTimeOffset(2024, 8, 1, 9, 15, 0, TimeSpan.FromHours(5.5));
        var raw = new List<(CandleWithVolume Bar, decimal? Strike)>();
        for (var i = 0; i < 100; i++) raw.Add(RawBar(t0.AddMinutes(i), 10m, 10m));
        // Three segments: [0,10) = 10 bars, [10,20) = 10 bars, [20,100) = 80 bars - the tail wins.
        var splices = new List<PossibleSplice> { new(t0.AddMinutes(10), 10m, 50m), new(t0.AddMinutes(20), 10m, 50m) };

        var trimmed = ExpiredOptionBacktestService.TrimToLargestSegment(raw, splices);

        Assert.Equal(80, trimmed.Count);
        Assert.All(trimmed, b => Assert.True(b.Bar.Time >= t0.AddMinutes(20)));
    }

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

        var splice = Assert.Single(splices);
        Assert.Equal(t1, splice.Time);
        Assert.Equal(2m, splice.PreviousClose);
        Assert.Equal(40m, splice.ThisOpen);
    }

    [Fact]
    public void DetectPossibleSplices_IgnoresAnOvernightGapEvenIfLarge()
    {
        // The most damaging bug this class had: a real option premium can genuinely move several-
        // fold overnight (theta decay through the non-trading gap, or the underlying itself
        // gapping) - normal, not a splice. Comparing this day's last bar to the NEXT day's first
        // bar used to flag ordinary overnight gaps like this one on every single trading day in a
        // multi-day window, and TrimToLargestSegment could then only ever keep ONE of those days.
        var day1Close = new DateTimeOffset(2024, 8, 1, 15, 29, 0, TimeSpan.FromHours(5.5));
        var day2Open = new DateTimeOffset(2024, 8, 2, 9, 15, 0, TimeSpan.FromHours(5.5));
        var bars = new List<CandleWithVolume> { Bar(day1Close, 3m, 2m), Bar(day2Open, 40m, 38m) };

        var splices = ExpiredOptionBacktestService.DetectPossibleSplices(bars);

        Assert.Empty(splices);
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
    public void DetectPossibleSplices_IgnoresARatioJumpTooSmallInAbsoluteTerms()
    {
        // A real bug from a real run: a deep-OTM strike's own premium genuinely swinging several-
        // fold in its final hour before expiry (0.50 -> 2.50 here, a 5x ratio) on an almost-zero
        // base - not a splice, just what a near-worthless option's own last-hour gamma looks like.
        // The ratio alone used to trim the ENTIRE rest of the series away on jumps like this.
        var t0 = new DateTimeOffset(2024, 8, 1, 15, 10, 0, TimeSpan.FromHours(5.5));
        var bars = new List<CandleWithVolume> { Bar(t0, 0.5m, 0.5m), Bar(t0.AddMinutes(1), 2.5m, 2.5m) };

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

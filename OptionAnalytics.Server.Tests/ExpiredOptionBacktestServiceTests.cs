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
    public void Weekly_CapsWellUnderTheRealSevenDayCycle()
    {
        // Comfortably under 7 so a holiday-shifted expiry (a day or two either way) still cannot
        // put fromDay before the PREVIOUS week's own expiry.
        var days = ExpiredOptionBacktestService.MaxLookbackDays("WEEK");

        Assert.InRange(days, 1, 6);
    }

    [Fact]
    public void UnrecognizedFlag_FallsBackToTheWeeklyCap()
    {
        // Never the wider MONTH-sized cap for anything that isn't recognizably "MONTH" - the
        // smaller, safer cap is the correct default when in doubt.
        var days = ExpiredOptionBacktestService.MaxLookbackDays("WEEK");
        var fallback = ExpiredOptionBacktestService.MaxLookbackDays("nonsense");

        Assert.Equal(days, fallback);
    }

    // 25 Aug 2026 - the same real monthly expiry ExpiryCalendarTests uses. Its own two preceding
    // real monthly expiries (also last-Tuesdays, hand-verified the same way): 28 Jul 2026 and
    // 30 Jun 2026.
    private static readonly DateOnly TargetExpiry = new(2026, 8, 25);
    private static readonly DateOnly PrevExpiry = new(2026, 7, 28);
    private static readonly DateOnly PrevPrevExpiry = new(2026, 6, 30);

    [Fact]
    public void BuildMonthlyFetchSegments_ShortLookback_IsOneSegmentUnchangedFromBefore()
    {
        // Entirely within segment 1's own range (after PrevExpiry) - the original, single-segment
        // mechanism, untouched by the multi-segment extension.
        var segments = ExpiredOptionBacktestService.BuildMonthlyFetchSegments(TargetExpiry, new DateOnly(2026, 8, 10));

        var segment = Assert.Single(segments);
        Assert.Equal(new DateOnly(2026, 8, 10), segment.From);
        Assert.Equal(TargetExpiry, segment.To);
        Assert.Equal(1, segment.ExpiryCode);
    }

    [Fact]
    public void BuildMonthlyFetchSegments_ExactlyAtTheSegment1Boundary_IsStillOneSegment()
    {
        // requestedFromDay == PrevExpiry+1 exactly - the boundary case, must not spuriously add a
        // second, empty-ranged segment.
        var segments = ExpiredOptionBacktestService.BuildMonthlyFetchSegments(TargetExpiry, PrevExpiry.AddDays(1));

        var segment = Assert.Single(segments);
        Assert.Equal(PrevExpiry.AddDays(1), segment.From);
        Assert.Equal(1, segment.ExpiryCode);
    }

    [Fact]
    public void BuildMonthlyFetchSegments_ReachingPastPrevExpiry_AddsAnOlderSegment()
    {
        // 45 days back from 25 Aug reaches into July - the exact case ("Aug traded in July too")
        // this whole extension exists for. Two segments, oldest first: the older one covering
        // [requestedFromDay, PrevExpiry] at code 2, the original one covering
        // [PrevExpiry+1, TargetExpiry] at code 1 - no gap, no overlap between them.
        var requestedFromDay = TargetExpiry.AddDays(-45);
        var segments = ExpiredOptionBacktestService.BuildMonthlyFetchSegments(TargetExpiry, requestedFromDay);

        Assert.Equal(2, segments.Count);
        Assert.Equal(requestedFromDay, segments[0].From);
        Assert.Equal(PrevExpiry, segments[0].To);
        Assert.Equal(2, segments[0].ExpiryCode);
        Assert.Equal(PrevExpiry.AddDays(1), segments[1].From);
        Assert.Equal(TargetExpiry, segments[1].To);
        Assert.Equal(1, segments[1].ExpiryCode);
    }

    [Fact]
    public void BuildMonthlyFetchSegments_ReachingPastPrevPrevExpiryToo_ClampsToTheOlderSegmentsOwnStart()
    {
        // A lookback wide enough to want a THIRD real cycle back - clamped to what 2 segments can
        // reach (PrevPrevExpiry+1), the same "clamped, not rejected" behavior the rest of this
        // feature already uses for an over-long request, rather than adding a third segment this
        // app has no expiryCode value ready for.
        var segments = ExpiredOptionBacktestService.BuildMonthlyFetchSegments(TargetExpiry, TargetExpiry.AddDays(-90));

        Assert.Equal(2, segments.Count);
        Assert.Equal(PrevPrevExpiry.AddDays(1), segments[0].From);
        Assert.Equal(2, segments[0].ExpiryCode);
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

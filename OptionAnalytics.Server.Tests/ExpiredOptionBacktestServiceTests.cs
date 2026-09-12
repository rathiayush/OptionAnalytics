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
    public void Monthly_CapsAtOrUnderTheRealCalendarMonth()
    {
        // Raised to 28 (from a previously more conservative 25) at the user's explicit request -
        // 28 days is the SHORTEST gap two consecutive real last-Tuesday-of-month expiries can ever
        // be apart (always a multiple of 7, 28-35 days), so this is now flush against the worst
        // case rather than comfortably under it: a holiday-shifted previous expiry in exactly a
        // 28-day cycle has zero margin left. Must never exceed 28 - that would let fromDay reach
        // AT OR PAST a real previous expiry even with no holiday shift at all.
        var days = ExpiredOptionBacktestService.MaxLookbackDays("MONTH");

        Assert.InRange(days, 1, 28);
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

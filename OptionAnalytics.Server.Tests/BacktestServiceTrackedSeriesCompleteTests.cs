using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers BacktestService.IsTrackedSeriesComplete - the fix for a real production "No
/// Data" pattern: a strike that fell OUT of the live ATM+-16 window (spot trended far enough away)
/// stops receiving ticks forever and is never re-backfilled, so its own tracked candle series
/// freezes at whatever day it dropped out on. Before this check existed, GetOptionBars trusted ANY
/// non-empty tracked series outright, so a signal after the drop-out point found nothing at its own
/// timestamp and read as permanent "No Data" - even with the on-demand fetch loop (PR #60) raising
/// the retry budget/duration, because a miss was never even recorded for a strike that "already had
/// candles". This check exists to catch exactly that: a tracked series only counts as complete when
/// it reaches as far as the rest of this backtest's data does.</summary>
public sealed class BacktestServiceTrackedSeriesCompleteTests
{
    private static readonly DateTimeOffset Day1 = new(2026, 8, 12, 4, 0, 0, TimeSpan.Zero); // 09:30 IST
    private static readonly DateTimeOffset Day2 = new(2026, 8, 13, 4, 0, 0, TimeSpan.Zero); // next trading day, 09:30 IST

    private static Candle Bar(DateTimeOffset time) => new(time, 100, 100, 100, 100);

    [Fact]
    public void TrackedReachesTheSameDayAsTheLatestHeldBars_IsComplete()
    {
        var tracked = new[] { Bar(Day2) };
        var latestHeldBars = new[] { Bar(Day1), Bar(Day2) };

        Assert.True(BacktestService.IsTrackedSeriesComplete(tracked, latestHeldBars));
    }

    [Fact]
    public void TrackedStopsOnAnEarlierDayThanTheLatestHeldBars_IsIncomplete()
    {
        // The exact shape of the bug: this strike fell out of the ATM window on Day1 and never
        // came back, while the rest of the backtest's data (spot) continues through Day2.
        var tracked = new[] { Bar(Day1) };
        var latestHeldBars = new[] { Bar(Day1), Bar(Day2) };

        Assert.False(BacktestService.IsTrackedSeriesComplete(tracked, latestHeldBars));
    }

    [Fact]
    public void TrackedReachesLaterThanTheLatestHeldBars_IsComplete()
    {
        // Same day is the common case, but "later" must not be flagged incomplete either - only
        // "earlier" is the drop-out signature.
        var tracked = new[] { Bar(Day1), Bar(Day2) };
        var latestHeldBars = new[] { Bar(Day1) };

        Assert.True(BacktestService.IsTrackedSeriesComplete(tracked, latestHeldBars));
    }

    [Fact]
    public void TrackedIsEmpty_IsIncomplete()
    {
        Assert.False(BacktestService.IsTrackedSeriesComplete(Array.Empty<Candle>(), new[] { Bar(Day1) }));
    }

    [Fact]
    public void LatestHeldBarsIsEmpty_IsIncomplete()
    {
        // No reference point to compare against - can't call this strike's series complete off
        // nothing, so it falls through to an on-demand fetch just like the empty-tracked case.
        Assert.False(BacktestService.IsTrackedSeriesComplete(new[] { Bar(Day1) }, Array.Empty<Candle>()));
    }
}

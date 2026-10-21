using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Today's CDV after a restart: the day's first backfill fetches its strikes one by one for minutes while their
/// live ticks already arrive (the feed is shared - OI Replay subscribes the same contracts). Drawing the total then made it
/// jump up and down as each strike's history landed, and the rebuilt morning was put in front of those live minutes -
/// repeated and out-of-order bars (the OI Replay CDV chart's zig-zag, and its "Value is null" crash).</summary>
public sealed class CdvBackfillRaceTests
{
    // 11:40 IST: the server restarted, the rebuild begins.
    private static readonly DateTimeOffset Restart = new(2026, 10, 21, 11, 40, 20, IstClock.Offset);
    private static readonly DateTimeOffset Open = new(2026, 10, 21, 9, 15, 0, IstClock.Offset);
    private const decimal Spot = 25_600;

    private static SpotTick Tick(uint id, decimal price, long dayVolume, DateTimeOffset at) => new(id, price, price, price, price, price, dayVolume, 0, 0, 0, at);

    // A strike's morning: every minute from 09:15 up to (not including) `until`, closing at its high (all buying).
    private static List<CandleWithVolume> Morning(DateTimeOffset until) =>
        Enumerable.Range(0, (int)(until - Open).TotalMinutes).Select(i => new CandleWithVolume(Open.AddMinutes(i), 100, 101, 99, 101, 1_000)).ToList();

    private static void AssertOnePerMinuteInOrder(IReadOnlyList<CdvBarPoint> series)
    {
        var times = series.Select(p => p.Time).ToList();
        Assert.Equal(times.OrderBy(t => t).ToList(), times);
        Assert.Equal(times.Distinct().Count(), times.Count);
    }

    [Fact]
    public void While_the_rebuild_runs_no_total_is_drawn_and_after_it_one_bar_per_minute_in_order()
    {
        var state = new CdvUnderlyingState("NIFTY");
        state.EnsureTracked(1, 25_600, isCall: true);
        state.EnsureTracked(2, 25_600, isCall: false);
        state.BeginCdvBackfill(Restart);

        // Live ticks for both strikes before either is seeded: no aggregate bar, no running total.
        state.ApplyTick(Tick(1, 100, 50_000, Restart.AddSeconds(10)), Spot);
        state.ApplyTick(Tick(1, 102, 51_000, Restart.AddSeconds(70)), Spot);
        state.ApplyTick(Tick(2, 90, 40_000, Restart.AddSeconds(75)), Spot);
        Assert.Empty(state.GetSeries());

        // Strike 1's history lands (fetched 11:41:30); its live ticks count from then on - still nothing drawn.
        state.SeedStrikeHistory(1, Morning(Restart.AddMinutes(2)), Morning(Restart.AddMinutes(2)), Spot, includeInCdvHistory: true);
        state.ApplyTick(Tick(1, 103, 52_000, Restart.AddSeconds(150)), Spot);
        state.ApplyTick(Tick(2, 89, 41_000, Restart.AddSeconds(160)), Spot);
        Assert.Empty(state.GetSeries());

        state.SeedStrikeHistory(2, Morning(Restart.AddMinutes(3)), Morning(Restart.AddMinutes(3)), Spot, includeInCdvHistory: true);
        state.FinalizeCdvBackfill();

        // The rebuilt morning stops before the minute the rebuild began (every strike fetched after it holds it in full).
        var series = state.GetSeries();
        AssertOnePerMinuteInOrder(series);
        Assert.Equal(Open, series[0].Time);
        Assert.True(series[^1].Time < new DateTimeOffset(2026, 10, 21, 11, 40, 0, IstClock.Offset));

        // Live again: the next ticks draw the current minute after it, from the totals (history + live since the seed).
        state.ApplyTick(Tick(1, 104, 53_000, Restart.AddMinutes(4)), Spot);
        state.ApplyTick(Tick(2, 88, 42_000, Restart.AddMinutes(5)), Spot);
        series = state.GetSeries();
        AssertOnePerMinuteInOrder(series);
        Assert.Equal(new DateTimeOffset(2026, 10, 21, 11, 45, 0, IstClock.Offset), series[^1].Time);
    }

    [Fact]
    public void A_retried_rebuild_replaces_the_bars_drawn_before_it()
    {
        var state = new CdvUnderlyingState("NIFTY");
        state.EnsureTracked(1, 25_600, isCall: true);
        // The first rebuild found nothing (Dhan not ready): live bars are drawn from 11:40.
        state.BeginCdvBackfill(Restart);
        state.AbandonCdvBackfill();
        for (var m = 0; m < 5; m++) state.ApplyTick(Tick(1, 100 + m, 50_000 + m * 100, Restart.AddMinutes(m)), Spot);
        Assert.NotEmpty(state.GetSeries());

        // The retry at 11:46 rebuilds the day up to 11:45 - those live bars (without the morning) are replaced.
        var retry = Restart.AddMinutes(6);
        state.BeginCdvBackfill(retry);
        state.SeedStrikeHistory(1, Morning(retry.AddMinutes(1)), Morning(retry.AddMinutes(1)), Spot, includeInCdvHistory: true);
        state.FinalizeCdvBackfill();

        var series = state.GetSeries();
        AssertOnePerMinuteInOrder(series);
        Assert.Equal(Open, series[0].Time);
        Assert.True(series[^1].Time < new DateTimeOffset(2026, 10, 21, 11, 46, 0, IstClock.Offset));
        // Every bar is the rebuilt one: the running total of an all-buying morning only rises.
        Assert.True(series.Zip(series.Skip(1)).All(p => p.Second.CeCdv >= p.First.CeCdv));
    }

    [Fact]
    public void A_rebuild_with_no_bars_today_lets_the_live_ticks_draw_again()
    {
        var state = new CdvUnderlyingState("NIFTY");
        state.EnsureTracked(1, 25_600, isCall: true);
        state.BeginCdvBackfill(Open.AddMinutes(-30));
        state.SeedStrikeHistory(1, Morning(Open), Array.Empty<CandleWithVolume>(), Spot, includeInCdvHistory: true); // before the open: no bars today
        state.FinalizeCdvBackfill();

        state.ApplyTick(Tick(1, 100, 1_000, Open.AddSeconds(5)), Spot);
        state.ApplyTick(Tick(1, 101, 2_000, Open.AddSeconds(65)), Spot);

        Assert.Single(state.GetSeries().Where(p => p.Time == Open));
    }

    [Fact]
    public void Each_rebuilt_minute_is_weighted_by_that_minutes_spot()
    {
        // A 25,600 call, the same buying bar at 09:15 (spot 25,600 - at the money) and 09:16 (spot 25,300 - 300 out).
        var bars = new List<CandleWithVolume> { new(Open, 100, 101, 99, 101, 1_000), new(Open.AddMinutes(1), 100, 101, 99, 101, 1_000) };
        var spotByTime = new Dictionary<DateTimeOffset, decimal> { [Open] = 25_600, [Open.AddMinutes(1)] = 25_300 };
        var state = new CdvUnderlyingState("NIFTY");
        state.EnsureTracked(1, 25_600, isCall: true);
        state.BeginCdvBackfill(Open.AddMinutes(5));
        state.SeedStrikeHistory(1, bars, bars, currentSpot: 25_900, includeInCdvHistory: true, spotByTime);
        state.FinalizeCdvBackfill();

        var series = state.GetSeries();
        Assert.Equal(1_000m * CdvUnderlyingState.ComputeDeltaWeight(25_600, 25_600, true), series[0].CeCdv, 6);
        Assert.Equal(1_000m * CdvUnderlyingState.ComputeDeltaWeight(25_600, 25_300, true), series[1].CeCdv - series[0].CeCdv, 6);
    }
}

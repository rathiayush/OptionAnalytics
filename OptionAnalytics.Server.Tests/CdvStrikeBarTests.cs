using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Each tracked strike's own 1-minute bars (OBV's inputs, the ATM premium chart). A tick is stamped with the
/// contract's LAST trade time, so an OI / depth update or a re-subscribe's snapshot carries a minute - or a day - old
/// time; such a tick opened a bar back at that minute: bars out of order, a minute twice, a point before the open (the
/// OBV chart starting at "5 am").</summary>
public sealed class CdvStrikeBarTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 21, 13, 5, 10, IstClock.Offset);
    private const decimal Spot = 25_600;

    private static SpotTick Tick(decimal price, long dayVolume, DateTimeOffset lastTrade) => new(1, price, price, price, price, price, dayVolume, 0, 0, 0, lastTrade);

    private static CdvUnderlyingState Seeded(DateTimeOffset lastSeeded, out List<CandleWithVolume> history)
    {
        var state = new CdvUnderlyingState("NIFTY");
        state.EnsureTracked(1, 25_600, isCall: true);
        var open = new DateTimeOffset(2026, 10, 21, 9, 15, 0, IstClock.Offset);
        history = Enumerable.Range(0, (int)(lastSeeded - open).TotalMinutes + 1)
            .Select(i => new CandleWithVolume(open.AddMinutes(i), 100, 102, 99, 101, 500)).ToList();
        state.SeedStrikeHistory(1, history, history, Spot, includeInCdvHistory: false);
        return state;
    }

    private static void AssertOnePerMinuteInOrder(IEnumerable<DateTimeOffset> times)
    {
        var list = times.ToList();
        Assert.Equal(list.OrderBy(t => t).ToList(), list);
        Assert.Equal(list.Distinct().Count(), list.Count);
    }

    [Fact]
    public void A_tick_with_an_old_trade_time_and_no_new_volume_opens_no_bar()
    {
        var state = Seeded(Now.AddMinutes(-6), out _);
        state.ApplyTick(Tick(101, 10_000, Now.AddSeconds(-5)), Spot);                 // baseline
        state.ApplyTick(Tick(102, 10_200, Now), Spot);                                // a trade: 13:05
        state.ApplyTick(Tick(102, 10_200, Now.AddMinutes(-20)), Spot);                // snapshot replay, last trade 12:45
        state.ApplyTick(Tick(102, 10_200, new DateTimeOffset(2026, 10, 21, 5, 2, 0, IstClock.Offset)), Spot); // a stray pre-open time
        state.ApplyTick(Tick(103, 10_500, Now.AddMinutes(1)), Spot);                  // a trade: 13:06

        var candles = state.GetStrikeCandles(25_600, isCall: true)!;
        AssertOnePerMinuteInOrder(candles.Select(c => c.Time));
        Assert.DoesNotContain(candles, c => c.Time.ToOffset(IstClock.Offset).Hour < 9);
        Assert.Equal(new DateTimeOffset(2026, 10, 21, 13, 6, 0, IstClock.Offset), candles[^1].Time);

        var obv = state.GetObvSeries(isCall: true);
        AssertOnePerMinuteInOrder(obv.Select(p => p.Time));
        Assert.DoesNotContain(obv, p => p.Time.ToOffset(IstClock.Offset) is { Hour: < 9 } t && t.Date == Now.Date);
    }

    [Fact]
    public void A_trade_in_the_backfills_last_minute_carries_that_bar_on()
    {
        var state = Seeded(Now.AddSeconds(-10), out var history);                     // fetched during 13:05
        state.ApplyTick(Tick(101, 10_000, Now.AddSeconds(-2)), Spot);                 // baseline
        state.ApplyTick(Tick(104, 10_300, Now), Spot);                                // 300 more traded in 13:05

        var bar = state.GetStrikeCandles(25_600, isCall: true)![^1];
        Assert.Equal(new DateTimeOffset(2026, 10, 21, 13, 5, 0, IstClock.Offset), bar.Time);
        Assert.Equal((100m, 104m, 99m, 104m), (bar.Open, bar.High, bar.Low, bar.Close));
        AssertOnePerMinuteInOrder(state.GetStrikeCandles(25_600, isCall: true)!.Select(c => c.Time));
        Assert.Equal(history.Count, state.GetStrikeCandles(25_600, isCall: true)!.Count);
    }

    [Fact]
    public void The_cdv_total_after_a_rebuild_never_goes_back_before_its_last_minute()
    {
        var state = new CdvUnderlyingState("NIFTY");
        state.EnsureTracked(1, 25_600, isCall: true);
        var begun = Now.AddMinutes(-3);
        state.BeginCdvBackfill(begun);
        var open = new DateTimeOffset(2026, 10, 21, 9, 15, 0, IstClock.Offset);
        var history = Enumerable.Range(0, 228).Select(i => new CandleWithVolume(open.AddMinutes(i), 100, 101, 99, 101, 500)).ToList();
        state.SeedStrikeHistory(1, history, history, Spot, includeInCdvHistory: true);
        state.FinalizeCdvBackfill();

        state.ApplyTick(Tick(101, 10_000, Now), Spot);                                 // baseline
        state.ApplyTick(Tick(102, 10_100, Now.AddHours(-3)), Spot);                     // a trade stamped long ago
        state.ApplyTick(Tick(103, 10_200, Now.AddMinutes(1)), Spot);

        AssertOnePerMinuteInOrder(state.GetSeries().Select(p => p.Time));
    }
}

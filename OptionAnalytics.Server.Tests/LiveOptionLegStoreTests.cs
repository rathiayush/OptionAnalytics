using OptionAnalytics.Server;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;
using Xunit;

namespace OptionAnalytics.Server.Tests;

/// <summary>The live feed's newest reading per option leg (LiveOptionLegStore) - what GET live-legs serves.</summary>
public class LiveOptionLegStoreTests
{
    private static LiveOptionTick Tick(string u, string flag, decimal strike, string side, decimal price, DateTimeOffset at) =>
        new(u, flag, strike, side, price, price, price, price, 1000, at);

    [Fact]
    public void Keeps_the_newest_reading_per_leg_of_one_chain_and_day()
    {
        var store = new LiveOptionLegStore();
        var now = DateTimeOffset.UtcNow.ToOffset(IstClock.Offset);
        var today = DateOnly.FromDateTime(now.DateTime);
        store.Record(Tick("NIFTY", "N1", 23100, "CE", 57.55m, now.AddSeconds(-5)));
        store.Record(Tick("NIFTY", "N1", 23100, "CE", 61.2m, now));
        store.Record(Tick("NIFTY", "N1", 23100, "PE", 40m, now));
        store.Record(Tick("NIFTY", "N2", 23100, "CE", 99m, now));
        store.Record(Tick("SENSEX", "N1", 74500, "CE", 489.85m, now));
        store.Record(Tick("NIFTY", "N1", 23200, "CE", 30m, now.AddDays(-1)));

        var legs = store.Latest("nifty", "n1", today);
        Assert.Equal(2, legs.Count);
        Assert.Equal((23100m, "CE", 61.2m), (legs[0].Strike, legs[0].Side, legs[0].Price));
        Assert.Equal("PE", legs[1].Side);
        Assert.Single(store.Latest("NIFTY", "N2", today));
        Assert.Empty(store.Latest("BANKNIFTY", "N1", today));
    }

    [Fact]
    public void A_new_day_lets_go_of_the_earlier_days_readings()
    {
        var store = new LiveOptionLegStore();
        var monday = new DateTimeOffset(2026, 10, 19, 15, 29, 0, IstClock.Offset);
        // Monday's legs, some of them strikes the index will have moved away from by Tuesday.
        for (var strike = 23000m; strike <= 23500m; strike += 50)
            store.Record(Tick("NIFTY", "WEEK", strike, "CE", 50m, monday));
        Assert.Equal(11, store.LatestCount);

        var tuesday = monday.AddDays(1).AddHours(-6);
        store.Record(Tick("NIFTY", "WEEK", 23600m, "CE", 40m, tuesday));

        Assert.Equal(1, store.LatestCount);
        Assert.Single(store.Latest("NIFTY", "WEEK", DateOnly.FromDateTime(tuesday.DateTime)));
    }
}

/// <summary>Today's minute bars the live feed keeps for every index (LiveOptionLegStore) and how today's run joins
/// them to its one backfill (OiReplayService.MergeTodayLive) - switching index on the live page asks Dhan nothing.</summary>
public class TodayLiveBarsTests
{
    private static readonly DateTimeOffset Open = new(2026, 10, 19, 9, 15, 0, IstClock.Offset);
    private static LiveOptionTick Tick(decimal strike, string side, decimal price, long oi, DateTimeOffset at) =>
        new("NIFTY", "WEEK", strike, side, price, price, price, price, oi, at);

    [Fact]
    public void Each_leg_gets_minute_bars_with_its_oi_and_traded_volume()
    {
        var store = new LiveOptionLegStore();
        store.Record(Tick(23100, "CE", 50, 1000, Open.AddSeconds(5)), dayVolume: 100, keepBars: true);
        store.Record(Tick(23100, "CE", 55, 1200, Open.AddSeconds(40)), dayVolume: 160, keepBars: true);
        store.Record(Tick(23100, "CE", 48, 1300, Open.AddSeconds(55)), dayVolume: 175, keepBars: true);
        store.Record(Tick(23100, "CE", 52, 1350, Open.AddMinutes(1).AddSeconds(3)), dayVolume: 200, keepBars: true);
        store.Record(Tick(23100, "PE", 70, 900, Open.AddSeconds(10)), dayVolume: 10, keepBars: true);
        store.Record(Tick(23200, "CE", 30, 500, Open.AddSeconds(10)), dayVolume: 5, keepBars: false); // an N-expiry: newest only

        var ce = store.OptionPointsFrom("NIFTY", "WEEK", "CE", Open);
        Assert.Equal(2, ce.Count);
        var first = ce[0];
        Assert.Equal((Open, 23100m, 50m, 55m, 48m, 48m, 1300L, 75L), (first.Time, first.Strike, first.Open!.Value, first.High!.Value, first.Low!.Value, first.Price, first.OpenInterest!.Value, first.Volume));
        Assert.Equal((52m, 25L), (ce[1].Price, ce[1].Volume));
        Assert.Single(store.OptionPointsFrom("NIFTY", "WEEK", "PE", Open));
        Assert.Single(store.OptionPointsFrom("NIFTY", "WEEK", "CE", Open.AddMinutes(1)));
        Assert.Empty(store.OptionPointsFrom("NIFTY", "MONTH", "CE", Open));
        // A new day starts empty.
        store.Record(Tick(23100, "CE", 40, 10, Open.AddDays(1)), dayVolume: 1, keepBars: true);
        Assert.Empty(store.OptionPointsFrom("NIFTY", "WEEK", "CE", Open));
    }

    [Fact]
    public void Futures_get_minute_bars_too()
    {
        var store = new LiveOptionLegStore();
        store.RecordFutures("NIFTY", 23150, 9_000_000, 1_000, Open.AddSeconds(2));
        store.RecordFutures("NIFTY", 23160, 9_000_500, 1_400, Open.AddSeconds(30));
        store.RecordFutures("NIFTY", 23140, 9_001_000, 1_500, Open.AddMinutes(1));
        var bars = store.FuturesBarsFrom("NIFTY", Open);
        Assert.Equal(2, bars.Count);
        Assert.Equal((23150m, 23160m, 23160m, 400L, 9_000_500L), (bars[0].Open, bars[0].High, bars[0].Close, bars[0].Volume, bars[0].OpenInterest!.Value));
        Assert.Empty(store.FuturesBarsFrom("SENSEX", Open));
    }

    [Fact]
    public void Todays_run_is_the_backfill_up_to_when_it_was_taken_then_the_live_bars()
    {
        static OiReplayPoint P(DateTimeOffset t, decimal price) => new(t, 23100, 1000, null, price);
        var backfill = new[] { P(Open, 50), P(Open.AddMinutes(1), 51), P(Open.AddMinutes(2), 52) }; // taken during 09:17
        var live = new[] { P(Open.AddMinutes(2), 52.5m), P(Open.AddMinutes(3), 53) };
        var merged = OiReplayService.MergeTodayLive(backfill, live, Open.AddMinutes(2).AddSeconds(20));
        Assert.Equal(new[] { 50m, 51m, 52.5m, 53m }, merged.Select(p => p.Price));
        // Nothing live yet: the backfill as it is.
        Assert.Equal(3, OiReplayService.MergeTodayLive(backfill, Array.Empty<OiReplayPoint>(), Open.AddMinutes(2)).Count);
    }
}

public class OptionChainPollTests
{
    private static DateTimeOffset Ist(int day, int hour, int minute) => new(2026, 10, day, hour, minute, 0, IstClock.Offset);

    [Fact]
    public void The_chain_is_asked_only_for_a_watched_combo_in_market_hours()
    {
        Assert.True(OiReplayLiveFeedService.ShouldPollChain(Ist(19, 10, 0), watched: true));
        // Nobody watching: no call.
        Assert.False(OiReplayLiveFeedService.ShouldPollChain(Ist(19, 10, 0), watched: false));
        // Before the open, after the close, at night and at the weekend: no call.
        Assert.False(OiReplayLiveFeedService.ShouldPollChain(Ist(19, 9, 0), watched: true));
        Assert.False(OiReplayLiveFeedService.ShouldPollChain(Ist(19, 15, 45), watched: true));
        Assert.False(OiReplayLiveFeedService.ShouldPollChain(Ist(19, 22, 0), watched: true));
        Assert.False(OiReplayLiveFeedService.ShouldPollChain(Ist(18, 11, 0), watched: true)); // Sunday
    }
}

/// <summary>Today's spot for OI Replay from the spot feed's memory (OiReplayService.TodaySpotBars): the whole day so far
/// needs no Dhan call; when Dhan refuses the day, whatever the feed holds is shown instead of failing the page.</summary>
public class TodaySpotFromFeedTests
{
    private static readonly DateOnly Day = new(2026, 10, 23);
    private static DateTimeOffset Ist(int h, int m) => new(2026, 10, 23, h, m, 0, IstClock.Offset);
    private static List<CandleWithVolume> Bars(DateTimeOffset from, DateTimeOffset to)
    {
        var bars = new List<CandleWithVolume>();
        for (var t = from; t <= to; t = t.AddMinutes(1)) bars.Add(new CandleWithVolume(t, 100, 101, 99, 100, 0));
        return bars;
    }

    [Fact]
    public void The_whole_day_so_far_is_used_without_asking_Dhan()
    {
        var now = Ist(11, 3);
        var yesterday = Bars(Ist(9, 15).AddDays(-1), Ist(15, 29).AddDays(-1));
        var bars = OiReplayService.TodaySpotBars(yesterday.Concat(Bars(Ist(9, 15), Ist(11, 2))).ToList(), Day, now, wholeDay: true);
        Assert.NotNull(bars);
        Assert.Equal(Ist(9, 15), bars![0].Time); // only today's
    }

    [Fact]
    public void A_server_restarted_part_way_is_not_the_whole_day_but_is_shown_when_Dhan_refuses()
    {
        var now = Ist(11, 3);
        var sinceRestart = Bars(Ist(10, 40), Ist(11, 2));
        Assert.Null(OiReplayService.TodaySpotBars(sinceRestart, Day, now, wholeDay: true));
        var shown = OiReplayService.TodaySpotBars(sinceRestart, Day, now, wholeDay: false);
        Assert.Equal(23, shown!.Count);
        Assert.Equal(Ist(10, 40), shown[0].Time);
    }

    [Fact]
    public void A_stalled_feed_is_not_the_whole_day_and_nothing_of_today_is_null()
    {
        Assert.Null(OiReplayService.TodaySpotBars(Bars(Ist(9, 15), Ist(10, 30)), Day, Ist(11, 3), wholeDay: true));
        Assert.Null(OiReplayService.TodaySpotBars(Bars(Ist(9, 15).AddDays(-1), Ist(15, 29).AddDays(-1)), Day, Ist(11, 3), wholeDay: false));
    }
}

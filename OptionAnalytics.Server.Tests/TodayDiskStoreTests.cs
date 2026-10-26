using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;
using Xunit;

namespace OptionAnalytics.Server.Tests;

/// <summary>Today's OI Replay data on disk (TodayDiskStore - CSV files under {DhanCachePath}/today/{day}/): each backfill
/// from Dhan and the live feed's minute bars, read back after a restart or a deploy so the day is not asked of Dhan again
/// (LiveOptionLegStore.Restore / CarriesOnFrom, TodayDataPersistenceService, OiReplayService.SavedTodayUsable).</summary>
public sealed class TodayDiskStoreTests : IDisposable
{
    private static readonly DateOnly Day = new(2026, 10, 26);
    private static readonly DateTimeOffset Open = new(2026, 10, 26, 9, 15, 0, IstClock.Offset);
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "today-disk-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    private TodayDiskStore Disk() => new(_dir, NullLogger<TodayDiskStore>.Instance);

    private static LiveOptionTick Tick(decimal strike, string side, decimal price, long oi, DateTimeOffset at) =>
        new("NIFTY", "WEEK", strike, side, price, price, price, price, oi, at);

    // ---- The files ----

    [Fact]
    public void File_names_keep_every_series_apart_and_readable()
    {
        Assert.Equal("NIFTY_opt_WEEK_ATMp3_CALL", TodayDiskStore.SafeName("NIFTY|opt|WEEK|ATM+3|CALL"));
        Assert.Equal("NIFTY_opt_WEEK_ATMm3_CALL", TodayDiskStore.SafeName("NIFTY|opt|WEEK|ATM-3|CALL"));
        Assert.Equal("BANKNIFTY_fut", TodayDiskStore.SafeName("BANKNIFTY|fut"));
    }

    [Fact]
    public void An_option_series_backfill_is_kept_as_csv_with_when_it_was_fetched()
    {
        var disk = Disk();
        var fetched = Open.AddMinutes(5).AddSeconds(12);
        var bars = new List<(CandleWithVolume Bar, decimal? Strike, decimal? Spot, long? OpenInterest, decimal? ImpliedVolatility)>
        {
            (new CandleWithVolume(Open, 101.5m, 104m, 100.25m, 103m, 1500), 22500m, 22512.3m, 4_000_000, 14.2m),
            (new CandleWithVolume(Open.AddMinutes(1), 103m, 103m, 99m, 99.5m, 750), 22500m, null, null, null),
        };
        disk.SaveOptionSeries(Day, "NIFTY|opt|WEEK|ATM|CALL", fetched, bars);

        var path = Path.Combine(_dir, "2026-10-26", "series", "NIFTY_opt_WEEK_ATM_CALL.csv");
        Assert.True(File.Exists(path));
        var lines = File.ReadAllLines(path);
        Assert.StartsWith("# fetched_utc=2026-10-26T03:50:12.000Z", lines[0]);
        Assert.Equal(TodayDiskStore.OptionSeriesHeader, lines[1]);
        Assert.Equal("2026-10-26T03:45:00.000Z,101.5,104,100.25,103,1500,22500,22512.3,4000000,14.2", lines[2]);

        var read = disk.ReadOptionSeries(Day, "NIFTY|opt|WEEK|ATM|CALL")!;
        Assert.Equal(fetched, read.FetchedAt);
        Assert.Equal(bars, read.Bars);
        Assert.Equal(IstClock.Offset, read.Bars[0].Bar.Time.Offset);
        Assert.Null(disk.ReadOptionSeries(Day, "NIFTY|opt|WEEK|ATM+1|CALL"));
    }

    [Fact]
    public void The_futures_backfill_round_trips_with_its_contract_and_oi_flag()
    {
        var disk = Disk();
        var bars = new List<FuturesBar> { new(Open, 22600m, 22610m, 22590m, 22605m, 12000, 13_500_000), new(Open.AddMinutes(1), 22605m, 22606m, 22600m, 22601m, 9000, null) };
        disk.SaveFutures(Day, "NIFTY|fut", Open.AddMinutes(2), bars, new DateOnly(2026, 10, 28), oiAvailable: true);
        var read = disk.ReadFutures(Day, "NIFTY|fut")!;
        Assert.Equal((Open.AddMinutes(2), new DateOnly(2026, 10, 28), true), (read.FetchedAt, read.Expiry, read.OiAvailable));
        Assert.Equal(bars, read.Bars);
    }

    [Fact]
    public void Clear_cache_drops_only_that_index_and_older_days_go()
    {
        var disk = Disk();
        var one = new List<FuturesBar> { new(Open, 1, 1, 1, 1, 1, 1) };
        disk.SaveFutures(Day, "NIFTY|fut", Open, one, null, false);
        disk.SaveFutures(Day, "BANKNIFTY|fut", Open, one, null, false);
        disk.SaveFutures(Day.AddDays(-1), "NIFTY|fut", Open.AddDays(-1), one, null, false);

        disk.DeleteSeries(Day, "NIFTY|");
        Assert.Null(disk.ReadFutures(Day, "NIFTY|fut"));
        Assert.NotNull(disk.ReadFutures(Day, "BANKNIFTY|fut"));

        disk.RemoveOlderDays(Day);
        Assert.False(Directory.Exists(disk.DayDir(Day.AddDays(-1))));
        Assert.True(Directory.Exists(disk.DayDir(Day)));
    }

    [Fact]
    public void A_disk_problem_never_throws()
    {
        var file = Path.Combine(Path.GetTempPath(), "not-a-dir-" + Guid.NewGuid().ToString("N"));
        File.WriteAllText(file, "x");
        try
        {
            var disk = new TodayDiskStore(file, NullLogger<TodayDiskStore>.Instance);
            disk.SaveFutures(Day, "NIFTY|fut", Open, new List<FuturesBar> { new(Open, 1, 1, 1, 1, 1, 1) }, null, false);
            disk.AppendLiveBars(Day, new[] { new TodayDiskStore.LiveBarRow("fut", "NIFTY", "", "", 0, Open, 1, 1, 1, 1, 1, 1) });
            Assert.Null(disk.ReadFutures(Day, "NIFTY|fut"));
            Assert.Empty(disk.ReadLiveBars(Day));
        }
        finally { File.Delete(file); }
    }

    // ---- A restart: the live minutes saved, read back, and the backfill reused ----

    private sealed class Clock { public DateTimeOffset Now; }

    private (LiveOptionLegStore Store, TodayDataPersistenceService Saver, Clock Clock) Server(DateTimeOffset now)
    {
        var store = new LiveOptionLegStore();
        var clock = new Clock { Now = now };
        var saver = new TodayDataPersistenceService(store, Disk(), NullLogger<TodayDataPersistenceService>.Instance, () => clock.Now);
        saver.RestoreToday();
        return (store, saver, clock);
    }

    /// <summary>The first server: live ticks from 09:15 to `until` (one a minute per leg, OI rising), saved as it goes.</summary>
    private void RunUntil(DateTimeOffset until)
    {
        var (store, saver, clock) = Server(Open);
        for (var t = Open; t < until; t = t.AddMinutes(1))
        {
            store.Record(Tick(22500, "CE", 100, 4_000_000 + (long)(t - Open).TotalMinutes * 1000, t.AddSeconds(20)), -1, keepBars: true);
            store.Record(Tick(22500, "PE", 90, 3_000_000, t.AddSeconds(20)), -1, keepBars: true);
            store.RecordFutures("NIFTY", 22600, 13_000_000, -1, t.AddSeconds(30));
            clock.Now = t.AddMinutes(1).AddSeconds(10);
            saver.FlushOnce();
        }
    }

    [Fact]
    public void The_live_minutes_are_written_once_each_after_the_minute_settles()
    {
        var (store, saver, clock) = Server(Open);
        store.Record(Tick(22500, "CE", 100, 4_000_000, Open.AddSeconds(20)), -1, keepBars: true);
        clock.Now = Open.AddMinutes(1).AddSeconds(3); // 09:16:03 - the 09:15 minute has not settled yet
        Assert.Equal(0, saver.FlushOnce());
        clock.Now = Open.AddMinutes(1).AddSeconds(6);
        Assert.Equal(1, saver.FlushOnce());
        Assert.Equal(0, saver.FlushOnce());

        var lines = File.ReadAllLines(Path.Combine(_dir, "2026-10-26", TodayDiskStore.LiveBarsFile));
        Assert.Equal(new[] { TodayDiskStore.LiveBarsHeader, "opt,NIFTY,WEEK,CE,22500,2026-10-26T03:45:00.000Z,100,100,100,100,4000000,0" }, lines);
    }

    [Fact]
    public void After_a_restart_the_day_is_read_back_and_a_backfill_saved_before_it_is_used_again()
    {
        RunUntil(Open.AddMinutes(45)); // 09:15 - 09:59 saved; the server stops at 10:00
        var backfillAt = Open.AddMinutes(5);

        // The deploy: a new server at 10:03, the live feed back from 10:03.
        var (store, _, clock) = Server(Open.AddMinutes(48));
        var ce = store.OptionPointsFrom("NIFTY", "WEEK", "CE", backfillAt);
        Assert.Equal(40, ce.Count); // 09:20 - 09:59 from disk
        Assert.Equal(4_000_000 + 44 * 1000, ce[^1].OpenInterest);
        Assert.Equal(40, store.FuturesBarsFrom("NIFTY", backfillAt).Count);
        Assert.True(OiReplayService.SavedTodayUsable(Day, Day, false, store, backfillAt, clock.Now), "a 4-minute hole - the saved backfill stands");

        store.Record(Tick(22500, "CE", 100, 4_100_000, Open.AddMinutes(48).AddSeconds(5)), -1, keepBars: true);
        Assert.True(OiReplayService.SavedTodayUsable(Day, Day, false, store, backfillAt, Open.AddMinutes(60)));
        Assert.Equal(41, store.OptionPointsFrom("NIFTY", "WEEK", "CE", backfillAt).Count);

        Assert.False(OiReplayService.SavedTodayUsable(Day, Day, forceFetch: true, store, backfillAt, clock.Now), "force fetch asks Dhan");
        Assert.False(OiReplayService.SavedTodayUsable(Day.AddDays(-1), Day, false, store, backfillAt, clock.Now), "only today's");
    }

    [Fact]
    public void A_long_hole_asks_Dhan_again()
    {
        RunUntil(Open.AddMinutes(45));
        // Down from 10:00 to 10:30: half an hour the saved minutes do not hold.
        var (store, _, clock) = Server(Open.AddMinutes(75));
        Assert.False(OiReplayService.SavedTodayUsable(Day, Day, false, store, Open.AddMinutes(5), clock.Now));
    }

    [Fact]
    public void After_the_close_the_saved_day_stands_however_late_the_deploy()
    {
        RunUntil(new DateTimeOffset(2026, 10, 26, 15, 30, 0, IstClock.Offset)); // to 15:29
        var (store, _, clock) = Server(new DateTimeOffset(2026, 10, 26, 18, 0, 0, IstClock.Offset));
        Assert.True(OiReplayService.SavedTodayUsable(Day, Day, false, store, Open.AddMinutes(5), clock.Now));
    }

    [Fact]
    public void Nothing_saved_or_a_backfill_older_than_the_saved_minutes_asks_Dhan()
    {
        var (fresh, _, clock) = Server(Open.AddMinutes(48));
        Assert.False(OiReplayService.SavedTodayUsable(Day, Day, false, fresh, Open.AddMinutes(5), clock.Now), "no saved minutes");

        // Saved minutes only from 09:40 (the feed started late): a 09:20 backfill is not carried on by them.
        var (store, saver, c) = Server(Open.AddMinutes(25));
        for (var t = Open.AddMinutes(25); t < Open.AddMinutes(45); t = t.AddMinutes(1))
        {
            store.Record(Tick(22500, "CE", 100, 4_000_000, t.AddSeconds(20)), -1, keepBars: true);
            c.Now = t.AddMinutes(1).AddSeconds(10);
            saver.FlushOnce();
        }
        var (after, _, c2) = Server(Open.AddMinutes(47));
        Assert.False(OiReplayService.SavedTodayUsable(Day, Day, false, after, Open.AddMinutes(5), c2.Now));
        Assert.True(OiReplayService.SavedTodayUsable(Day, Day, false, after, Open.AddMinutes(26), c2.Now));
    }

    [Fact]
    public void A_minute_the_new_server_recorded_itself_is_not_overwritten_by_the_saved_one()
    {
        var store = new LiveOptionLegStore();
        store.Record(Tick(22500, "CE", 120, 5_000_000, Open.AddSeconds(30)), -1, keepBars: true);
        store.Restore(Day, new[] { new TodayDiskStore.LiveBarRow("opt", "NIFTY", "WEEK", "CE", 22500, Open, 1, 1, 1, 1, 1, 1),
            new TodayDiskStore.LiveBarRow("opt", "NIFTY", "WEEK", "CE", 22500, Open.AddDays(-1), 1, 1, 1, 1, 1, 1) });
        var points = store.OptionPointsFrom("NIFTY", "WEEK", "CE", Open);
        Assert.Equal((120m, 5_000_000L), (Assert.Single(points).Price, points[0].OpenInterest));
    }

    // ---- Is the cache folder kept across a deploy ----

    private const string Overlay = "1061 1004 0:51 / / rw,relatime master:540 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/ABC\n" +
                                   "1062 1061 0:54 / /proc rw,nosuid - proc proc rw\n";
    private const string Volume = "1080 1061 8:1 /var/lib/docker/volumes/optionanalytics_optionanalytics-data/_data /app/data rw,relatime - ext4 /dev/sda1 rw\n";

    [Fact]
    public void The_cache_folder_is_kept_only_on_a_mounted_volume()
    {
        Assert.False(StorageVolume.IsPersistent("/app/dhan-cache", Overlay), "the container's own file system - gone at a deploy");
        Assert.True(StorageVolume.IsPersistent("/app/data/dhan-cache", Overlay + Volume), "docker-compose's volume");
        Assert.False(StorageVolume.IsPersistent("/app/database/dhan-cache", Overlay + Volume), "next to the volume, not on it");
        Assert.False(StorageVolume.IsPersistent("/app/data/x", Overlay + Volume + "1090 1080 0:60 / /app/data/x rw - tmpfs tmpfs rw\n"), "memory");
        Assert.True(StorageVolume.IsPersistent("/srv/my data/cache", "1 0 8:1 / / rw - overlay o rw\n2 1 8:2 / /srv/my\\040data rw - xfs /dev/sdb rw\n"));
        Assert.Null(StorageVolume.IsPersistent("/app/data", ""));
    }
}

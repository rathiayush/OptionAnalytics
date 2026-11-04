using System.IO.Compression;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services;
using OptionAnalytics.Server.Services.OrderFlow;

namespace OptionAnalytics.Server.Tests;

/// <summary>The order flow days the server recorded live, kept on DISK (Storage:OrderFlowPath): a past day replays exactly -
/// footprint, imbalances, tape, book - after a restart / deploy (it used to come back as the candle estimate, with no
/// imbalances at all), the oldest dates go past OrderFlow:DaysOnDisk, and a new engine carries today on from its checkpoint.</summary>
public sealed class OrderFlowDayStoreTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "of-days-" + Guid.NewGuid().ToString("N"));
    private static readonly DateTimeOffset T0 = new(2026, 10, 5, 4, 0, 0, TimeSpan.Zero); // 09:30 IST

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch { /* temp */ }
    }

    private OrderFlowDayStore Store(int daysOnDisk = 30) => new(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
    {
        ["Storage:OrderFlowPath"] = _root, ["OrderFlow:DaysOnDisk"] = daysOnDisk.ToString(),
    }).Build(), NullLogger<OrderFlowDayStore>.Instance, startWriter: false);

    private static SpotTick Tick(decimal price, long volume, decimal bid, decimal ask) =>
        new(35001, price, 0, 0, 0, 0, volume, bid, ask, 0, T0)
        {
            Bids = new[] { new DepthLevel(bid, 750, 5), new DepthLevel(bid - 0.05m, 1500, 9) },
            Asks = new[] { new DepthLevel(ask, 750, 5), new DepthLevel(ask + 0.05m, 1500, 9) },
        };

    // A recorded morning: buys and sells over a few minutes, the book sampled for the heatmap.
    private static OrderFlowEngine RecordedDay(DateTimeOffset start)
    {
        var engine = new OrderFlowEngine("NIFTY", 35001, "NIFTY-Oct2026-FUT", "NSE_FNO", 0.05m, 75, new DateOnly(2026, 10, 27));
        long volume = 10_000;
        engine.OnTick(Tick(100m, volume, 99.95m, 100m), start);
        for (var i = 1; i <= 240; i++)
        {
            volume += 75 * (1 + i % 3);
            var price = 100m + (i % 9) * 0.05m;
            engine.OnTick(i % 2 == 0 ? Tick(price, volume, price - 0.05m, price) : Tick(price, volume, price, price + 0.05m), start.AddSeconds(i * 3));
        }
        return engine;
    }

    private static object Picture(OrderFlowSnapshot s) => new
    {
        Bars = s.Bars.Select(b => (b.Time, b.Open, b.High, b.Low, b.Close, b.Buy, b.Sell, string.Join(";", b.Levels.Select(l => $"{l.Price}:{l.Buy}:{l.Sell}")))).ToList(),
        Trades = s.Trades.Select(t => (t.Seq, t.Time, t.Price, t.Quantity, t.Buy)).ToList(),
        Heat = s.Heatmap.Select(c => (c.Time, string.Join(";", c.Bids.Select(r => $"{r[0]}:{r[1]}")), string.Join(";", c.Asks.Select(r => $"{r[0]}:{r[1]}")))).ToList(),
    };

    [Fact]
    public void The_delta_rule_comparison_survives_the_disk_and_a_day_saved_before_it_still_loads()
    {
        var recorded = RecordedDay(T0);
        var day = recorded.ExportDay()!;
        using (var store = Store()) store.SaveNow(day);
        using (var store = Store())
            Assert.Equal(recorded.DeltaRules(3), OrderFlowEngine.FromDay(store.LoadSaved("NIFTY", 35001, day.Day)!).DeltaRules(3));

        // The same file as this morning's build wrote it: no Rules on any bar.
        var path = Directory.GetFiles(_root, "*.json.gz", SearchOption.AllDirectories).Single();
        string json;
        using (var read = new StreamReader(new GZipStream(File.OpenRead(path), CompressionMode.Decompress))) json = read.ReadToEnd();
        var old = Regex.Replace(json, @",""Rules"":\[[^\]]*\]", "");
        Assert.DoesNotContain("Rules", old);
        using (var write = new StreamWriter(new GZipStream(File.Create(path), CompressionLevel.Fastest))) write.Write(old);

        using (var store = Store())
        {
            var rows = OrderFlowEngine.FromDay(store.LoadSaved("NIFTY", 35001, day.Day)!).DeltaRules(3);
            Assert.Equal(recorded.DeltaRules(3).Select(r => (r.Time, r.Volume, r.Delta)), rows.Select(r => (r.Time, r.Volume, r.Delta)));
            Assert.All(rows, r => Assert.Null(r.TickRule));
        }
    }

    [Fact]
    public void A_recorded_day_kept_on_disk_replays_exactly_after_a_restart()
    {
        var recorded = RecordedDay(T0);
        var day = recorded.ExportDay()!;
        var store = Store();
        store.Add(day);
        store.FlushForTests();

        // A restart: a new store, nothing in memory.
        var restarted = Store();
        var engine = restarted.EngineFor("NIFTY", 35001, day.Day);
        Assert.NotNull(engine);
        Assert.Equal(System.Text.Json.JsonSerializer.Serialize(Picture(recorded.Snapshot(1, 1, 500))), System.Text.Json.JsonSerializer.Serialize(Picture(engine!.Snapshot(1, 1, 500))));
        Assert.Same(engine, restarted.EngineFor("NIFTY", 35001, day.Day));           // read once, kept for the next asks
        var listed = Assert.Single(restarted.Days("NIFTY"));
        Assert.Equal((day.Day, "NIFTY-Oct2026-FUT", (DateOnly?)new DateOnly(2026, 10, 27)), listed);
        Assert.Null(restarted.EngineFor("NIFTY", 35001, day.Day.AddDays(1)));
        Assert.Empty(restarted.Days("BANKNIFTY"));
    }

    [Fact]
    public void The_newest_DaysOnDisk_dates_stay_older_ones_go()
    {
        var store = Store(daysOnDisk: 2);
        foreach (var offset in new[] { 0, 1, 2 }) store.Add(RecordedDay(T0.AddDays(offset)).ExportDay()!);
        store.FlushForTests();
        Assert.Equal(new[] { new DateOnly(2026, 10, 7), new DateOnly(2026, 10, 6) }, Store().Days("NIFTY").Select(d => d.Date));
    }

    [Fact]
    public void Without_a_folder_days_are_kept_in_memory_only_as_before()
    {
        var store = new OrderFlowDayStore();
        Assert.False(store.OnDisk);
        var day = RecordedDay(T0).ExportDay()!;
        store.Add(day);
        Assert.NotNull(store.EngineFor("NIFTY", 35001, day.Day));
        Assert.Null(store.LoadSaved("NIFTY", 35001, day.Day));
    }

    [Fact]
    public void A_new_engine_carries_today_on_from_its_checkpoint_without_a_giant_print()
    {
        var store = Store();
        var today = IstClock.Today();
        var open = new DateTimeOffset(today.ToDateTime(new TimeOnly(9, 30)), IstClock.Offset);
        var morning = RecordedDay(open);
        store.SaveNow(morning.ExportDay()!);

        var service = CreateService(store);
        var contract = new DhanFuturesInstrument(35001, "NIFTY-Oct2026-FUT", "NIFTY", new DateOnly(2026, 10, 27), "NSE_FNO", 75, 0.05m);
        var engine = service.NewEngine("NIFTY", contract);
        var restored = engine.Snapshot(1, 1, 100);
        Assert.Equal(morning.Snapshot(1, 1, 100).Bars.Sum(b => b.Buy + b.Sell), restored.Bars.Sum(b => b.Buy + b.Sell));

        // The first tick after the restart sets a new baseline: what traded while the server was down is not one print.
        var after = open.AddMinutes(30);
        engine.OnTick(Tick(100.2m, 900_000, 100.15m, 100.2m), after);
        engine.OnTick(Tick(100.2m, 900_075, 100.15m, 100.2m), after.AddSeconds(1));
        var now = engine.Snapshot(1, 1, 100);
        Assert.Equal(restored.Bars.Sum(b => b.Buy + b.Sell) + 75, now.Bars.Sum(b => b.Buy + b.Sell));
        Assert.True(now.Trades.Max(t => t.Seq) > restored.Trades.Max(t => t.Seq));   // prints carry on numbering after the saved ones

        // The checkpoint writes today again on the store's writer.
        service.TrackForTests(engine);
        service.Checkpoint(now: true);
        Assert.NotNull(store.LoadSaved("NIFTY", 35001, today));
    }

    private static OrderFlowService CreateService(OrderFlowDayStore store)
    {
        var options = Options.Create(new DhanOptions { RestBaseUrl = "https://dhan.test", ClientId = "c" });
        var session = new DhanSession(options);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["OrderFlow:DepthMode"] = "20" }).Build();
        return new OrderFlowService(
            new DhanFuturesInstrumentMaster(new HttpClient(), options, NullLogger<DhanFuturesInstrumentMaster>.Instance),
            new DhanMarketFeedClient(options, session, NullLogger<DhanMarketFeedClient>.Instance),
            new DhanDepthFeedClient(options, session, NullLogger<DhanDepthFeedClient>.Instance, config),
            new DhanTwoHundredDepthClient(options, session, NullLogger<DhanTwoHundredDepthClient>.Instance, config),
            new LiveBroadcastBatcher(null, NullLogger<LiveBroadcastBatcher>.Instance),
            store, NullLogger<OrderFlowService>.Instance, config);
    }
}

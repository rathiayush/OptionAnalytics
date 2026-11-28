using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.TrueData;
using Xunit;
using Xunit.Abstractions;

namespace OptionAnalytics.Server.Tests;

/// <summary>TrueData's raw ticks on disk (TrueDataTickStore): every live futures / option tick recorded compressed as it comes, read back as
/// TrueData's own tick CSV; the tick history of past days kept and served from disk; a day TrueData no longer keeps replayed from the recording.</summary>
public sealed class TrueDataTickStoreTests : IDisposable
{
    private static readonly TimeSpan Ist = TimeSpan.FromMinutes(330);
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "td-ticks-" + Guid.NewGuid().ToString("N"));
    private readonly ITestOutputHelper _out;
    public TrueDataTickStoreTests(ITestOutputHelper output) => _out = output;
    public void Dispose() { try { Directory.Delete(_dir, true); } catch { } }

    private static readonly DateOnly Past = IstClock.Today().AddDays(-3);
    private static DateTimeOffset At(int h, int m, int s = 0, int ms = 0) => new(Past.Year, Past.Month, Past.Day, h, m, s, ms, Ist);

    [Fact]
    public async Task Live_ticks_are_recorded_compressed_per_contract_and_read_back_as_TrueData_tick_csv()
    {
        await using var store = new TrueDataTickStore(_dir, NullLogger.Instance);
        store.RecordTrade("NIFTY-I", At(9, 15, 1), 24500.5m, 650, 1_000_000, 24500m, 75, 24501m, 150);
        store.RecordQuote("NIFTY-I", At(9, 15, 1, 400), 24500.5m, 300, 24501.5m, 75);
        store.RecordTrade("NIFTY-I", At(9, 15, 2), 24501.5m, 845, 1_000_075, 24501m, 75, 24501.5m, 75);
        store.RecordTrade("NIFTY26120124500CE", At(9, 15, 3), 120.25m, 1300, 50_000, 120m, 650, 120.5m, 325);
        await store.DrainAsync();

        var file = store.LiveFile("NIFTY-I", Past);
        Assert.True(File.Exists(file));
        Assert.EndsWith(".csv.gz", file);
        Assert.Contains(Path.Combine("live", Past.ToString("yyyy-MM-dd")), file);
        var fut = TrueDataTickCsv.Parse(store.ReadLive("NIFTY-I", Past));
        Assert.Null(fut.Error);
        Assert.Equal(3, fut.Ticks.Count);
        Assert.Equal(new[] { 650L, 650, 845 }, fut.Ticks.Select(t => t.Volume));      // the quote carries the last trade's volume on - no rise, so it reads as a quote
        Assert.Equal(24501.5m, fut.Ticks[1].Ask);
        Assert.Equal(At(9, 15, 1, 400), fut.Ticks[1].Time);
        var opt = TrueDataTickCsv.Parse(store.ReadLive("NIFTY26120124500CE", Past));
        Assert.Equal(120.25m, Assert.Single(opt.Ticks).Ltp);
        Assert.Equal(50_000, opt.Ticks[0].OpenInterest);
        Assert.True(store.Days().Single().LiveFiles == 2);
    }

    [Fact]
    public async Task Several_flushes_are_several_gzip_members_of_one_file_and_read_as_one_day()
    {
        await using (var first = new TrueDataTickStore(_dir, NullLogger.Instance))
        {
            first.RecordTrade("BANKNIFTY-I", At(10, 0), 52000m, 30, 1, 51999.8m, 30, 52000.2m, 30);
            await first.DrainAsync();
        }
        // A restart: the next recording appends another member to the same file.
        await using var second = new TrueDataTickStore(_dir, NullLogger.Instance);
        second.RecordTrade("BANKNIFTY-I", At(10, 1), 52010m, 60, 1, 52009.8m, 30, 52010.2m, 30);
        await second.DrainAsync();
        var csv = second.ReadLive("BANKNIFTY-I", Past)!;
        Assert.Single(csv.Split('\n').Where(l => l.StartsWith("time,")));            // the header once, at the top
        Assert.Equal(new[] { 52000m, 52010m }, TrueDataTickCsv.Parse(csv).Ticks.Select(t => t.Ltp));
        // A member cut short (a crash mid-write) ends the read - what came before is kept.
        File.AppendAllText(second.LiveFile("BANKNIFTY-I", Past), "\u001f\u008b\u0008 cut");
        Assert.Equal(2, TrueDataTickCsv.Parse(second.ReadLive("BANKNIFTY-I", Past)).Ticks.Count);
    }

    private sealed class FakeHistory : ITrueDataHistoryApi
    {
        public int Calls;
        public string Answer = "";
        public Task<string> GetTicksWithBidAskAsync(string symbol, DateTime fromIst, DateTime toIst, CancellationToken cancellationToken) { Calls++; return Task.FromResult(Answer); }
    }

    private static string HistoryCsv() =>
        "time,ltp,volume,oi,bid,bid_qty,ask,ask_qty\n"
        + string.Join("\n", Enumerable.Range(0, 10).Select(i => $"{Past:yyyy-MM-dd} {9 + i / 6:00}:{(15 + i * 7) % 60:00}:00,{24500 + i},{100 * (i + 1)},0,{24499 + i},75,{24501 + i},75"));

    [Fact]
    public async Task A_past_day_of_tick_history_is_asked_of_TrueData_once_then_read_from_disk()
    {
        await using var store = new TrueDataTickStore(_dir, NullLogger.Instance);
        var inner = new FakeHistory { Answer = HistoryCsv() };
        var api = new CachingTrueDataHistoryApi(inner, store);
        var day = Past.ToDateTime(new TimeOnly(9, 15));
        var close = Past.ToDateTime(new TimeOnly(15, 30));
        var first = await api.GetTicksWithBidAskAsync("NIFTY26DECFUT", day, close, default);
        var again = await api.GetTicksWithBidAskAsync("NIFTY26DECFUT", day, close, default);
        Assert.Equal(1, inner.Calls);
        Assert.Equal(TrueDataTickCsv.Parse(first).Ticks, TrueDataTickCsv.Parse(again).Ticks);
        Assert.True(File.Exists(store.HistoryFile("NIFTY26DECFUT", Past)));
        // A window inside the kept day: its lines only, still no call.
        var part = await api.GetTicksWithBidAskAsync("NIFTY26DECFUT", Past.ToDateTime(new TimeOnly(9, 20)), Past.ToDateTime(new TimeOnly(9, 40)), default);
        Assert.Equal(1, inner.Calls);
        Assert.All(TrueDataTickCsv.Parse(part).Ticks, t => Assert.InRange(t.Time.TimeOfDay, new TimeSpan(9, 20, 0), new TimeSpan(9, 40, 0)));
        // Today is never kept; a window that is not the whole session is not kept either.
        var today = IstClock.Today();
        await api.GetTicksWithBidAskAsync("NIFTY26DECFUT", today.ToDateTime(new TimeOnly(9, 15)), today.ToDateTime(new TimeOnly(15, 30)), default);
        Assert.False(File.Exists(store.HistoryFile("NIFTY26DECFUT", today)));
        await api.GetTicksWithBidAskAsync("NIFTY26DECFUT", Past.AddDays(-1).ToDateTime(new TimeOnly(10, 0)), Past.AddDays(-1).ToDateTime(new TimeOnly(11, 0)), default);
        Assert.False(File.Exists(store.HistoryFile("NIFTY26DECFUT", Past.AddDays(-1))));
    }

    [Fact]
    public async Task A_day_TrueData_no_longer_keeps_replays_from_what_was_recorded_live()
    {
        await using var store = new TrueDataTickStore(_dir, NullLogger.Instance);
        store.RecordTrade("NIFTY-I", At(9, 30), 24600m, 1000, 0, 24599.9m, 65, 24600.1m, 65);
        store.RecordTrade("NIFTY-I", At(9, 31), 24610m, 1130, 0, 24609.9m, 65, 24610.1m, 65);
        await store.DrainAsync();
        var gone = new FakeHistory { Answer = "No data exists for NIFTY-I" };
        var api = new CachingTrueDataHistoryApi(gone, store);
        var csv = await api.GetTicksWithBidAskAsync("NIFTY-I", Past.ToDateTime(new TimeOnly(9, 15)), Past.ToDateTime(new TimeOnly(15, 30)), default);
        Assert.Equal(new[] { 24600m, 24610m }, TrueDataTickCsv.Parse(csv).Ticks.Select(t => t.Ltp));
        // TickHistoryDays builds the replayed day from it - the rise in volume is the trade.
        var book = TickHistoryDays.Build(new TrueDataLiveInstrument { Underlying = "NIFTY", Symbol = "NIFTY-I", LotSize = 65, TickSize = 0.05m }, TrueDataTickCsv.Parse(csv).Ticks, false);
        Assert.NotNull(book);
    }

    /// <summary>HOW BIG A DAY IS: one contract at 3 ticks a second through the whole session (09:15 - 15:30 = 22 500 s = 67 500 ticks) - a futures
    /// contract and an option written through the store exactly as live, and the file's size measured.</summary>
    [Fact]
    public async Task A_day_at_three_ticks_a_second_measured()
    {
        await using var store = new TrueDataTickStore(_dir, NullLogger.Instance);
        var rnd = new Random(7);
        void Day(string symbol, decimal start, decimal tick, long lot, bool option)
        {
            decimal p = start; long vol = 0, oi = option ? 2_500_000 : 12_000_000;
            var open = At(9, 15);
            for (var i = 0; i < 22_500 * 3; i++)
            {
                var t = open.AddMilliseconds(i * 333 + rnd.Next(0, 300));
                p = Math.Max(tick, p + tick * rnd.Next(-3, 4));
                if (rnd.Next(3) == 0) store.RecordQuote(symbol, t, p - tick, lot * rnd.Next(1, 40), p + tick, lot * rnd.Next(1, 40));
                else
                {
                    vol += lot * rnd.Next(1, 20);
                    if (rnd.Next(10) == 0) oi += lot * rnd.Next(-20, 21);
                    store.RecordTrade(symbol, t, p, vol, oi, p - tick, lot * rnd.Next(1, 40), p + tick, lot * rnd.Next(1, 40));
                }
            }
        }
        Day("NIFTY-I", 24500m, 0.05m, 65, false);
        Day("NIFTY26120124500CE", 120m, 0.05m, 65, true);
        await store.DrainAsync();
        var fut = new FileInfo(store.LiveFile("NIFTY-I", Past)).Length;
        var opt = new FileInfo(store.LiveFile("NIFTY26120124500CE", Past)).Length;
        var raw = store.ReadLive("NIFTY-I", Past)!.Length;
        Assert.Equal(67_500, TrueDataTickCsv.Parse(store.ReadLive("NIFTY-I", Past)).Ticks.Count);
        _out.WriteLine($"67,500 ticks a contract: futures {fut / 1024.0 / 1024:0.00} MB compressed ({raw / 1024.0 / 1024:0.0} MB as text), option {opt / 1024.0 / 1024:0.00} MB");
        _out.WriteLine($"a day of 2 futures + 42 options: {(2 * fut + 42 * opt) / 1024.0 / 1024:0} MB; 250 days: {(2 * fut + 42 * opt) * 250 / 1024.0 / 1024 / 1024:0.0} GB");
        Assert.InRange(fut, 100_000, 3_000_000);
    }
}

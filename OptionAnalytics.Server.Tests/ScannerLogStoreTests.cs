using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>ScannerLogStore - the strategy scanner's signals / option trades as CSV on the server:
/// rows upserted by key, files rewritten whole, text made safe for a spreadsheet, only its own file
/// names reachable. Pure file I/O against a temp directory.</summary>
public sealed class ScannerLogStoreTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "oa-scanner-log-tests-" + Guid.NewGuid().ToString("n"));

    private sealed class FakeHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "OptionAnalytics.Server.Tests";
        public string ContentRootPath { get; set; } = "";
        public IFileProvider ContentRootFileProvider { get; set; } = null!;
    }

    private ScannerLogStore Store() => new(
        new FakeHostEnvironment { ContentRootPath = _dir },
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Storage:ScannerLogPath"] = _dir }).Build(),
        NullLogger<ScannerLogStore>.Instance);

    // 10:40:00 IST on 5 Oct 2026.
    private static readonly long T1040 = new DateTimeOffset(2026, 10, 5, 10, 40, 0, TimeSpan.FromMinutes(330)).ToUnixTimeMilliseconds();

    private static ScannerSignalRow Signal(long time, string id = "ibBreakout", string side = "LONG", string status = "open", double? r = null, bool? take = true, string reason = "with the up trend") =>
        new(time, 15, id, "Initial balance breakout", side, 22722.5, 22700, 22760, 67, false, "trend-up", "trend-up", "agrees", "no view",
            take, true, reason, status, r, status == "open" ? null : time + 20 * 60_000, status == "open" ? null : 22760, status == "open" ? null : "Target hit");

    private static ScannerLogDayRequest Day(string date, params ScannerSignalRow[] signals) => new("NIFTY", date, "live", signals.ToList(), null);

    [Fact]
    public async Task ADay_IsWrittenAsCsv_WithIstTimes_TheDayTypeAndTheAdaptiveCall()
    {
        var store = Store();
        var (signals, _, error) = await store.UpsertDayAsync(Day("2026-10-05", Signal(T1040)), "trader@x.in", CancellationToken.None);

        Assert.Null(error);
        Assert.Equal(1, signals);
        var rows = ScannerLogStore.Read(Path.Combine(_dir, "signals_NIFTY_2026-10-05.csv")).ToList();
        var row = Assert.Single(rows);
        Assert.Equal("2026-10-05 10:40:00", row["time_ist"]);
        Assert.Equal("ibBreakout", row["strategy_id"]);
        Assert.Equal("22722.5", row["entry"]);
        Assert.Equal("trend-up", row["day_type"]);
        Assert.Equal("true", row["adaptive_take"]);
        Assert.Equal("trader@x.in", row["user"]);
        Assert.Equal(ScannerLogStore.SignalColumns, File.ReadLines(Path.Combine(_dir, "signals_NIFTY_2026-10-05.csv")).First().Split(','));
    }

    [Fact]
    public async Task APostedRow_ReplacesTheSameKey_AndRowsNotPostedAgainAreKept()
    {
        var store = Store();
        await store.UpsertDayAsync(Day("2026-10-05", Signal(T1040), Signal(T1040 + 30 * 60_000, "range", "SHORT", take: false)), null, CancellationToken.None);
        // Later: the first trade closed - only it is posted again.
        await store.UpsertDayAsync(Day("2026-10-05", Signal(T1040, status: "win", r: 1.8)), null, CancellationToken.None);

        var rows = ScannerLogStore.Read(Path.Combine(_dir, "signals_NIFTY_2026-10-05.csv")).ToList();
        Assert.Equal(2, rows.Count);
        Assert.Equal("win", rows[0]["status"]);
        Assert.Equal("1.8", rows[0]["r"]);
        Assert.Equal("2026-10-05 11:00:00", rows[0]["exit_time_ist"]);
        Assert.Equal("range", rows[1]["strategy_id"]);
        Assert.Equal("false", rows[1]["adaptive_take"]);
    }

    [Fact]
    public async Task Text_WithCommasQuotesAndNewlines_RoundTrips_AndAFormulaIsDefused()
    {
        var store = Store();
        await store.UpsertDayAsync(Day("2026-10-05",
            Signal(T1040, reason: "a \"fade\", on a range day\nsecond line"),
            Signal(T1040 + 60_000, "trap", reason: "=HYPERLINK(\"http://x\")")), null, CancellationToken.None);

        var rows = ScannerLogStore.Read(Path.Combine(_dir, "signals_NIFTY_2026-10-05.csv")).ToList();
        Assert.Equal("a \"fade\", on a range day second line", rows[0]["adaptive_reason"]);
        Assert.StartsWith("'=", rows[1]["adaptive_reason"]);
    }

    [Theory]
    [InlineData("../etc", "2026-10-05")]
    [InlineData("NIFTY/..", "2026-10-05")]
    [InlineData("NIFTY", "2026-13-40")]
    [InlineData("NIFTY", "2019-01-01")]
    [InlineData("NIFTY", "2999-01-01")]
    public async Task ABadUnderlyingOrDate_IsRefused_AndWritesNothing(string underlying, string date)
    {
        var store = Store();
        var (_, _, error) = await store.UpsertDayAsync(new ScannerLogDayRequest(underlying, date, "live", new() { Signal(T1040) }, null), null, CancellationToken.None);

        Assert.NotNull(error);
        Assert.Empty(Directory.GetFiles(_dir));
    }

    [Fact]
    public async Task TooManyRows_AreRefused()
    {
        var store = Store();
        var many = Enumerable.Range(0, ScannerLogStore.MaxSignals + 1).Select((i) => Signal(T1040 + i * 1000L)).ToList();
        var (_, _, error) = await store.UpsertDayAsync(new ScannerLogDayRequest("NIFTY", "2026-10-05", "live", many, null), null, CancellationToken.None);
        Assert.NotNull(error);
    }

    [Fact]
    public async Task Trades_GoToTheirOwnFile_WithTheAdaptiveFlagAndPnl()
    {
        var store = Store();
        var trade = new ScannerTradeRow("p-1", T1040, T1040 + 20 * 60_000, false, "SELL", "PE", 22650, 1, 75, 120.5, 98, 22.5, 1687.5, "Target hit", 15, "ibBreakout", "LONG", "trend-up", true, "with the up trend");
        var (_, trades, _) = await store.UpsertDayAsync(new ScannerLogDayRequest("NIFTY", "2026-10-05", "live", null, new() { trade }), null, CancellationToken.None);

        Assert.Equal(1, trades);
        var row = Assert.Single(ScannerLogStore.Read(Path.Combine(_dir, "trades_NIFTY_2026-10-05.csv")));
        Assert.Equal("SELL", row["action"]);
        Assert.Equal("1687.5", row["rupees"]);
        Assert.Equal("true", row["adaptive_take"]);
        Assert.False(File.Exists(Path.Combine(_dir, "signals_NIFTY_2026-10-05.csv")));
    }

    [Fact]
    public async Task OnlyItsOwnFileNames_AreReachable_AndAllDaysCombineUnderOneHeader()
    {
        var store = Store();
        await store.UpsertDayAsync(Day("2026-10-05", Signal(T1040)), null, CancellationToken.None);
        await store.UpsertDayAsync(Day("2026-10-02", Signal(T1040 - 3 * 86_400_000L)), null, CancellationToken.None);
        File.WriteAllText(Path.Combine(_dir, "other.csv"), "x");

        Assert.NotNull(store.PathOf("signals_NIFTY_2026-10-05.csv"));
        Assert.Null(store.PathOf("../signals_NIFTY_2026-10-05.csv"));
        Assert.Null(store.PathOf("other.csv"));
        Assert.Null(store.PathOf("signals_NIFTY_2026-10-06.csv"));
        Assert.Equal(new[] { "signals_NIFTY_2026-10-05.csv", "signals_NIFTY_2026-10-02.csv" }, store.ListFiles().Select((f) => f.Name));

        var all = ScannerLogStore.Parse(store.Combined("signals")!);
        Assert.Equal(3, all.Count); // one header + both days
        Assert.Equal("date", all[0][1]);
        Assert.Equal("2026-10-02", all[1][1]);
        Assert.Equal("2026-10-05", all[2][1]);
        Assert.Null(store.Combined("../x"));
    }

    [Fact]
    public async Task TheBrowsersJson_BindsToTheRequest_AsAspNetReadsIt()
    {
        // The Order Flow page's body (camelCase, epoch-ms times, nulls for unknowns) - read with the web
        // defaults ASP.NET Core uses for [FromBody].
        const string body = "{\"underlying\":\"NIFTY\",\"date\":\"2026-10-05\",\"source\":\"live\",\"signals\":[{\"time\":1791178200000,\"strategyNo\":15,\"strategyId\":\"ibBreakout\","
            + "\"strategy\":\"Initial balance breakout\",\"side\":\"LONG\",\"entry\":22722.5,\"stop\":22700,\"target\":22760,\"confidence\":67,\"estimated\":false,\"dayType\":\"trend-up\","
            + "\"dayTypePrice\":\"trend-up\",\"voteOi\":\"agrees\",\"voteCvd\":null,\"adaptiveTake\":true,\"adaptivePriceOnly\":true,\"adaptiveReason\":\"with the up trend\",\"status\":\"open\","
            + "\"r\":0.4,\"exitTime\":null,\"exitPrice\":null,\"exitReason\":null}],\"trades\":[{\"key\":\"p1\",\"entryTime\":1791178205000,\"exitTime\":null,\"live\":false,\"action\":\"SELL\","
            + "\"option\":\"PE\",\"strike\":22650,\"lots\":1,\"lotSize\":75,\"entryPremium\":100,\"exitPremium\":null,\"points\":3.5,\"rupees\":262.5,\"exitReason\":null,\"strategyNo\":15,"
            + "\"strategyId\":\"ibBreakout\",\"signalSide\":\"LONG\",\"dayType\":\"trend-up\",\"adaptiveTake\":true,\"adaptiveReason\":\"with the up trend\"}]}";
        var request = System.Text.Json.JsonSerializer.Deserialize<ScannerLogDayRequest>(body, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web))!;

        var (signals, trades, error) = await Store().UpsertDayAsync(request, null, CancellationToken.None);

        Assert.Null(error);
        Assert.Equal((1, 1), (signals, trades));
        Assert.Equal("agrees", Assert.Single(ScannerLogStore.Read(Path.Combine(_dir, "signals_NIFTY_2026-10-05.csv")))["vote_oi"]);
        Assert.Equal("262.5", Assert.Single(ScannerLogStore.Read(Path.Combine(_dir, "trades_NIFTY_2026-10-05.csv")))["rupees"]);
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { /* best effort */ }
    }
}

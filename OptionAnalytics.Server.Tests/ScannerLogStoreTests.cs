using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>ScannerLogStore - the strategy scanner's record as ONE CSV file on the server: a row per
/// signal with its trades, every day and underlying, rows upserted by key, the file rewritten whole,
/// text made safe for a spreadsheet. Pure file I/O against a temp directory.</summary>
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
    private string CsvPath => Path.Combine(_dir, ScannerLogStore.FileName);

    private static ScannerSignalRow Signal(long time, string id = "ibBreakout", string side = "LONG", string status = "open", double? r = null, bool? take = true,
        string reason = "with the up trend", List<ScannerTradeRow>? trades = null) =>
        new(time, 15, id, "Initial balance breakout", side, 22722.5, 22700, 22760, 67, false, "trend-up", "trend-up", "agrees", "no view",
            take, true, reason, status, r, status == "open" ? null : time + 20 * 60_000, status == "open" ? null : 22760, status == "open" ? null : "Target hit", trades);

    private static ScannerTradeRow Trade(long at, string action = "SELL", string option = "PE", double entry = 100, double? exit = 80, bool live = false) =>
        new(at, exit is null ? null : at + 20 * 60_000, live, action, option, 22650, 1, entry, exit, exit is null ? 3.5 : action == "SELL" ? entry - exit : exit - entry,
            exit is null ? 262.5 : (action == "SELL" ? entry - exit.Value : exit.Value - entry) * 75, exit is null ? null : "Target hit");

    private static ScannerLogDayRequest Day(string date, params ScannerSignalRow[] signals) => new("NIFTY", date, "live", signals.ToList());

    [Fact]
    public async Task EveryDay_GoesIntoOneFile_WithIstTimes_TheDayTypeAndTheAdaptiveCall()
    {
        var store = Store();
        var (rows, error) = await store.UpsertDayAsync(Day("2026-10-05", Signal(T1040)), "trader@x.in", CancellationToken.None);
        await store.UpsertDayAsync(new ScannerLogDayRequest("BANKNIFTY", "2026-10-02", "scan", new() { Signal(T1040 - 3 * 86_400_000L) }), null, CancellationToken.None);

        Assert.Null(error);
        Assert.Equal(1, rows);
        Assert.Equal(new[] { ScannerLogStore.FileName }, Directory.GetFiles(_dir).Select(Path.GetFileName));
        var all = ScannerLogStore.Read(CsvPath).ToList();
        Assert.Equal(2, all.Count);
        Assert.Equal(("2026-10-02", "BANKNIFTY", "scan"), (all[0]["date"], all[0]["underlying"], all[0]["source"])); // oldest first
        var row = all[1];
        Assert.Equal("2026-10-05 10:40:00", row["time_ist"]);
        Assert.Equal("ibBreakout", row["strategy_id"]);
        Assert.Equal("22722.5", row["entry"]);
        Assert.Equal("trend-up", row["day_type"]);
        Assert.Equal("true", row["adaptive_take"]);
        Assert.Equal("trader@x.in", row["user"]);
        Assert.Equal("", row["trades"]); // nothing punched
        Assert.Equal(ScannerLogStore.Columns, File.ReadLines(CsvPath).First().Split(','));
    }

    [Fact]
    public async Task ASignalsTrades_AreOnItsOwnRow_CountedSummedAndSpelledOut()
    {
        var store = Store();
        await store.UpsertDayAsync(Day("2026-10-05", Signal(T1040, status: "win", r: 1.8, trades: new() { Trade(T1040 + 5000), Trade(T1040 + 6000, "BUY", "CE", 50, 62, live: true) })), null, CancellationToken.None);

        var row = Assert.Single(ScannerLogStore.Read(CsvPath));
        Assert.Equal("2", row["trades"]);
        Assert.Equal("true", row["trade_live"]);
        Assert.Equal("32", row["trade_points"]);          // 20 + 12
        Assert.Equal("2400", row["trade_rupees"]);        // 1500 + 900
        Assert.Contains("SELL PE 22650 x1 @100 -> 80 = +20 pts Rs 1500 (Target hit, 10:40-11:00)", row["trade_detail"]);
        Assert.Contains("LIVE BUY CE 22650 x1 @50 -> 62", row["trade_detail"]);
    }

    [Fact]
    public async Task APostedRow_ReplacesTheSameKey_AndEveryOtherRowIsKept()
    {
        var store = Store();
        await store.UpsertDayAsync(Day("2026-10-05", Signal(T1040, trades: new() { Trade(T1040 + 5000, exit: null) }), Signal(T1040 + 30 * 60_000, "range", "SHORT", take: false)), null, CancellationToken.None);
        // Later: the first trade closed - only it is posted again.
        await store.UpsertDayAsync(Day("2026-10-05", Signal(T1040, status: "win", r: 1.8, trades: new() { Trade(T1040 + 5000) })), null, CancellationToken.None);

        var rows = ScannerLogStore.Read(CsvPath).ToList();
        Assert.Equal(2, rows.Count);
        Assert.Equal(("win", "1.8", "2026-10-05 11:00:00", "1500"), (rows[0]["status"], rows[0]["r"], rows[0]["exit_time_ist"], rows[0]["trade_rupees"]));
        Assert.Equal(("range", "false"), (rows[1]["strategy_id"], rows[1]["adaptive_take"]));
    }

    [Fact]
    public async Task Text_WithCommasQuotesAndNewlines_RoundTrips_AndAFormulaIsDefused()
    {
        var store = Store();
        await store.UpsertDayAsync(Day("2026-10-05",
            Signal(T1040, reason: "a \"fade\", on a range day\nsecond line"),
            Signal(T1040 + 60_000, "trap", reason: "=HYPERLINK(\"http://x\")")), null, CancellationToken.None);

        var rows = ScannerLogStore.Read(CsvPath).ToList();
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
        var (_, error) = await store.UpsertDayAsync(new ScannerLogDayRequest(underlying, date, "live", new() { Signal(T1040) }), null, CancellationToken.None);

        Assert.NotNull(error);
        Assert.False(File.Exists(CsvPath));
    }

    [Fact]
    public async Task TooManyRows_AreRefused()
    {
        var store = Store();
        var many = Enumerable.Range(0, ScannerLogStore.MaxSignals + 1).Select((i) => Signal(T1040 + i * 1000L)).ToList();
        Assert.NotNull((await store.UpsertDayAsync(new ScannerLogDayRequest("NIFTY", "2026-10-05", "live", many), null, CancellationToken.None)).Error);
        var tooManyTrades = Enumerable.Range(0, ScannerLogStore.MaxTradesPerSignal + 1).Select((i) => Trade(T1040 + i)).ToList();
        Assert.NotNull((await store.UpsertDayAsync(Day("2026-10-05", Signal(T1040, trades: tooManyTrades)), null, CancellationToken.None)).Error);
    }

    [Fact]
    public void BeforeAnythingIsStored_TheDownloadIsJustTheHeader()
    {
        Assert.Equal(string.Join(',', ScannerLogStore.Columns) + "\n", Store().ReadAll());
    }

    [Fact]
    public async Task TheBrowsersJson_BindsToTheRequest_AsAspNetReadsIt()
    {
        // The Order Flow page's body (camelCase, epoch-ms times, nulls for unknowns) - read with the web
        // defaults ASP.NET Core uses for [FromBody].
        const string body = "{\"underlying\":\"NIFTY\",\"date\":\"2026-10-05\",\"source\":\"live\",\"signals\":[{\"time\":1791178200000,\"strategyNo\":15,\"strategyId\":\"ibBreakout\","
            + "\"strategy\":\"Initial balance breakout\",\"side\":\"LONG\",\"entry\":22722.5,\"stop\":22700,\"target\":22760,\"confidence\":67,\"estimated\":false,\"dayType\":\"trend-up\","
            + "\"dayTypePrice\":\"trend-up\",\"voteOi\":\"agrees\",\"voteCvd\":null,\"adaptiveTake\":true,\"adaptivePriceOnly\":true,\"adaptiveReason\":\"with the up trend\",\"status\":\"open\","
            + "\"r\":0.4,\"exitTime\":null,\"exitPrice\":null,\"exitReason\":null,\"trades\":[{\"entryTime\":1791178205000,\"exitTime\":null,\"live\":false,\"action\":\"SELL\","
            + "\"option\":\"PE\",\"strike\":22650,\"lots\":1,\"entryPremium\":100,\"exitPremium\":null,\"points\":3.5,\"rupees\":262.5,\"exitReason\":null}]}]}";
        var request = System.Text.Json.JsonSerializer.Deserialize<ScannerLogDayRequest>(body, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web))!;

        var (rows, error) = await Store().UpsertDayAsync(request, null, CancellationToken.None);

        Assert.Null(error);
        Assert.Equal(1, rows);
        var row = Assert.Single(ScannerLogStore.Read(CsvPath));
        Assert.Equal(("agrees", "1", "262.5"), (row["vote_oi"], row["trades"], row["trade_rupees"]));
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { /* best effort */ }
    }
}

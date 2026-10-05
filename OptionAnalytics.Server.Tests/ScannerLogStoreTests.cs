using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>ScannerLogStore - the strategy scanner's record as two CSV files on the server, signals.csv
/// and trades.csv, every day and underlying in each: rows upserted by key, files rewritten whole, text
/// made safe for a spreadsheet. Pure file I/O against a temp directory.</summary>
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
    private string SignalsPath => Path.Combine(_dir, ScannerLogStore.SignalsFile);
    private string TradesPath => Path.Combine(_dir, ScannerLogStore.TradesFile);

    private static ScannerSignalRow Signal(long time, string id = "ibBreakout", string side = "LONG", string status = "open", double? r = null, bool? take = true, string reason = "with the up trend") =>
        new(time, 15, id, "Initial balance breakout", side, 22722.5, 22700, 22760, 67, false, "trend-up", "trend-up", "agrees", "no view",
            take, true, reason, status, r, status == "open" ? null : time + 20 * 60_000, status == "open" ? null : 22760, status == "open" ? null : "Target hit");

    private static ScannerTradeRow Trade(string key, long at, double? exit = 80, bool take = true) =>
        new(key, at, exit is null ? null : at + 20 * 60_000, false, "SELL", "PE", 22650, 1, 75, 100, exit, exit is null ? 3.5 : 100 - exit,
            exit is null ? 262.5 : (100 - exit.Value) * 75, exit is null ? null : "Target hit", T1040, 15, "ibBreakout", "LONG", "trend-up", take, "with the up trend");

    private static ScannerLogDayRequest Day(string date, ScannerSignalRow[] signals, ScannerTradeRow[]? trades = null) => new("NIFTY", date, "live", signals.ToList(), trades?.ToList());

    [Fact]
    public async Task TwoFiles_SignalsAndTrades_HoldEveryDay_NoFilePerDay()
    {
        var store = Store();
        var (signals, trades, error) = await store.UpsertDayAsync(Day("2026-10-05", new[] { Signal(T1040) }, new[] { Trade("p1", T1040 + 5000) }), "trader@x.in", CancellationToken.None);
        await store.UpsertDayAsync(new ScannerLogDayRequest("BANKNIFTY", "2026-10-02", "scan", new() { Signal(T1040 - 3 * 86_400_000L) }, null), null, CancellationToken.None);

        Assert.Null(error);
        Assert.Equal((1, 1), (signals, trades));
        Assert.Equal(new[] { ScannerLogStore.SignalsFile, ScannerLogStore.TradesFile }.OrderBy((x) => x), Directory.GetFiles(_dir).Select(Path.GetFileName).OrderBy((x) => x));
        var all = ScannerLogStore.Read(SignalsPath).ToList();
        Assert.Equal(2, all.Count);
        Assert.Equal(("2026-10-02", "BANKNIFTY", "scan"), (all[0]["date"], all[0]["underlying"], all[0]["source"])); // oldest first
        var row = all[1];
        Assert.Equal(("2026-10-05 10:40:00", "ibBreakout", "22722.5", "trend-up", "true", "trader@x.in"),
            (row["time_ist"], row["strategy_id"], row["entry"], row["day_type"], row["adaptive_take"], row["user"]));
        Assert.Equal(ScannerLogStore.SignalColumns, File.ReadLines(SignalsPath).First().Split(','));
        Assert.Equal(ScannerLogStore.TradeColumns, File.ReadLines(TradesPath).First().Split(','));
    }

    [Fact]
    public async Task ATrade_NamesItsSignal_AndCarriesTheAdaptiveFlagAndPnl()
    {
        var store = Store();
        await store.UpsertDayAsync(Day("2026-10-05", Array.Empty<ScannerSignalRow>(), new[] { Trade("p1", T1040 + 5000) }), null, CancellationToken.None);

        var row = Assert.Single(ScannerLogStore.Read(TradesPath));
        Assert.Equal(("SELL", "PE", "100", "80", "20", "1500", "Target hit"), (row["action"], row["option"], row["entry_premium"], row["exit_premium"], row["points"], row["rupees"], row["exit_reason"]));
        Assert.Equal(("2026-10-05 10:40:00", "ibBreakout", "LONG", "true"), (row["signal_time_ist"], row["strategy_id"], row["signal_side"], row["adaptive_take"]));
        Assert.Equal(("2026-10-05 10:40:05", "2026-10-05 11:00:05"), (row["entry_time_ist"], row["exit_time_ist"]));
        Assert.False(File.Exists(SignalsPath));
    }

    [Fact]
    public async Task APostedRow_ReplacesTheSameKey_AndEveryOtherRowIsKept()
    {
        var store = Store();
        await store.UpsertDayAsync(Day("2026-10-05", new[] { Signal(T1040), Signal(T1040 + 30 * 60_000, "range", "SHORT", take: false) },
            new[] { Trade("p1", T1040 + 5000, exit: null), Trade("p2", T1040 + 30 * 60_000, take: false) }), null, CancellationToken.None);
        // Later: the first signal and its trade closed - only they are posted again.
        await store.UpsertDayAsync(Day("2026-10-05", new[] { Signal(T1040, status: "win", r: 1.8) }, new[] { Trade("p1", T1040 + 5000) }), null, CancellationToken.None);

        var signals = ScannerLogStore.Read(SignalsPath).ToList();
        Assert.Equal(2, signals.Count);
        Assert.Equal(("win", "1.8", "2026-10-05 11:00:00"), (signals[0]["status"], signals[0]["r"], signals[0]["exit_time_ist"]));
        Assert.Equal(("range", "false"), (signals[1]["strategy_id"], signals[1]["adaptive_take"]));
        var trades = ScannerLogStore.Read(TradesPath).ToList();
        Assert.Equal(2, trades.Count);
        Assert.Equal(("1500", "false"), (trades[0]["rupees"], trades[1]["adaptive_take"]));
    }

    [Fact]
    public async Task Text_WithCommasQuotesAndNewlines_RoundTrips_AndAFormulaIsDefused()
    {
        var store = Store();
        await store.UpsertDayAsync(Day("2026-10-05", new[]
        {
            Signal(T1040, reason: "a \"fade\", on a range day\nsecond line"),
            Signal(T1040 + 60_000, "trap", reason: "=HYPERLINK(\"http://x\")"),
        }), null, CancellationToken.None);

        var rows = ScannerLogStore.Read(SignalsPath).ToList();
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
        var (_, _, error) = await store.UpsertDayAsync(new ScannerLogDayRequest(underlying, date, "live", new() { Signal(T1040) }, new() { Trade("p1", T1040) }), null, CancellationToken.None);

        Assert.NotNull(error);
        Assert.Empty(Directory.GetFiles(_dir));
    }

    [Fact]
    public async Task TooManyRows_AreRefused()
    {
        var store = Store();
        var many = Enumerable.Range(0, ScannerLogStore.MaxSignals + 1).Select((i) => Signal(T1040 + i * 1000L)).ToArray();
        Assert.NotNull((await store.UpsertDayAsync(Day("2026-10-05", many), null, CancellationToken.None)).Error);
        var manyTrades = Enumerable.Range(0, ScannerLogStore.MaxTrades + 1).Select((i) => Trade($"p{i}", T1040 + i)).ToArray();
        Assert.NotNull((await store.UpsertDayAsync(Day("2026-10-05", Array.Empty<ScannerSignalRow>(), manyTrades), null, CancellationToken.None)).Error);
    }

    [Fact]
    public void BeforeAnythingIsStored_ADownloadIsJustTheHeader_AndOnlyTheTwoNamesExist()
    {
        var store = Store();
        Assert.Equal(string.Join(',', ScannerLogStore.SignalColumns) + "\n", store.ReadAll("signals"));
        Assert.Equal(string.Join(',', ScannerLogStore.TradeColumns) + "\n", store.ReadAll("trades"));
        Assert.Null(store.ReadAll("../appsettings"));
        Assert.Null(store.PathOf("day"));
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
            + "\"option\":\"PE\",\"strike\":22650,\"lots\":1,\"lotSize\":75,\"entryPremium\":100,\"exitPremium\":null,\"points\":3.5,\"rupees\":262.5,\"exitReason\":null,"
            + "\"signalTime\":1791178200000,\"strategyNo\":15,\"strategyId\":\"ibBreakout\",\"signalSide\":\"LONG\",\"dayType\":\"trend-up\",\"adaptiveTake\":true,\"adaptiveReason\":\"with the up trend\"}]}";
        var request = System.Text.Json.JsonSerializer.Deserialize<ScannerLogDayRequest>(body, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web))!;

        var (signals, trades, error) = await Store().UpsertDayAsync(request, null, CancellationToken.None);

        Assert.Null(error);
        Assert.Equal((1, 1), (signals, trades));
        Assert.Equal("agrees", Assert.Single(ScannerLogStore.Read(SignalsPath))["vote_oi"]);
        Assert.Equal(("262.5", "2026-10-05 11:00:00"), (Assert.Single(ScannerLogStore.Read(TradesPath))["rupees"], ScannerLogStore.Read(TradesPath).Single()["signal_time_ist"]));
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { /* best effort */ }
    }
}

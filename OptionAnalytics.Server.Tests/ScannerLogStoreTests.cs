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
            exit is null ? 262.5 : (100 - exit.Value) * 75, exit is null ? null : "Target hit", T1040, 15, "ibBreakout", "LONG", "trend-up", take, "with the up trend",
            11.25, 40, 7, exit is null ? 204.25 : (100 - exit.Value) * 75 - 58.25, exit is null ? 204.25 : (100 - exit.Value) * 75 - 58.25);

    private static ScannerLogDayRequest Day(string date, ScannerSignalRow[] signals, ScannerTradeRow[]? trades = null) => new("NIFTY", date, "live", signals.ToList(), trades?.ToList());

    [Fact]
    public async Task ASignal_KeepsWhatTheOptionBoughtAndSoldWouldHaveMade_AndItsTradeTheIndexPoints()
    {
        var store = Store();
        var signal = Signal(T1040, status: "win", r: 1.5) with
        {
            BuyOption = "BUY 22700 CE", BuyEntry = 110, BuyExit = 131.5, BuyPoints = 21.5,
            SellOption = "SELL 22700 PE", SellEntry = 95, SellExit = 80.25, SellPoints = 14.75,
        };
        var trade = Trade("p1", T1040 + 5000) with { IndexPoints = 37.5, BuyPoints = 21.5, SellPoints = 14.75 };
        await store.UpsertDayAsync(Day("2026-10-05", new[] { signal }, new[] { trade }), null, CancellationToken.None);

        var s = ScannerLogStore.Read(SignalsPath).Single();
        Assert.Equal(("BUY 22700 CE", "110", "131.5", "21.5", "SELL 22700 PE", "80.25", "14.75"),
            (s["buy_option"], s["buy_entry"], s["buy_exit"], s["buy_points"], s["sell_option"], s["sell_exit"], s["sell_points"]));
        var t = ScannerLogStore.Read(TradesPath).Single();
        Assert.Equal(("37.5", "21.5", "14.75"), (t["index_points"], t["buy_points"], t["sell_points"]));
        // A row from before them: blank, and the file keeps its other columns.
        await store.UpsertDayAsync(Day("2026-10-06", new[] { Signal(T1040 + 86_400_000L) }), null, CancellationToken.None);
        Assert.Equal("", ScannerLogStore.Read(SignalsPath).Last()["buy_points"]);
    }

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
    public async Task ReadRows_GivesEachFileAsRows_ForTheTradesPage()
    {
        var store = Store();
        Assert.Empty(store.ReadRows("signals")!);
        await store.UpsertDayAsync(Day("2026-10-05", new[] { Signal(T1040) }, new[] { Trade("p1", T1040 + 5000) }), null, CancellationToken.None);

        var signal = Assert.Single(store.ReadRows("signals")!);
        Assert.Equal(("2026-10-05", "NIFTY", "2026-10-05 10:40:00", "ibBreakout"), (signal["date"], signal["underlying"], signal["time_ist"], signal["strategy_id"]));
        var trade = Assert.Single(store.ReadRows("trades")!);
        Assert.Equal(("SELL", "PE", "2026-10-05 10:40:05"), (trade["action"], trade["option"], trade["entry_time_ist"]));
        Assert.Empty(store.ReadRows("server-trades")!);
        Assert.Null(store.ReadRows("../appsettings"));
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
        Assert.Equal(("11.25", "40", "7", "1441.75", "1441.75"), (row["stt"], row["brokerage"], row["other_charges"], row["net_rupees"], row["net_per_lot"]));
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

    // ---- totals per underlying ---------------------------------------------------------------------

    private static ScannerSignalRow Closed(long time, string side, double entry, double exit, string status, double r, bool take = true) =>
        new(time, 15, "ibBreakout", "Initial balance breakout", side, entry, entry - 20, entry + 40, 67, false, "trend-up", "trend-up", "agrees", "no view",
            take, true, "x", status, r, time + 20 * 60_000, exit, "Target hit");

    private static ScannerTradeRow TradeOf(string key, long at, double points, double net, bool take = true, bool live = false, bool open = false) =>
        new(key, at, open ? null : at + 600_000, live, "SELL", "PE", 22650, 1, 75, 100, open ? null : 100 - points, points, points * 75, "t", T1040, 15, "ibBreakout", "LONG", "trend-up", take, "x",
            11.25, 40, 7, net, net);

    [Fact]
    public async Task ASignalsMarketAtTheTime_IsKeptInItsMktColumns()
    {
        var store = Store();
        var market = new Dictionary<string, double?> { ["tape60"] = 68, ["bigNet"] = -12, ["futOi15"] = 0.42, ["bookImb"] = 0.31, ["writers15"] = null, ["unknown"] = 5 };
        await store.UpsertDayAsync(new ScannerLogDayRequest("NIFTY", "2026-10-05", "server", new()
        {
            new ScannerSignalRow(T1040, 34, "pocReject", "POC rejection", "LONG", 22710, 22690, 22750, 60, false, "range", "range", "x", "x", false, true, "x", "open", 0, null, null, null, market),
            new ScannerSignalRow(T1040 + 60_000, 15, "ibBreakout", "IB", "LONG", 22710, 22690, 22750, 60, false, "range", "range", "x", "x", false, true, "x", "open", 0, null, null, null),
        }, null), null, CancellationToken.None);
        var rows = ScannerLogStore.Read(store.PathOf("server-signals")!).ToList();
        var a = rows.Single(r => r["strategy_id"] == "pocReject");
        Assert.Equal(("68", "-12", "0.42", "0.31", ""), (a["mkt_tape60"], a["mkt_big_net"], a["mkt_fut_oi15"], a["mkt_book_imb"], a["mkt_writers15"]));
        Assert.DoesNotContain(a.Keys, k => k.Contains("unknown"));
        Assert.Equal("", rows.Single(r => r["strategy_id"] == "ibBreakout")["mkt_tape60"]); // none sent: blank
    }

    [Fact]
    public async Task TheSummary_TotalsEachUnderlyingSeparately_PointsTradesAndNet()
    {
        var store = Store();
        long day2 = T1040 + 86_400_000L; // 6 Oct
        // NIFTY 5 Oct: a LONG 22700 -> 22740 (+40, win 2R, adaptive), a SHORT 22800 -> 22830 (-30, loss -1.5R, not adaptive), an open one.
        await store.UpsertDayAsync(new ScannerLogDayRequest("NIFTY", "2026-10-05", "live", new()
        {
            Closed(T1040, "LONG", 22700, 22740, "win", 2),
            Closed(T1040 + 60_000, "SHORT", 22800, 22830, "loss", -1.5, take: false),
            new ScannerSignalRow(T1040 + 120_000, 15, "ibBreakout", "IB", "LONG", 22710, 22690, 22750, 60, false, "range", "range", "no view", "no view", false, true, "x", "open", 0.2, null, null, null),
        }, new() { TradeOf("p1", T1040, 20, 1441.75), TradeOf("p2", T1040 + 60_000, -10, -807.25, take: false, live: true), TradeOf("p3", T1040 + 120_000, 3.5, 204.25, open: true) }), null, CancellationToken.None);
        // NIFTY 6 Oct and BANKNIFTY 5 Oct.
        await store.UpsertDayAsync(new ScannerLogDayRequest("NIFTY", "2026-10-06", "live", new() { Closed(day2, "SHORT", 22800, 22760, "win", 1) }, null), null, CancellationToken.None);
        await store.UpsertDayAsync(new ScannerLogDayRequest("BANKNIFTY", "2026-10-05", "live", new() { Closed(T1040, "LONG", 51000, 51120, "win", 1.2) }, new() { TradeOf("b1", T1040, 80, 5000) }), null, CancellationToken.None);

        var rows = await store.SummaryAsync(CancellationToken.None);

        Assert.Equal(new[] { "BANKNIFTY|day|2026-10-05", "BANKNIFTY|total|", "NIFTY|day|2026-10-05", "NIFTY|day|2026-10-06", "NIFTY|total|" },
            rows.Select(r => $"{r.Underlying}|{r.Scope}|{r.Date}"));
        var nifty = rows.Single(r => r.Underlying == "NIFTY" && r.Scope == "total");
        Assert.Equal((4, 3, 2, 66.7), (nifty.Signals, nifty.ClosedSignals, nifty.Wins, nifty.WinPct));   // 4 signals, 3 closed, 2 wins
        Assert.Equal(50.0, nifty.FuturesPoints);          // +40 - 30 + 40
        Assert.Equal(1.5, nifty.TotalR);                  // 2 - 1.5 + 1
        Assert.Equal((3, 1, 1), (nifty.Trades, nifty.LiveTrades, nifty.OpenTrades));
        Assert.Equal(13.5, nifty.OptionPoints);           // 20 - 10 + 3.5
        Assert.Equal(838.75, nifty.NetRupees);            // 1441.75 - 807.25 + 204.25
        // What an adaptive scanner would have taken: signals 1 and day 2's; trades p1 and p3 (p2 was not).
        Assert.Equal((2, 80.0, 2, 23.5, 1646.0), (nifty.AdaptiveSignals, nifty.AdaptiveFuturesPoints, nifty.AdaptiveTrades, nifty.AdaptiveOptionPoints, nifty.AdaptiveNetRupees));
        // P&L per lot: every trade as if done with one lot, summed - all, the adaptive ones (p1 + p3) and the non-adaptive one (p2).
        Assert.Equal((838.75, 1646.0), (nifty.NetPerLot, nifty.AdaptiveNetPerLot));
        Assert.Equal((1, -10.0, -807.25, -807.25, 0), (nifty.NonAdaptiveTrades, nifty.NonAdaptiveOptionPoints, nifty.NonAdaptiveNetRupees, nifty.NonAdaptiveNetPerLot, nifty.UntaggedTrades));
        var bank = rows.Single(r => r.Underlying == "BANKNIFTY" && r.Scope == "total");
        Assert.Equal((1, 120.0, 80.0, 5000.0), (bank.Signals, bank.FuturesPoints, bank.OptionPoints, bank.NetRupees));
        var day = rows.Single(r => r.Underlying == "NIFTY" && r.Date == "2026-10-06");
        Assert.Equal((1, 40.0), (day.Signals, day.FuturesPoints));
    }

    [Fact]
    public async Task TheSignalsFile_CarriesTheFuturesPointsCaptured_OfEachClosedSignal()
    {
        var store = Store();
        await store.UpsertDayAsync(new ScannerLogDayRequest("NIFTY", "2026-10-05", "live", new()
        {
            Closed(T1040, "LONG", 22700, 22740, "win", 2), Closed(T1040 + 60_000, "SHORT", 22800, 22830, "loss", -1.5),
            new ScannerSignalRow(T1040 + 120_000, 15, "ibBreakout", "IB", "LONG", 22710, 22690, 22750, 60, false, "range", "range", "no view", "no view", false, true, "x", "open", 0.2, null, null, null),
        }, null), null, CancellationToken.None);

        var rows = ScannerLogStore.Read(SignalsPath).ToList();
        Assert.Equal(("40", "-30", ""), (rows[0]["points"], rows[1]["points"], rows[2]["points"]));
        Assert.Contains("points", File.ReadLines(SignalsPath).First().Split(','));
    }

    [Fact]
    public void ATradeSavedWithNoAdaptiveCall_IsInTheTotal_ButInNeitherGroup()
    {
        var trade = new Dictionary<string, string> { ["underlying"] = "NIFTY", ["date"] = "2026-10-05", ["points"] = "10", ["net_rupees"] = "500", ["net_per_lot"] = "500", ["adaptive_take"] = "" };
        var total = ScannerLogStore.Summarize(Array.Empty<Dictionary<string, string>>(), new[] { trade }).Single(r => r.Scope == "total");
        Assert.Equal((1, 500.0, 0, 0, 1), (total.Trades, total.NetPerLot, total.AdaptiveTrades, total.NonAdaptiveTrades, total.UntaggedTrades));
    }

    [Fact]
    public void RowsWrittenBeforeThePointsColumnExisted_StillTotal_FromTheirEntryAndExit()
    {
        var old = new Dictionary<string, string> { ["underlying"] = "NIFTY", ["date"] = "2026-10-05", ["side"] = "SHORT", ["entry"] = "22800", ["exit_price"] = "22760", ["status"] = "win", ["r"] = "1", ["adaptive_take"] = "true" };
        var rows = ScannerLogStore.Summarize(new[] { old }, Array.Empty<Dictionary<string, string>>());
        Assert.Equal(40.0, rows.Single(r => r.Scope == "total").FuturesPoints);
    }

    [Fact]
    public async Task TheSummaryCsv_HasAHeader_ADayRowAndATotalRowPerUnderlying()
    {
        var store = Store();
        await store.UpsertDayAsync(new ScannerLogDayRequest("NIFTY", "2026-10-05", "live", new() { Closed(T1040, "LONG", 22700, 22740, "win", 2) }, new() { TradeOf("p1", T1040, 20, 1441.75) }), null, CancellationToken.None);

        var csv = ScannerLogStore.Parse(ScannerLogStore.SummaryCsv(await store.SummaryAsync(CancellationToken.None)));

        Assert.Equal(ScannerLogStore.SummaryColumns, csv[0]);
        Assert.Equal(3, csv.Count);
        var total = csv[2];
        Assert.Equal(("total", "NIFTY", ""), (total[0], total[1], total[2]));
        Assert.Equal("40", total[Array.IndexOf(ScannerLogStore.SummaryColumns, "futures_points")]);
        Assert.Equal("20", total[Array.IndexOf(ScannerLogStore.SummaryColumns, "option_points")]);
        Assert.Equal("1441.75", total[Array.IndexOf(ScannerLogStore.SummaryColumns, "net_rupees")]);
    }

    [Fact]
    public async Task NothingStored_MeansAnEmptySummary_AndAHeaderOnlyCsv()
    {
        var store = Store();
        Assert.Empty(await store.SummaryAsync(CancellationToken.None));
        Assert.Equal(string.Join(',', ScannerLogStore.SummaryColumns) + "\n", ScannerLogStore.SummaryCsv(Array.Empty<ScannerSummaryRow>()));
    }


    [Fact]
    public async Task TheServerScannersRows_GoToTheirOwnFiles_AndLeaveThePagesRowsAlone()
    {
        var store = Store();
        await store.UpsertDayAsync(Day("2026-10-05", new[] { Signal(T1040) }, new[] { Trade("p1", T1040 + 5000) }), null, CancellationToken.None);
        await store.UpsertDayAsync(Day("2026-10-05", new[] { Signal(T1040, status: "win", r: 2) }, new[] { Trade("p1", T1040 + 5000) }) with { Source = "server" }, "scanner-runner", CancellationToken.None);

        var page = File.ReadAllText(SignalsPath);
        Assert.Contains(",open,", page);
        Assert.DoesNotContain(",win,", page);
        var server = File.ReadAllText(Path.Combine(_dir, ScannerLogStore.ServerPrefix + ScannerLogStore.SignalsFile));
        Assert.Contains(",win,", server);
        Assert.Contains("server", server);
        Assert.True(File.Exists(Path.Combine(_dir, ScannerLogStore.ServerPrefix + ScannerLogStore.TradesFile)));
        Assert.Equal(1, (await store.SummaryAsync(CancellationToken.None, "server")).Single(r => r.Scope == "total").Wins);
        Assert.NotNull(store.ReadAll("server-signals"));
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { /* best effort */ }
    }
}

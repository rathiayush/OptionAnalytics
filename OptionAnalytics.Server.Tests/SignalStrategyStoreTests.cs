using System.Reflection;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Controllers;
using OptionAnalytics.Server.Services;
using OptionAnalytics.Server.Services.SignalStrategies;

namespace OptionAnalytics.Server.Tests;

/// <summary>SignalStrategyStore - the saved strategies and their live scan's history, all CSV: saved and read back whole
/// (commas, quotes and a formula-looking name kept), each account's own, the live entries / exits kept and sent to Telegram
/// once, the day's report written (and sent) once and replaced when posted again, and who reaches which endpoint.</summary>
public sealed class SignalStrategyStoreTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "oa-sst-" + Guid.NewGuid().ToString("n"));
    private static readonly DateTimeOffset Now = new(2026, 10, 26, 5, 0, 0, TimeSpan.Zero);

    private sealed class FakeHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "Tests";
        public string ContentRootPath { get; set; } = "";
        public IFileProvider ContentRootFileProvider { get; set; } = null!;
    }

    private SignalStrategyStore Store(List<string>? telegrams = null)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Storage:ScannerRunnerPath"] = Path.Combine(_dir, "runner") }).Build();
        var store = new SignalStrategyStore(new ScannerRunnerStore(new FakeHostEnvironment { ContentRootPath = _dir }, config), NullLogger<SignalStrategyStore>.Instance);
        store.NotifyOverride = text => { telegrams?.Add(text); return Task.CompletedTask; };
        return store;
    }

    private static JsonObject Settings(string u = "NIFTY") => new()
    {
        ["underlying"] = u, ["from"] = "2026-10-01", ["to"] = "2026-10-23", ["slPct"] = 30, ["timeframe"] = 5,
        ["rule"] = new JsonObject { ["tree"] = new JsonObject { ["op"] = "or", ["items"] = new JsonArray() }, ["action"] = "buyCE", ["mirror"] = true },
    };

    private static SignalStrategyRequest Request(string name = "VWAP, \"cross\"", bool live = true) => new(name, Settings(), live, true, true);

    [Fact]
    public void A_strategy_is_saved_as_CSV_and_read_back_whole()
    {
        var store = Store();
        var (saved, error) = store.Create("me@x.com", Request(), Now);
        Assert.Null(error);
        Assert.True(saved!.Live && saved.Alerts && saved.DailyReport);
        var csv = File.ReadAllText(Path.Combine(_dir, "runner", "signal-strategies", "strategies.csv"));
        Assert.StartsWith("id,name,owner,underlying,live,alerts,dailyReport,createdUtc,updatedUtc,settings", csv);
        // A fresh store (a restart) reads the same strategy - the name with its comma and quotes, the settings whole.
        var back = Store().Get(saved.Id, "me@x.com")!;
        Assert.Equal("VWAP, \"cross\"", back.Name);
        Assert.Equal("NIFTY", back.Underlying);
        Assert.Equal(5, back.Settings["timeframe"]!.GetValue<int>());
        Assert.Equal("buyCE", back.Settings["rule"]!["action"]!.GetValue<string>());
        // A name that looks like a formula is kept as text in the file and read back as typed.
        var (formula, _) = store.Create("me@x.com", Request("=1+1", live: false), Now);
        Assert.Contains("'=1+1", File.ReadAllText(Path.Combine(_dir, "runner", "signal-strategies", "strategies.csv")));
        Assert.Equal("=1+1", Store().Get(formula!.Id, null)!.Name);
    }

    [Fact]
    public void Changed_only_where_asked_each_account_its_own()
    {
        var store = Store();
        var mine = store.Create("me@x.com", Request("Mine"), Now).Strategy!;
        var theirs = store.Create("them@x.com", Request("Theirs"), Now).Strategy!;
        Assert.Equal(new[] { "Mine" }, store.List("ME@x.com").Select(s => s.Name));
        Assert.Equal(2, store.List(null).Count);
        Assert.Null(store.Get(theirs.Id, "me@x.com"));
        Assert.Null(store.Update(theirs.Id, "me@x.com", new SignalStrategyRequest(Live: false), Now).Strategy);
        Assert.False(store.Delete(theirs.Id, "me@x.com"));
        // Only the switch asked for changes.
        var off = store.Update(mine.Id, "me@x.com", new SignalStrategyRequest(Live: false), Now.AddMinutes(1)).Strategy!;
        Assert.False(off.Live);
        Assert.True(off.Alerts && off.DailyReport);
        Assert.Equal("Mine", off.Name);
        Assert.Equal(Now.AddMinutes(1), off.UpdatedUtc);
        // New settings move it to their index.
        var moved = store.Update(mine.Id, null, new SignalStrategyRequest(Settings: Settings("banknifty")), Now).Strategy!;
        Assert.Equal("BANKNIFTY", moved.Underlying);
        Assert.Equal(new[] { theirs.Id }, store.LiveStrategies().Select(s => s.Id));
    }

    [Fact]
    public void What_is_saved_is_checked()
    {
        var store = Store();
        Assert.Contains("name", store.Create("a", Request(" "), Now).Error);
        Assert.Contains("NIFTY, BANKNIFTY or SENSEX", store.Create("a", new SignalStrategyRequest("x", Settings("FINNIFTY")), Now).Error);
        var noRule = Settings();
        noRule.Remove("rule");
        Assert.Contains("no rule", store.Create("a", new SignalStrategyRequest("x", noRule), Now).Error);
        Assert.Contains("missing", store.Create("a", new SignalStrategyRequest("x", null), Now).Error);
        store.Create("a", Request("Same"), Now);
        Assert.Contains("already called", store.Create("a", Request("same"), Now).Error);
        Assert.NotNull(store.Create("b", Request("Same"), Now).Strategy);          // another account may use the name
        for (var k = store.List("a").Count; k < SignalStrategyStore.MaxStrategiesPerOwner; k++) store.Create("a", Request($"S{k}"), Now);
        Assert.Contains("saved already", store.Create("a", Request("One more"), Now).Error);
    }

    [Fact]
    public async Task Live_entries_and_exits_are_kept_and_sent_once()
    {
        var telegrams = new List<string>();
        var store = Store(telegrams);
        var s = store.Create("me@x.com", Request("S"), Now).Strategy!;
        var events = new List<SignalLiveEvent> { new("2026-10-26|rule|1|entry", "entry", "🟢 S · NIFTY: BUY 25000 CE @ 100.00 (10:01)\nBuy CE: price > VWAP <x>") };
        Assert.Equal(1, await store.RecordEventsAsync(s.Id, "2026-10-26", events, Now));
        Assert.Equal(0, await store.RecordEventsAsync(s.Id, "2026-10-26", events, Now));            // again: nothing new
        Assert.Single(telegrams);
        Assert.Contains("&lt;x&gt;", telegrams[0]);                                                   // HTML-safe
        Assert.Equal(new[] { "2026-10-26|rule|1|entry" }, store.EventKeys(s.Id, "2026-10-26"));
        Assert.Empty(store.EventKeys(s.Id, "2026-10-27"));
        // Alerts off: kept, not sent.
        store.Update(s.Id, null, new SignalStrategyRequest(Alerts: false), Now);
        Assert.Equal(1, await store.RecordEventsAsync(s.Id, "2026-10-26", new List<SignalLiveEvent> { new("2026-10-26|rule|1|exit", "exit", "out") }, Now));
        Assert.Single(telegrams);
        Assert.Equal(2, store.History(s.Id).Events.Count);
    }

    [Fact]
    public async Task The_days_report_is_written_once_and_replaced_when_posted_again()
    {
        var telegrams = new List<string>();
        var store = Store(telegrams);
        var s = store.Create("me@x.com", Request("S"), Now).Strategy!;
        var day = new JsonObject { ["date"] = "2026-10-26", ["underlying"] = "NIFTY", ["trades"] = 2, ["wins"] = 1, ["losses"] = 1, ["winRate"] = 50, ["net"] = -1234.5, ["gross"] = -1100, ["charges"] = 134.5, ["points"] = -17.2, ["signals"] = 3, ["limit"] = "loss" };
        var trades = new JsonArray
        {
            new JsonObject { ["side"] = "rule", ["signal"] = "bullish", ["action"] = "BUY", ["option"] = "25000 CE", ["entryTime"] = "10:01", ["entry"] = 100, ["exitTime"] = "10:31", ["exit"] = 80, ["exitReason"] = "Stop", ["points"] = -20, ["net"] = -1400, ["why"] = "Buy CE: a, b" },
            new JsonObject { ["side"] = "mirror", ["signal"] = "bearish", ["action"] = "BUY", ["option"] = "25000 PE", ["entryTime"] = "11:01", ["entry"] = 90, ["exitTime"] = "11:20", ["exit"] = 92.8, ["exitReason"] = "Target", ["points"] = 2.8, ["net"] = 165.5, ["why"] = "Buy PE" },
        };
        Assert.False(store.Reported(s.Id, "2026-10-26"));
        Assert.True(await store.RecordDayAsync(s.Id, "2026-10-26", day, trades, "📊 S · NIFTY · Mon 26 Oct\nNet −₹1,235", Now));
        Assert.True(store.Reported(s.Id, "2026-10-26"));
        Assert.Single(telegrams);
        // Posted again (a retry): the rows are replaced, not doubled, and Telegram is not sent twice.
        day["net"] = -1000;
        Assert.False(await store.RecordDayAsync(s.Id, "2026-10-26", day, new JsonArray { trades[0]!.DeepClone() }, "again", Now.AddMinutes(1)));
        Assert.Single(telegrams);
        var history = store.History(s.Id);
        var only = Assert.Single(history.Days);
        Assert.Equal("-1000", only["net"]);
        Assert.Equal(Now.ToString("O"), only["reportedUtc"]);                                      // when it was first reported
        Assert.Equal("loss", only["limit"]);                                                     // the day's max loss ended it
        Assert.Single(history.Trades);
        Assert.Equal("Buy CE: a, b", history.Trades[0]["why"]);
        Assert.Equal("-1400", history.Trades[0]["net"]);                                         // a negative number is no formula
        // Another day adds; the newest comes first.
        await store.RecordDayAsync(s.Id, "2026-10-27", new JsonObject { ["trades"] = 0, ["net"] = 0 }, new JsonArray(), "📊 quiet", Now);
        Assert.Equal(new[] { "2026-10-27", "2026-10-26" }, store.History(s.Id).Days.Select(d => d["date"]));
        Assert.StartsWith("date,underlying,trades,wins,losses,winRate,net", File.ReadAllText(store.HistoryPath(s.Id, "days")));
        // Daily report off: kept, not sent.
        store.Update(s.Id, null, new SignalStrategyRequest(DailyReport: false), Now);
        await store.RecordDayAsync(s.Id, "2026-10-28", new JsonObject { ["trades"] = 0 }, new JsonArray(), "📊 off", Now);
        Assert.Equal(2, telegrams.Count);
        // Removing the strategy removes its history.
        Assert.True(store.Delete(s.Id, "me@x.com"));
        Assert.False(File.Exists(store.HistoryPath(s.Id, "days")));
        Assert.Equal(0, await store.RecordEventsAsync(s.Id, "2026-10-29", new List<SignalLiveEvent> { new("k", "entry", "x") }, Now));   // gone: nothing kept
    }

    [Fact]
    public void Only_the_page_accounts_reach_the_strategies_and_only_the_runner_key_the_live_endpoints()
    {
        var methods = typeof(SignalStrategyController).GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly);
        foreach (var m in methods)
        {
            var roles = m.GetCustomAttribute<AuthorizeAttribute>()?.Roles;
            Assert.NotNull(roles);                                                               // every endpoint says who
            var runner = m.Name.StartsWith("Live", StringComparison.Ordinal);
            Assert.Equal(runner ? ScannerRunnerKey.Role : $"{AuthRoles.Admin},{AuthRoles.User}", roles);
        }
        Assert.Null(typeof(SignalStrategyController).GetCustomAttribute<AuthorizeAttribute>());   // no class-wide role that would AND with them
    }

    [Fact]
    public void Csv_cells_round_trip()
    {
        foreach (var v in new[] { "plain", "a, b", "say \"hi\"", "=SUM(A1)", "-12.5", "@x", "line\nbreak" })
        {
            var back = CsvTable.Uncell(Assert.Single(CsvTable.SplitRow(CsvTable.Cell(v))));
            Assert.Equal(v.Replace('\n', ' '), back);
        }
        Assert.Equal("'=SUM(A1)", CsvTable.SplitRow(CsvTable.Cell("=SUM(A1)"))[0]);
        Assert.Equal("-12.5", CsvTable.Cell("-12.5"));
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { /* best effort */ }
    }
}

using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>The live list (LiveListService): only strategies proven on an index - enough tuning trades, positive R after
/// costs, the win rate met, and not losing in the live record once it is long enough - trade live; by hand wins.</summary>
public sealed class LiveListServiceTests
{
    private static readonly TradeSettings Nifty = new("NIFTY", 1, 20, 30, 0, 0, 1, true, "sell", null);

    // n trades of one strategy on NIFTY, "as written", each the sold option making `pts` premium points on a 20-point SL.
    private static IEnumerable<Dictionary<string, string>> Trades(string id, int n, Func<int, double> pts) =>
        Enumerable.Range(0, n).Select(i => new Dictionary<string, string>
        {
            ["index"] = "NIFTY", ["strategy_id"] = id, ["strategy_no"] = "1", ["strategy"] = id, ["setting"] = "as written",
            ["date"] = $"2026-09-{1 + i % 28:00}", ["entry_time_ist"] = $"2026-09-{1 + i % 28:00} 10:{i % 60:00}:00", ["points"] = "10",
            ["sold_points"] = pts(i).ToString(System.Globalization.CultureInfo.InvariantCulture), ["sold_sl"] = "20", ["sold_target"] = "30",
        });

    private static List<TuningPerformance.Row> Perf(params IEnumerable<Dictionary<string, string>>[] trades)
    {
        var runs = new List<Dictionary<string, string>> { new() { ["run_id"] = "NIFTY-futures-20261010-100000", ["index"] = "NIFTY", ["data"] = "futures" } };
        var rows = trades.SelectMany(t => t).ToList();
        return TuningPerformance.Build(runs, (id, kind) => kind == "trades" ? rows : null).Rows;
    }

    private static LiveListEntry E(List<LiveListEntry> list, string id) => list.Single(e => e.StrategyId == id);

    [Fact]
    public void OnlyProvenStrategies_AfterCosts_AreOnTheList_BestFirst()
    {
        var perf = Perf(
            Trades("good", 30, i => i % 10 < 6 ? 30 : -20),     // 60% wins, +10 pts a trade gross
            Trades("thin", 30, i => i % 10 < 6 ? 6 : -4),       // +2 pts a trade gross: costs (2 x 1 + 1 = 3 pts) turn it negative
            Trades("few", 8, _ => 30),                          // great, but only 8 trades
            Trades("lowWin", 30, i => i % 10 < 3 ? 60 : -10));  // positive R but a 30% win rate
        var list = LiveListService.Compute("NIFTY", perf, new List<Dictionary<string, string>>(), Nifty, new LiveListService.State());
        Assert.True(E(list, "good").OnList);
        Assert.Equal(3, E(list, "good").CostPoints); // 2 x slippage 1 + charges 1
        Assert.True(E(list, "good").AvgR > 0);
        Assert.False(E(list, "thin").OnList);
        Assert.Contains("after costs", E(list, "thin").Why);
        Assert.False(E(list, "few").OnList);
        Assert.Contains("needs 20", E(list, "few").Why);
        Assert.False(E(list, "lowWin").OnList);
        Assert.Contains("win rate", E(list, "lowWin").Why);
        Assert.Equal("good", list[0].StrategyId); // on the list first
    }

    [Fact]
    public void TheLiveRecord_TakesALosingStrategyOff_OnceItIsLongEnough()
    {
        var perf = Perf(Trades("good", 30, i => i % 10 < 6 ? 30 : -20));
        Dictionary<string, string> T(int i, double net) => new() { ["underlying"] = "NIFTY", ["strategy_id"] = "good", ["exit_time_ist"] = "2026-10-05 11:00:00", ["net_per_lot"] = net.ToString(System.Globalization.CultureInfo.InvariantCulture) };
        var few = Enumerable.Range(0, 5).Select(i => T(i, -500)).ToList();
        Assert.True(E(LiveListService.Compute("NIFTY", perf, few, Nifty, new LiveListService.State()), "good").OnList); // 5 live trades: not enough to decide
        var many = Enumerable.Range(0, 12).Select(i => T(i, i < 4 ? 800 : -500)).ToList();
        var e = E(LiveListService.Compute("NIFTY", perf, many, Nifty, new LiveListService.State()), "good");
        Assert.False(e.OnList);
        Assert.Contains("losing in the live record", e.Why);
        Assert.Equal((12, 33.3), (e.LiveTrades, e.LiveWinPct!.Value));
        // Another index's live record does not count here.
        var other = many.Select(t => new Dictionary<string, string>(t) { ["underlying"] = "BANKNIFTY" }).ToList();
        Assert.True(E(LiveListService.Compute("NIFTY", perf, other, Nifty, new LiveListService.State()), "good").OnList);
    }

    [Fact]
    public void ByHand_IncludeAndExclude_WinOverTheRules_AndTheBoughtOptionIsMeasuredForABuyingIndex()
    {
        var perf = Perf(Trades("few", 8, _ => 30), Trades("good", 30, i => i % 10 < 6 ? 30 : -20));
        var state = new LiveListService.State();
        state.Include.Add("NIFTY|few");
        state.Exclude.Add("NIFTY|good");
        var list = LiveListService.Compute("NIFTY", perf, new List<Dictionary<string, string>>(), Nifty, state);
        Assert.True(E(list, "few").OnList && E(list, "few").ForcedIn);
        Assert.False(E(list, "good").OnList);
        Assert.Equal("taken off by hand", E(list, "good").Why);
        // An index that BUYS options is measured on the bought leg (none here -> no record at all).
        Assert.Empty(LiveListService.Compute("NIFTY", perf, new List<Dictionary<string, string>>(), Nifty with { AutoTrade = "buy" }, new LiveListService.State()));
    }

    [Fact]
    public void RulesAndByHandChanges_AreValidatedAndKept()
    {
        var path = Path.Combine(Path.GetTempPath(), "oa-live-list-" + Guid.NewGuid().ToString("n") + ".json");
        try
        {
            var dir = Path.GetDirectoryName(path)!;
            var trade = new TradeSettingsStore(new FakeEnv(dir), new Microsoft.Extensions.Configuration.ConfigurationBuilder().Build(), NullLogger<TradeSettingsStore>.Instance);
            var svc = new LiveListService(null, null, trade, path, NullLogger<LiveListService>.Instance);
            Assert.NotNull(svc.Set(new LiveListRules(MinTrades: 0), null, null, null));
            Assert.Null(svc.Set(new LiveListRules(30, 50, 2, 15), "NIFTY", "trap", "include"));
            var again = new LiveListService(null, null, trade, path, NullLogger<LiveListService>.Instance);
            Assert.Equal(30, again.Rules().MinTrades);
            Assert.NotNull(again.BlockReason("NIFTY", "unknownStrategy"));
        }
        finally { try { File.Delete(path); } catch { /* temp */ } }
    }

    private sealed class FakeEnv(string root) : Microsoft.Extensions.Hosting.IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "Tests";
        public string ContentRootPath { get; set; } = root;
        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } = null!;
    }
}

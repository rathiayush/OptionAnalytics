using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>TradeSettingsStore - lots, SL / target / trail, slippage and the server scanner per index in one CSV,
/// created with the defaults when it is missing or broken.</summary>
public sealed class TradeSettingsStoreTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "oa-trade-settings-" + Guid.NewGuid().ToString("n"));
    private string FilePath => Path.Combine(_dir, "trade-settings.csv");

    private sealed class FakeHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "Tests";
        public string ContentRootPath { get; set; } = "";
        public IFileProvider ContentRootFileProvider { get; set; } = null!;
    }

    private TradeSettingsStore Store() => new(new FakeHostEnvironment { ContentRootPath = _dir },
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Storage:TradeSettingsPath"] = FilePath }).Build(),
        NullLogger<TradeSettingsStore>.Instance);

    [Fact]
    public void AMissingFile_IsCreatedWithEachIndexsDefaults()
    {
        var all = Store().All();
        Assert.Equal(new[] { "NIFTY", "BANKNIFTY", "SENSEX" }, all.Select(s => s.Underlying));
        // The trader's own settings: lots, manual SL / target, no trail, the strategies' Max SL and no max target, 2 pts slippage.
        Assert.Equal(new[] { (4, 30m, 40m, 50m, 0m), (3, 50m, 75m, 80m, 0m), (3, 60m, 90m, 120m, 0m) },
            all.Select(s => (s.Lots, s.SlPoints, s.TargetPoints, s.MaxSl, s.MaxTarget)));
        Assert.True(all.All(s => s.ScannerEnabled && s.AutoTrade == "sell" && s.TrailStart == 0 && s.TrailGap == 0 && s.SlippagePoints == 2));
        Assert.True(File.Exists(FilePath));
        Assert.StartsWith("underlying,lots,sl_points", File.ReadAllText(FilePath));
    }

    [Fact]
    public void SavedSettings_AreKept_AndTheFileIsRecreatedIfDeletedOrBroken()
    {
        var store = Store();
        var (saved, error) = store.Save("banknifty", store.Get("BANKNIFTY") with { Lots = 3, SlPoints = 40, SlippagePoints = 1.5m, ScannerEnabled = false, AutoTrade = "OFF" });
        Assert.Null(error);
        Assert.Equal("off", saved!.AutoTrade);
        var again = Store().Get("BANKNIFTY");
        Assert.Equal(3, again.Lots);
        Assert.Equal(40, again.SlPoints);
        Assert.Equal(1.5m, again.SlippagePoints);
        Assert.False(again.ScannerEnabled);
        Assert.Equal(30, Store().Get("NIFTY").SlPoints);

        File.Delete(FilePath);
        Assert.Equal(3, Store().Get("BANKNIFTY").Lots); // the default again
        Assert.True(File.Exists(FilePath));
        File.WriteAllText(FilePath, "garbage\nnot,a,row\n");
        Assert.Equal(3, Store().All().Count);
    }

    [Fact]
    public void NonsenseIsRefused()
    {
        var store = Store();
        Assert.NotNull(store.Save("FINNIFTY", store.Get("NIFTY")).Error);
        Assert.NotNull(store.Save("NIFTY", store.Get("NIFTY") with { Lots = 0 }).Error);
        Assert.NotNull(store.Save("NIFTY", store.Get("NIFTY") with { SlPoints = -1 }).Error);
        Assert.NotNull(store.Save("NIFTY", store.Get("NIFTY") with { AutoTrade = "short" }).Error);
    }

    [Fact]
    public void TheMaxRules_ForTheStrategies_AreKept_AndAFileFromBeforeThemStartsWithItsSlAndTarget()
    {
        // A file from before the max rules: each index's max = its SL / target.
        Directory.CreateDirectory(_dir);
        File.WriteAllText(FilePath, "underlying,lots,sl_points,target_points,trail_start,trail_gap,slippage_points,scanner_enabled,auto_trade,updated_utc\n" +
            "NIFTY,2,25,40,0,0,2,true,sell,\nBANKNIFTY,1,50,75,0,0,2,true,sell,\nSENSEX,1,60,90,0,0,2,true,sell,\n");
        var store = Store();
        var nifty = store.Get("NIFTY");
        Assert.Equal((25m, 40m), (nifty.MaxSl, nifty.MaxTarget));

        // Saved: kept apart from the manual SL / target; 0 = no max.
        Assert.Null(store.Save("NIFTY", nifty with { MaxSlPoints = 60, MaxTargetPoints = 0 }).Error);
        var again = Store().Get("NIFTY");
        Assert.Equal((60m, 0m, 25m, 40m), (again.MaxSl, again.MaxTarget, again.SlPoints, again.TargetPoints));
        Assert.Contains("max_sl_points,max_target_points", File.ReadAllText(FilePath));
        // A request without them (an older page) keeps them.
        Assert.Null(store.Save("NIFTY", again with { MaxSlPoints = null, MaxTargetPoints = null, Lots = 3 }).Error);
        Assert.Equal((60m, 0m), (Store().Get("NIFTY").MaxSl, Store().Get("NIFTY").MaxTarget));
        Assert.NotNull(store.Save("NIFTY", again with { MaxSlPoints = -5 }).Error);
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, true); } catch { /* best effort */ }
    }
}

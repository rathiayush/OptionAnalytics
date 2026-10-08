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
        Assert.Equal(20, all[0].SlPoints);
        Assert.Equal(75, all[1].TargetPoints);
        Assert.True(all.All(s => s.ScannerEnabled && s.AutoTrade == "sell" && s.Lots == 1));
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
        Assert.Equal(20, Store().Get("NIFTY").SlPoints);

        File.Delete(FilePath);
        Assert.Equal(1, Store().Get("BANKNIFTY").Lots);
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

    public void Dispose()
    {
        try { Directory.Delete(_dir, true); } catch { /* best effort */ }
    }
}

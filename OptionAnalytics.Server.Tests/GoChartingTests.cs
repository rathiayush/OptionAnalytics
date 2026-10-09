using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>GoChartingStore - GoCharting's per-bar order flow posted by its Lipi alert webhook.</summary>
public sealed class GoChartingTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "oa-gc-" + Guid.NewGuid().ToString("n"));
    // 10:31:00.4 IST on 9 Oct 2026; the bar that just finished started 10:30.
    private static readonly DateTimeOffset Now = new(2026, 10, 9, 5, 1, 0, 400, TimeSpan.Zero);
    private static readonly long Bar1030 = new DateTimeOffset(2026, 10, 9, 5, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds();

    private sealed class FakeHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "Tests";
        public string ContentRootPath { get; set; } = "";
        public IFileProvider ContentRootFileProvider { get; set; } = null!;
    }

    private GoChartingStore Store(string? token = null, string? sdkKey = null) => new(new FakeHostEnvironment { ContentRootPath = _dir },
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Storage:GoChartingPath"] = _dir, ["GoCharting:WebhookToken"] = token, ["GoCharting:SdkLicenseKey"] = sdkKey }).Build(),
        NullLogger<GoChartingStore>.Instance);

    [Fact]
    public void TheSdkLicenseKey_IsSavedOnce_ConfigWins_AndBadKeysAreRefused()
    {
        var store = Store();
        Assert.Null(store.SdkLicenseKey);
        Assert.NotNull(store.SaveSdkLicenseKey("bad key with spaces"));
        Assert.NotNull(store.SaveSdkLicenseKey("short"));
        Assert.Null(store.SaveSdkLicenseKey(" abcd1234-ef56-7890 "));
        Assert.Equal("abcd1234-ef56-7890", Store().SdkLicenseKey);
        Assert.False(store.SdkLicenseKeyFromConfig);
        Assert.Equal("cfg-key-12345678", Store(sdkKey: "cfg-key-12345678").SdkLicenseKey);
        Assert.True(Store(sdkKey: "cfg-key-12345678").SdkLicenseKeyFromConfig);
        Assert.Null(store.SaveSdkLicenseKey(""));
        Assert.Null(Store().SdkLicenseKey);
        Assert.Equal("https://gocharting.com/sdk/library/abcd1234-ef56/index.umd.js", GoChartingStore.SdkScriptUrl("abcd1234-ef56"));
    }

    [Fact]
    public void TheScriptsMessage_IsParsed()
    {
        var (bar, error) = GoChartingStore.Parse($"OA1 sym=NIFTY t={Bar1030} o=25010.5 h=25020 l=25005 c=25018 v=19500 bv=11700 sv=7800 d=3900 dmax=4200 dmin=-300 n=410 cvd=-12350", Now);
        Assert.Null(error);
        Assert.Equal("NIFTY", bar!.Underlying);
        Assert.Equal(Bar1030, bar.Time);
        Assert.Equal(11700, bar.BuyVolume);
        Assert.Equal(7800, bar.SellVolume);
        Assert.Equal(3900, bar.Delta);
        Assert.Equal(-12350, bar.Cvd);
        Assert.Equal(25018, bar.Close);
    }

    [Theory]
    [InlineData("BANKNIFTY", "BANKNIFTY")]
    [InlineData("NIFTYBANK", "BANKNIFTY")]
    [InlineData("SENSEX", "SENSEX")]
    [InlineData("NIFTY26OCTFUT", "NIFTY")]
    public void TheIndex_IsReadFromSym(string sym, string expected) =>
        Assert.Equal(expected, GoChartingStore.Parse($"sym={sym} t={Bar1030} d=10", Now).Bar?.Underlying);

    [Fact]
    public void JsonSecondsAndScientificTimes_AreAccepted_AndDeltaComesFromBuyMinusSell()
    {
        var json = GoChartingStore.Parse($$"""{"sym":"NIFTY","t":{{Bar1030 / 1000}},"bv":500,"sv":200}""", Now).Bar;
        Assert.Equal(Bar1030, json!.Time);
        Assert.Equal(300, json.Delta);
        var sci = GoChartingStore.Parse($"sym=NIFTY t={Bar1030 / 1000.0:0.######}e3 d=5", Now).Bar;
        Assert.Equal(Bar1030, sci!.Time);
    }

    [Fact]
    public void WithoutATime_TheBarIsTheMinuteBeforeTheMessage()
    {
        Assert.Equal(Bar1030, GoChartingStore.Parse("sym=NIFTY d=5", Now).Bar!.Time);
    }

    [Theory]
    [InlineData("")]
    [InlineData("sym=FINNIFTYX d=5 t=1")]
    [InlineData("sym=NIFTY")]
    [InlineData("hello")]
    public void Garbage_IsRejectedWithAReason(string body) => Assert.NotNull(GoChartingStore.Parse(body, Now).Error);

    [Fact]
    public void ABarFarFromNow_IsRejected() =>
        Assert.NotNull(GoChartingStore.Parse($"sym=NIFTY t={Bar1030 - 10L * 86_400_000} d=5", Now).Error);

    [Fact]
    public void ReceivedBars_AreKeptPerIndexAndDay_OnDisk_AndAResentBarReplacesItself()
    {
        var store = Store("0123456789abcdef0123");
        store.Receive($"sym=NIFTY t={Bar1030} d=10 cvd=10", Now);
        store.Receive($"sym=NIFTY t={Bar1030 + 60_000} d=-4 cvd=6", Now.AddMinutes(1));
        store.Receive($"sym=NIFTY t={Bar1030} d=12 cvd=12", Now.AddMinutes(1));
        store.Receive($"sym=SENSEX t={Bar1030} d=1", Now);
        var day = new DateOnly(2026, 10, 9);
        var fresh = Store("0123456789abcdef0123");
        var bars = fresh.Day("NIFTY", day);
        Assert.Equal(2, bars.Count);
        Assert.Equal(12, bars[0].Delta);
        Assert.Equal(-4, bars[1].Delta);
        Assert.Single(fresh.Day("SENSEX", day));
        Assert.Empty(fresh.Day("BANKNIFTY", day));
    }

    [Fact]
    public void TheWebhookToken_IsGeneratedOnce_AndChecked()
    {
        var a = Store();
        Assert.True(a.Token.Length >= 16);
        Assert.Equal(a.Token, Store().Token);
        Assert.True(a.TokenMatches(a.Token));
        Assert.False(a.TokenMatches("nope"));
        Assert.False(a.TokenMatches(null));
    }

    [Fact]
    public void TheLipiScript_SendsTheFinishedBarsValues()
    {
        var script = GoChartingStore.LipiScript("BANKNIFTY");
        Assert.Contains("\"BANKNIFTY\"", script);
        Assert.Contains("barstate.isnew", script);
        foreach (var key in new[] { "t=", "bv=", "sv=", "d=", "cvd=" }) Assert.Contains(key, script);
        Assert.Contains("orderflow.buyvolume[1]", script);
        Assert.Contains("alert(msg)", script);
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, true); } catch { /* temp */ }
    }
}

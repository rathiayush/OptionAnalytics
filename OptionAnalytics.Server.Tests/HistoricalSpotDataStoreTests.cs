using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers HistoricalSpotDataStore's own on-disk contract in isolation, against a scratch
/// temp directory per test - no Dhan/network dependency, since this class is pure file I/O.</summary>
public sealed class HistoricalSpotDataStoreTests : IDisposable
{
    private readonly string _tempDirectory = Path.Combine(Path.GetTempPath(), "oa-historical-tests-" + Guid.NewGuid().ToString("n"));

    // A minimal IHostEnvironment stub - ContentRootPath is what a relative (or absent)
    // Storage:HistoricalDataPath resolves against (see ResolvesARelativeOrAbsentConfiguredPath...
    // below); every other test here configures an absolute path directly, so ContentRootPath is
    // otherwise unused.
    private sealed class FakeHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "OptionAnalytics.Server.Tests";
        public string ContentRootPath { get; set; } = "";
        public IFileProvider ContentRootFileProvider { get; set; } = null!;
    }

    private HistoricalSpotDataStore CreateStore()
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Storage:HistoricalDataPath"] = _tempDirectory })
            .Build();
        var environment = new FakeHostEnvironment { ContentRootPath = _tempDirectory };
        return new HistoricalSpotDataStore(environment, configuration, NullLogger<HistoricalSpotDataStore>.Instance);
    }

    private static CandleWithVolume Bar(DateOnly day, int minute, decimal close) =>
        new(IstClock.AtIstTime(day, 9 * 60 + 15 + minute), close, close, close, close, 1000 + minute);

    [Fact]
    public void HasCompleteData_IsFalse_WhenNothingHasEverBeenSaved()
    {
        var store = CreateStore();

        Assert.False(store.HasCompleteData("NIFTY", new DateOnly(2026, 1, 1), new DateOnly(2026, 1, 31)));
    }

    [Fact]
    public async Task SaveThenHasCompleteData_IsTrueOnlyWithinTheSavedWindow()
    {
        var store = CreateStore();
        var from = new DateOnly(2026, 1, 1);
        var to = new DateOnly(2026, 1, 31);
        var bars = new[] { Bar(from, 0, 100), Bar(to, 0, 105) };

        await store.SaveAsync("NIFTY", from, to, bars, CancellationToken.None);

        Assert.True(store.HasCompleteData("NIFTY", from, to));
        Assert.True(store.HasCompleteData("NIFTY", from.AddDays(5), to.AddDays(-5))); // a narrower sub-window
        Assert.False(store.HasCompleteData("NIFTY", from.AddDays(-1), to)); // reaches earlier than what was saved
        Assert.False(store.HasCompleteData("NIFTY", from, to.AddDays(1))); // reaches later than what was saved
        Assert.False(store.HasCompleteData("BANKNIFTY", from, to)); // a different underlying's cache is untouched
    }

    [Fact]
    public async Task Read_OnlyReturnsRowsWithinTheRequestedWindow_InTimeAscendingOrder()
    {
        var store = CreateStore();
        var day1 = new DateOnly(2026, 1, 5);
        var day2 = new DateOnly(2026, 1, 6);
        var day3 = new DateOnly(2026, 1, 7);
        var bars = new[] { Bar(day1, 0, 100), Bar(day2, 0, 110), Bar(day3, 0, 120) };

        await store.SaveAsync("NIFTY", day1, day3, bars, CancellationToken.None);

        var read = store.Read("NIFTY", day2, day2);

        var only = Assert.Single(read);
        Assert.Equal(110, only.Close);
    }

    [Fact]
    public void Read_ReturnsEmpty_ForAnUnderlyingThatWasNeverSaved()
    {
        var store = CreateStore();

        Assert.Empty(store.Read("BANKNIFTY", new DateOnly(2026, 1, 1), new DateOnly(2026, 1, 31)));
    }

    [Fact]
    public void ResolvesARelativeOrAbsentConfiguredPath_AgainstContentRootPath()
    {
        // appsettings.json's own default ("historical-data") is deliberately relative - this is what
        // makes both "nothing configured at all" and "the plain appsettings.json default" land next
        // to the app locally, exactly like every other Storage:* path, while docker-compose.yml's own
        // absolute /app/data/... override still wins outright (covered by CreateStore's own absolute
        // path in every other test above).
        var configuration = new ConfigurationBuilder().Build(); // no Storage:HistoricalDataPath at all
        var environment = new FakeHostEnvironment { ContentRootPath = _tempDirectory };
        _ = new HistoricalSpotDataStore(environment, configuration, NullLogger<HistoricalSpotDataStore>.Instance);

        Assert.True(Directory.Exists(Path.Combine(_tempDirectory, "historical-data")));
    }

    public void Dispose()
    {
        if (Directory.Exists(_tempDirectory)) Directory.Delete(_tempDirectory, recursive: true);
    }
}

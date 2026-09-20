using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers OpenInterestSnapshotStore's own on-disk contract in isolation, against a scratch
/// temp directory per test - same shape as HistoricalSpotDataStoreTests, since both are pure file
/// I/O with no Dhan/network dependency.</summary>
public sealed class OpenInterestSnapshotStoreTests : IDisposable
{
    private readonly string _tempDirectory = Path.Combine(Path.GetTempPath(), "oa-oi-tests-" + Guid.NewGuid().ToString("n"));

    private sealed class FakeHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "OptionAnalytics.Server.Tests";
        public string ContentRootPath { get; set; } = "";
        public IFileProvider ContentRootFileProvider { get; set; } = null!;
    }

    private OpenInterestSnapshotStore CreateStore()
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Storage:OpenInterestPath"] = _tempDirectory })
            .Build();
        var environment = new FakeHostEnvironment { ContentRootPath = _tempDirectory };
        return new OpenInterestSnapshotStore(environment, configuration, NullLogger<OpenInterestSnapshotStore>.Instance);
    }

    private static readonly DateOnly Expiry = new(2026, 1, 29);
    private static readonly DateOnly Day = new(2026, 1, 5);

    [Fact]
    public void HasBaseline_IsFalse_WhenNothingHasEverBeenSaved()
    {
        var store = CreateStore();

        Assert.False(store.HasBaseline("NIFTY", Expiry, Day));
    }

    [Fact]
    public void Load_ReturnsNull_WhenNothingHasEverBeenSaved()
    {
        var store = CreateStore();

        Assert.Null(store.Load("NIFTY", Expiry, Day));
    }

    [Fact]
    public async Task SaveThenLoad_RoundTripsEveryField_IncludingNulls()
    {
        var store = CreateStore();
        var capturedAt = new DateTimeOffset(2026, 1, 5, 3, 50, 0, TimeSpan.Zero);
        var baseline = new Dictionary<decimal, OiStrikeSnapshot>
        {
            [24000] = new(1_000_000, 120.5m, 800_000, 95.25m),
            [24050] = new(null, null, 500_000, 80m), // a strike Dhan only partially quoted
        };

        await store.SaveAsync("NIFTY", Expiry, Day, capturedAt, baseline, CancellationToken.None);

        Assert.True(store.HasBaseline("NIFTY", Expiry, Day));
        var loaded = store.Load("NIFTY", Expiry, Day);
        Assert.NotNull(loaded);
        Assert.Equal(capturedAt, loaded.Value.CapturedAtUtc);
        Assert.Equal(2, loaded.Value.Baseline.Count);
        Assert.Equal(new OiStrikeSnapshot(1_000_000, 120.5m, 800_000, 95.25m), loaded.Value.Baseline[24000]);
        Assert.Equal(new OiStrikeSnapshot(null, null, 500_000, 80m), loaded.Value.Baseline[24050]);
    }

    [Fact]
    public async Task SaveIsScopedPerUnderlyingExpiryAndDay()
    {
        var store = CreateStore();
        var baseline = new Dictionary<decimal, OiStrikeSnapshot> { [24000] = new(1000, 100m, 900, 90m) };

        await store.SaveAsync("NIFTY", Expiry, Day, DateTimeOffset.UtcNow, baseline, CancellationToken.None);

        Assert.False(store.HasBaseline("BANKNIFTY", Expiry, Day)); // different underlying
        Assert.False(store.HasBaseline("NIFTY", Expiry.AddDays(7), Day)); // different expiry
        Assert.False(store.HasBaseline("NIFTY", Expiry, Day.AddDays(1))); // different day
    }

    public void Dispose()
    {
        if (Directory.Exists(_tempDirectory)) Directory.Delete(_tempDirectory, recursive: true);
    }
}

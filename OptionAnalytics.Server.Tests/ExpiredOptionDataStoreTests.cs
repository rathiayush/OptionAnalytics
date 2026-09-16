using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers ExpiredOptionDataStore's own on-disk contract in isolation, against a scratch
/// temp directory per test - no Dhan/network dependency, since this class is pure file I/O.</summary>
public sealed class ExpiredOptionDataStoreTests : IDisposable
{
    private readonly string _tempDirectory = Path.Combine(Path.GetTempPath(), "oa-expired-option-tests-" + Guid.NewGuid().ToString("n"));

    private sealed class FakeHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "OptionAnalytics.Server.Tests";
        public string ContentRootPath { get; set; } = "";
        public IFileProvider ContentRootFileProvider { get; set; } = null!;
    }

    private ExpiredOptionDataStore CreateStore()
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Storage:ExpiredOptionDataPath"] = _tempDirectory })
            .Build();
        var environment = new FakeHostEnvironment { ContentRootPath = _tempDirectory };
        return new ExpiredOptionDataStore(environment, configuration, NullLogger<ExpiredOptionDataStore>.Instance);
    }

    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero);

    private static (CandleWithVolume Bar, decimal? Strike, decimal? Spot) Bar(int minute, decimal close, decimal strike) =>
        (new CandleWithVolume(T0.AddMinutes(minute), close, close, close, close, 1000 + minute), strike, null);

    private static (string StrikeToken, string OptionType, IReadOnlyList<(CandleWithVolume, decimal?, decimal?)> Bars) Member(
        string token, string optionType, params (CandleWithVolume, decimal?, decimal?)[] bars) => (token, optionType, bars);

    [Fact]
    public void HasContract_IsFalse_WhenNothingHasEverBeenSaved()
    {
        var store = CreateStore();

        Assert.False(store.HasContract("NIFTY", "WEEK", new DateOnly(2026, 1, 6)));
    }

    [Fact]
    public async Task SaveThenHasContract_IsTrueForThatExactContractOnly()
    {
        var store = CreateStore();
        var expiry = new DateOnly(2026, 1, 6);
        var members = new[] { Member("ATM", "CALL", Bar(0, 100, 24000)) };

        await store.SaveAsync("NIFTY", "WEEK", expiry, expiry.AddDays(-6), expiry, members, CancellationToken.None);

        Assert.True(store.HasContract("NIFTY", "WEEK", expiry));
        Assert.False(store.HasContract("NIFTY", "MONTH", expiry)); // different cadence, same date - not the same cache entry
        Assert.False(store.HasContract("BANKNIFTY", "WEEK", expiry)); // different underlying
        Assert.False(store.HasContract("NIFTY", "WEEK", expiry.AddDays(7))); // different expiry
    }

    [Fact]
    public async Task Read_OnlyReturnsRowsMatchingTheRequestedTokenAndSide_ClippedToTheWindow()
    {
        var store = CreateStore();
        var expiry = new DateOnly(2026, 1, 6);
        var fromDay = expiry.AddDays(-6);
        var members = new[]
        {
            Member("ATM", "CALL", Bar(0, 100, 24000), Bar(1, 101, 24000)),
            Member("ATM+1", "CALL", Bar(0, 50, 24050)),
            Member("ATM", "PUT", Bar(0, 60, 24000)),
        };

        await store.SaveAsync("NIFTY", "WEEK", expiry, fromDay, expiry, members, CancellationToken.None);

        var atmCalls = store.Read("NIFTY", "WEEK", expiry, "ATM", "CALL", fromDay, expiry);
        Assert.Equal(2, atmCalls.Count);
        Assert.All(atmCalls, b => Assert.Equal(24000, b.Strike));

        var atmPlus1Calls = store.Read("NIFTY", "WEEK", expiry, "ATM+1", "CALL", fromDay, expiry);
        var only = Assert.Single(atmPlus1Calls);
        Assert.Equal(50, only.Bar.Close);

        var atmPuts = store.Read("NIFTY", "WEEK", expiry, "ATM", "PUT", fromDay, expiry);
        Assert.Single(atmPuts);
    }

    [Fact]
    public async Task Read_ClipsToTheRequestedDayWindow()
    {
        var store = CreateStore();
        var expiry = new DateOnly(2026, 1, 6);
        var day1 = expiry.AddDays(-1);
        var members = new[]
        {
            Member("ATM", "CALL",
                (new CandleWithVolume(IstClock.AtIstTime(day1, 600), 100, 100, 100, 100, 1), (decimal?)24000, null),
                (new CandleWithVolume(IstClock.AtIstTime(expiry, 600), 110, 110, 110, 110, 1), (decimal?)24100, null)),
        };

        await store.SaveAsync("NIFTY", "WEEK", expiry, day1, expiry, members, CancellationToken.None);

        var onlyDay1 = store.Read("NIFTY", "WEEK", expiry, "ATM", "CALL", day1, day1);
        var only = Assert.Single(onlyDay1);
        Assert.Equal(100, only.Bar.Close);
    }

    [Fact]
    public void Read_ReturnsEmpty_ForAContractThatWasNeverSaved()
    {
        var store = CreateStore();

        Assert.Empty(store.Read("NIFTY", "WEEK", new DateOnly(2026, 1, 6), "ATM", "CALL", new DateOnly(2026, 1, 1), new DateOnly(2026, 1, 6)));
    }

    public void Dispose()
    {
        if (Directory.Exists(_tempDirectory)) Directory.Delete(_tempDirectory, recursive: true);
    }
}

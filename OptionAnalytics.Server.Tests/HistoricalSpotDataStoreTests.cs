using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers HistoricalSpotDataStore's own Postgres contract in isolation - no Dhan/network
/// dependency, since this class is pure data access. Requires a reachable Postgres (see
/// PostgresTestConfig); every test uses its own randomly-suffixed underlying so tests can run
/// concurrently against the same shared database without their rows colliding - the same isolation
/// the old CSV tests got for free from a scratch temp directory per test.</summary>
public sealed class HistoricalSpotDataStoreTests
{
    private static HistoricalSpotDataStore CreateStore() =>
        new(Options.Create(PostgresTestConfig.Load()), NullLogger<HistoricalSpotDataStore>.Instance);

    private static string UniqueUnderlying(string prefix) => $"{prefix}-{Guid.NewGuid():N}";

    private static CandleWithVolume Bar(DateOnly day, int minute, decimal close) =>
        new(IstClock.AtIstTime(day, 9 * 60 + 15 + minute), close, close, close, close, 1000 + minute);

    [Fact]
    public void HasCompleteData_IsFalse_WhenNothingHasEverBeenSaved()
    {
        var store = CreateStore();

        Assert.False(store.HasCompleteData(UniqueUnderlying("NIFTY"), new DateOnly(2026, 1, 1), new DateOnly(2026, 1, 31)));
    }

    [Fact]
    public async Task SaveThenHasCompleteData_IsTrueOnlyWithinTheSavedWindow()
    {
        var store = CreateStore();
        var underlying = UniqueUnderlying("NIFTY");
        var from = new DateOnly(2026, 1, 1);
        var to = new DateOnly(2026, 1, 31);
        var bars = new[] { Bar(from, 0, 100), Bar(to, 0, 105) };

        await store.SaveAsync(underlying, from, to, bars, CancellationToken.None);

        Assert.True(store.HasCompleteData(underlying, from, to));
        Assert.True(store.HasCompleteData(underlying, from.AddDays(5), to.AddDays(-5))); // a narrower sub-window
        Assert.False(store.HasCompleteData(underlying, from.AddDays(-1), to)); // reaches earlier than what was saved
        Assert.False(store.HasCompleteData(underlying, from, to.AddDays(1))); // reaches later than what was saved
        Assert.False(store.HasCompleteData(UniqueUnderlying("BANKNIFTY"), from, to)); // a different underlying's cache is untouched
    }

    [Fact]
    public async Task Read_OnlyReturnsRowsWithinTheRequestedWindow_InTimeAscendingOrder()
    {
        var store = CreateStore();
        var underlying = UniqueUnderlying("NIFTY");
        var day1 = new DateOnly(2026, 1, 5);
        var day2 = new DateOnly(2026, 1, 6);
        var day3 = new DateOnly(2026, 1, 7);
        var bars = new[] { Bar(day1, 0, 100), Bar(day2, 0, 110), Bar(day3, 0, 120) };

        await store.SaveAsync(underlying, day1, day3, bars, CancellationToken.None);

        var read = store.Read(underlying, day2, day2);

        var only = Assert.Single(read);
        Assert.Equal(110, only.Close);
    }

    [Fact]
    public void Read_ReturnsEmpty_ForAnUnderlyingThatWasNeverSaved()
    {
        var store = CreateStore();

        Assert.Empty(store.Read(UniqueUnderlying("BANKNIFTY"), new DateOnly(2026, 1, 1), new DateOnly(2026, 1, 31)));
    }

    [Fact]
    public async Task SaveAsync_OverwritesAPreviouslySavedUnderlying_RatherThanAppending()
    {
        var store = CreateStore();
        var underlying = UniqueUnderlying("NIFTY");
        var day = new DateOnly(2026, 1, 5);

        await store.SaveAsync(underlying, day, day, new[] { Bar(day, 0, 100) }, CancellationToken.None);
        await store.SaveAsync(underlying, day, day, new[] { Bar(day, 0, 200) }, CancellationToken.None);

        var rows = store.Read(underlying, day, day);
        var only = Assert.Single(rows);
        Assert.Equal(200, only.Close);
    }
}

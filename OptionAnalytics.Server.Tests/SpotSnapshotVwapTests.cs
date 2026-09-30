using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>ToSnapshot runs on every spot tick, so it only feeds the current session's bars to
/// VwapCalculator - these pin that the shortcut never changes the VWAP it reports.</summary>
public sealed class SpotSnapshotVwapTests
{
    // 09:15 IST on two consecutive trading days.
    private static readonly DateTimeOffset DayOneOpen = new(2026, 9, 28, 3, 45, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset DayTwoOpen = new(2026, 9, 29, 3, 45, 0, TimeSpan.Zero);

    private static List<CandleWithVolume> Bars(DateTimeOffset open, decimal basePrice, int count) =>
        Enumerable.Range(0, count)
            .Select(i => new CandleWithVolume(open.AddMinutes(i), basePrice + i, basePrice + i + 2, basePrice + i - 1, basePrice + i + 1, 1000 + i * 10))
            .ToList();

    [Fact]
    public void CurrentSessionVolumeBars_OnlyReturnsTheLatestIstDay()
    {
        var state = new SpotUnderlyingState("NIFTY", 50);
        state.SeedVolumeHistory(Bars(DayOneOpen, 25000, 50).Concat(Bars(DayTwoOpen, 25200, 30)));

        var session = state.GetCurrentSessionVolumeBars();

        Assert.Equal(30, session.Count);
        Assert.All(session, b => Assert.Equal(IstClock.IstDate(DayTwoOpen), IstClock.IstDate(b.Time)));
    }

    [Fact]
    public void SnapshotVwap_MatchesTheFullHistoryComputation()
    {
        var state = new SpotUnderlyingState("NIFTY", 50);
        var all = Bars(DayOneOpen, 25000, 50).Concat(Bars(DayTwoOpen, 25200, 30)).ToList();
        state.SeedVolumeHistory(all);

        var expected = VwapCalculator.ComputeSeries(all)[^1].Obv;

        Assert.Equal(expected, state.ToSnapshot().Vwap);
    }

    [Fact]
    public void CurrentSessionVolumeBars_EmptyStateReturnsEmpty()
    {
        Assert.Empty(new SpotUnderlyingState("NIFTY", 50).GetCurrentSessionVolumeBars());
    }
}

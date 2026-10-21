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

    [Fact]
    public void LiveIndexTicks_CarryNoVolume_TheMinuteCandlesFromDhanGiveTheSessionItsVwap()
    {
        var state = new SpotUnderlyingState("NIFTY", 50);
        // The live index feed: last price only, volume 0 - five minutes of ticks, the fifth still forming.
        for (var m = 0; m < 5; m++)
            state.ApplyTick(new SpotTick(1, 25200 + m, 0, 0, 0, 0, 0, 0, 0, 0, DayTwoOpen.AddMinutes(m).AddSeconds(10)));
        Assert.Null(state.ToSnapshot().Vwap);

        // Dhan's candles for the day so far (with volume), including the minute still forming from ticks.
        var dhan = Bars(DayTwoOpen, 25200, 5);
        state.MergeVolumeBars(dhan);

        Assert.Equal(VwapCalculator.ComputeSeries(dhan.Take(4).ToList())[^1].Obv, state.ToSnapshot().Vwap);
        var bars = state.GetVolumeBars();
        Assert.Equal(dhan.Take(4).Select(b => b.Volume), bars.Take(4).Select(b => b.Volume));
        // The forming minute is still the live ticks' own.
        Assert.Equal(DayTwoOpen.AddMinutes(4), bars[^1].Time);
        Assert.Equal(0, bars[^1].Volume);
    }
}

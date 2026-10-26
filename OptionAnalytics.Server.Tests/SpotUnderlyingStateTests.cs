using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers the exact distinction SpotFeedHostedService's own backfill-retry logic depends
/// on: GetCandles() (backfilled history PLUS the still-forming live bar) is not the same thing as
/// "backfill actually succeeded" - only GetClosedCandles() (backfilled history alone) answers that.
/// A single live tick, on its own, can make GetCandles() non-empty long before any real history has
/// ever been seeded - which is exactly what let RetryBackfillIfNeededAsync's "are we done retrying"
/// check (and BackfillAsync's onlyIfEmpty skip) both stop for good on an underlying whose spot
/// backfill had actually returned zero candles, leaving it permanently stuck showing a single
/// stray tick instead of real history.</summary>
public sealed class SpotUnderlyingStateTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero);

    private static SpotTick Tick(DateTimeOffset time, decimal price = 100m) =>
        new(SecurityId: 13, LastPrice: price, Open: price, High: price, Low: price, Close: price, Volume: 0, BestBidPrice: 0, BestAskPrice: 0, OpenInterest: 0, ExchangeTimestamp: time);

    [Fact]
    public void ASingleLiveTick_WithNoBackfillSeeded_MakesGetCandlesNonEmptyButGetClosedCandlesStaysEmpty()
    {
        var state = new SpotUnderlyingState("NIFTY", 50);

        // No SeedHistory call at all - this is the "backfill genuinely returned zero candles" case.
        state.ApplyTick(Tick(T0));

        // The still-forming bar makes GetCandles() non-empty...
        Assert.Single(state.GetCandles());
        // ...but GetClosedCandles() - the only thing that reflects REAL seeded history - is still
        // empty, which is what SpotFeedHostedService's retry/skip checks must test against instead.
        Assert.Empty(state.GetClosedCandles());
    }

    [Fact]
    public void SeedHistory_PopulatesGetClosedCandles()
    {
        var state = new SpotUnderlyingState("NIFTY", 50);

        state.SeedHistory(new[] { new Candle(T0, 100, 100, 100, 100) });

        Assert.Single(state.GetClosedCandles());
    }

    // Market hours only (MarketHours.InTradingSession): Dhan keeps sending the index after the 15:30 close.
    private static readonly DateTimeOffset Close = new(2026, 10, 26, 10, 0, 0, TimeSpan.Zero);   // Monday 15:30 IST

    private static SpotTick VolumeTick(DateTimeOffset time, decimal price, long volume) =>
        new(SecurityId: 13, LastPrice: price, Open: price, High: price, Low: price, Close: price, Volume: volume, BestBidPrice: 0, BestAskPrice: 0, OpenInterest: 0, ExchangeTimestamp: time);

    [Fact]
    public void AfterTheClose_TheLastPriceFollowsTheIndex_ButNoBarIsBuilt_AndTheChartEndsAt1529()
    {
        var state = new SpotUnderlyingState("NIFTY", 50);
        var closed = new List<Candle>();
        state.BarClosed += closed.Add;
        state.ApplyTick(Tick(Close.AddMinutes(-2).AddSeconds(5), 100m));   // 15:28
        state.ApplyTick(Tick(Close.AddMinutes(-1).AddSeconds(5), 101m));   // 15:29
        state.ApplyTick(Tick(Close.AddMinutes(-1).AddSeconds(50), 102m));

        // 15:30, 16:00 and 18:30: the price moves on, the chart does not.
        Assert.Null(state.ApplyTick(Tick(Close.AddSeconds(1), 103m)));
        state.ApplyTick(Tick(Close.AddMinutes(30), 104m));
        state.ApplyTick(Tick(Close.AddHours(3), 105m));

        Assert.Equal(105m, state.LastPrice);
        Assert.Null(state.GetCurrentBar());
        Assert.Null(state.ToSnapshot().CurrentBar);
        var candles = state.GetCandles();
        Assert.Equal(new[] { Close.AddMinutes(-2), Close.AddMinutes(-1) }, candles.Select(c => c.Time));
        Assert.Equal(102m, candles[^1].Close);
        // The 15:29 bar is announced closed once, by the first tick after the close.
        Assert.Equal(new[] { Close.AddMinutes(-2), Close.AddMinutes(-1) }, closed.Select(c => c.Time));
        Assert.All(state.GetVolumeBars(), b => Assert.True(b.Time < Close));
    }

    [Fact]
    public void BeforeTheOpen_NoBar_AndThePreOpenVolumeIsNotCountedInTheFirstMinute()
    {
        var state = new SpotUnderlyingState("NIFTY", 50);
        var open = Close.AddHours(-6).AddMinutes(-15);   // 09:15 IST
        state.ApplyTick(VolumeTick(open.AddMinutes(-7), 100m, 1_000));   // 09:08, pre-open
        Assert.Empty(state.GetCandles());

        state.ApplyTick(VolumeTick(open.AddSeconds(2), 101m, 1_300));
        Assert.Equal(open, Assert.Single(state.GetCandles()).Time);
        Assert.Equal(300, Assert.Single(state.GetVolumeBars()).Volume);
    }

    [Fact]
    public void AStrayOlderOutOfSessionTick_DoesNotEndTheFormingBar()
    {
        var state = new SpotUnderlyingState("NIFTY", 50);
        state.ApplyTick(Tick(T0, 100m));
        state.ApplyTick(Tick(DateTimeOffset.UnixEpoch, 99m));   // no exchange time on the packet
        state.ApplyTick(Tick(T0.AddSeconds(30), 102m));

        var bar = Assert.Single(state.GetCandles());
        Assert.Equal((T0, 100m, 102m), (bar.Time, bar.Open, bar.Close));
    }
}

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

    // A tick off the live feed: Dhan's exchange time and when it came off the socket.
    private static SpotTick LiveTick(DateTimeOffset exchange, DateTimeOffset arrived, decimal price) =>
        Tick(exchange, price) with { ReceivedAt = arrived };

    [Fact]
    public void AnExchangeTimeHoursOff_FilesTheTickByItsArrival_SoTheSpotChartStillMoves()
    {
        // Asked about: "spot price is updating but spot charts are not". 09:31 IST, but the packet's time reads 5h30 earlier
        // (04:01 IST - before the open): every tick read as outside the session, the price moved and no candle was built.
        var state = new SpotUnderlyingState("NIFTY", 50);
        var at0931 = Close.AddHours(-6).AddMinutes(1);   // 09:31 IST
        var shifted = TimeSpan.FromHours(5.5);
        state.ApplyTick(LiveTick(at0931.AddSeconds(5) - shifted, at0931.AddSeconds(5), 25560m));
        state.ApplyTick(LiveTick(at0931.AddSeconds(40) - shifted, at0931.AddSeconds(40), 25571.75m));
        state.ApplyTick(LiveTick(at0931.AddSeconds(65) - shifted, at0931.AddSeconds(65), 25566m));   // 09:32

        Assert.Equal(25566m, state.LastPrice);
        var candles = state.GetCandles();
        Assert.Equal(new[] { at0931, at0931.AddMinutes(1) }, candles.Select(c => c.Time));
        Assert.Equal((25560m, 25571.75m, 25571.75m), (candles[0].Open, candles[0].High, candles[0].Close));
        Assert.Equal(at0931.AddMinutes(1), state.ToSnapshot().CurrentBar?.Time);
        Assert.True(state.LastFiledByArrival);
        Assert.Equal(shifted, state.LastExchangeGap);
        // The raw exchange time is still reported as Dhan sent it.
        Assert.Equal(at0931.AddSeconds(65) - shifted, state.LastExchangeTimeUtc);
    }

    [Fact]
    public void AFrozenExchangeTime_FilesTheTicksByArrival_NotIntoTheOldMinute()
    {
        // The packet's time stuck at 09:21:10 while ticks keep arriving to 09:31: the page ignores a bar older than the one
        // it holds, so filed by the stuck time the chart stood at 09:21.
        var state = new SpotUnderlyingState("NIFTY", 50);
        var at0921 = Close.AddHours(-6).AddMinutes(-9);   // 09:21 IST
        state.ApplyTick(LiveTick(at0921.AddSeconds(10), at0921.AddSeconds(10), 25600m));
        foreach (var (minute, price) in new[] { (5, 25590m), (9, 25580m), (10, 25571m) })
            state.ApplyTick(LiveTick(at0921.AddSeconds(10), at0921.AddMinutes(minute).AddSeconds(3), price));

        Assert.Equal(new[] { at0921, at0921.AddMinutes(5), at0921.AddMinutes(9), at0921.AddMinutes(10) }, state.GetCandles().Select(c => c.Time));
        Assert.Equal(25600m, state.GetCandles()[0].Close);   // the 09:21 bar keeps only its own minute's price
        Assert.Equal(at0921.AddMinutes(10), state.GetCurrentBar()?.Time);
    }

    [Fact]
    public void AHealthyExchangeTime_WithinFiveSecondsOfArrival_StillDecidesTheMinute()
    {
        // Exchange 09:59:58, arrived 10:00:02: the exchange's minute, as Dhan's own candles have it - unchanged.
        var state = new SpotUnderlyingState("NIFTY", 50);
        var at1000 = Close.AddHours(-5).AddMinutes(-30);   // 10:00 IST
        state.ApplyTick(LiveTick(at1000.AddSeconds(-2), at1000.AddSeconds(2), 25550m));

        Assert.Equal(at1000.AddMinutes(-1), Assert.Single(state.GetCandles()).Time);
        Assert.False(state.LastFiledByArrival);
        Assert.Equal(TimeSpan.FromSeconds(4), state.LastExchangeGap);
        Assert.Equal(SpotUnderlyingState.MaxExchangeLag, TimeSpan.FromSeconds(5));
        // Exactly 5 s apart still counts as healthy; a tick with no arrival time (history, tests) keeps its exchange time.
        Assert.Equal(at1000, SpotUnderlyingState.FiledTime(LiveTick(at1000, at1000.AddSeconds(5), 1m)));
        Assert.Equal(at1000.AddSeconds(6), SpotUnderlyingState.FiledTime(LiveTick(at1000, at1000.AddSeconds(6), 1m)));
        Assert.Equal(at1000, SpotUnderlyingState.FiledTime(Tick(at1000)));
    }

    [Fact]
    public void AfterTheClose_ByArrival_TheShiftedTickStillBuildsNoBar()
    {
        // 15:31 IST with a time 5h30 earlier (10:01 IST - inside the session by the packet): filed by arrival it is after
        // the close, so the chart still ends at 15:29.
        var state = new SpotUnderlyingState("NIFTY", 50);
        state.ApplyTick(LiveTick(Close.AddMinutes(-1), Close.AddMinutes(-1).AddSeconds(1), 100m));
        var arrived = Close.AddMinutes(1);
        state.ApplyTick(LiveTick(arrived - TimeSpan.FromHours(5.5), arrived, 101m));

        Assert.Equal(101m, state.LastPrice);
        Assert.Null(state.GetCurrentBar());
        Assert.Equal(Close.AddMinutes(-1), Assert.Single(state.GetCandles()).Time);
    }
}

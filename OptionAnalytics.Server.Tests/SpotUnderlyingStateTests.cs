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
}

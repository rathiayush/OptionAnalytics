using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers OiReplayLiveFeedService.ResolveNearestExpiryCore - which real listed expiry date
/// the live tick feed (and its own REST-quote fallback) tracks for a WEEK/MONTH combo. A previous
/// version filtered WEEK to exclude whatever IsMonthly classified as "the month's own monthly",
/// which broke during the final week before that monthly expiry: NSE lists no separate, closer
/// weekly for that week at all, so the "nearest weekly" a WEEK combo should track IS the monthly
/// contract that week - the old code instead skipped straight past it to next month's first weekly,
/// a real, confirmed live bug (a strike's own tracked premium abruptly jumping mid-session to a
/// wildly different value once live ticks for the wrong, further-dated contract started arriving).</summary>
public sealed class OiReplayLiveFeedServiceTests
{
    [Fact]
    public void Week_FinalWeekBeforeMonthly_ResolvesToTheMonthlyDateItself_NotNextMonth()
    {
        // 29 Sep 2026 is genuinely September's own monthly expiry (confirmed in
        // ExpiryCalendarTests.MonthlyExpiries_ReturnsTheLastTuesdayOfEachMonth) - from 28 Sep 2026,
        // it is also the SINGLE NEAREST listed date, with no separate, closer weekly in between.
        var listed = new[] { new DateOnly(2026, 9, 29), new DateOnly(2026, 10, 6), new DateOnly(2026, 10, 13), new DateOnly(2026, 10, 27) };

        var resolved = OiReplayLiveFeedService.ResolveNearestExpiryCore(listed, "WEEK");

        Assert.Equal(new DateOnly(2026, 9, 29), resolved);
    }

    [Fact]
    public void Week_OrdinaryWeek_ResolvesToTheSingleNearestListedDate()
    {
        var listed = new[] { new DateOnly(2026, 10, 6), new DateOnly(2026, 10, 13), new DateOnly(2026, 10, 27) };

        var resolved = OiReplayLiveFeedService.ResolveNearestExpiryCore(listed, "WEEK");

        Assert.Equal(new DateOnly(2026, 10, 6), resolved);
    }

    [Fact]
    public void Month_ResolvesToTheNearestDateClassifiedAsItsOwnMonthsLast()
    {
        var listed = new[] { new DateOnly(2026, 9, 29), new DateOnly(2026, 10, 6), new DateOnly(2026, 10, 13), new DateOnly(2026, 10, 27) };

        var resolved = OiReplayLiveFeedService.ResolveNearestExpiryCore(listed, "MONTH");

        Assert.Equal(new DateOnly(2026, 9, 29), resolved);
    }

    [Fact]
    public void Month_SkipsPastAnAlreadyExpiredMonthlyToTheNextOne()
    {
        // No 29 Sep candidate at all here (already past) - October's own last listed date (27th) is
        // the nearest MONTH can resolve to.
        var listed = new[] { new DateOnly(2026, 10, 6), new DateOnly(2026, 10, 13), new DateOnly(2026, 10, 27) };

        var resolved = OiReplayLiveFeedService.ResolveNearestExpiryCore(listed, "MONTH");

        Assert.Equal(new DateOnly(2026, 10, 27), resolved);
    }

    [Fact]
    public void EmptyListed_ResolvesToNull()
    {
        Assert.Null(OiReplayLiveFeedService.ResolveNearestExpiryCore(Array.Empty<DateOnly>(), "WEEK"));
        Assert.Null(OiReplayLiveFeedService.ResolveNearestExpiryCore(Array.Empty<DateOnly>(), "MONTH"));
    }

    private static readonly DateOnly[] SixListed =
    {
        new(2026, 9, 29), new(2026, 10, 6), new(2026, 10, 13), new(2026, 10, 20), new(2026, 10, 27), new(2026, 11, 24),
    };

    [Theory]
    [InlineData("N1", 0)]
    [InlineData("N2", 1)]
    [InlineData("N3", 2)]
    [InlineData("N6", 5)]
    public void PositionalFlag_ResolvesToThatIndexOfTheFullUnfilteredList(string flag, int expectedIndex)
    {
        var resolved = OiReplayLiveFeedService.ResolveNearestExpiryCore(SixListed, flag);

        Assert.Equal(SixListed[expectedIndex], resolved);
    }

    [Fact]
    public void PositionalFlag_N1_MatchesWeeksOwnIndexZero()
    {
        // N1 is deliberately just WEEK generalized to an explicit position - the two must always
        // agree at position 0, since a client tracking "N1" and a client tracking "WEEK" are meant
        // to be watching the exact same real contract (see PositionalExpiriesPerUnderlying's own
        // doc comment on why N1 duplicates WEEK/MONTH rather than being special-cased away).
        var week = OiReplayLiveFeedService.ResolveNearestExpiryCore(SixListed, "WEEK");
        var n1 = OiReplayLiveFeedService.ResolveNearestExpiryCore(SixListed, "N1");

        Assert.Equal(week, n1);
    }

    [Fact]
    public void PositionalFlag_BeyondListedCount_ResolvesToNull_NotSomeOtherContract()
    {
        var resolved = OiReplayLiveFeedService.ResolveNearestExpiryCore(SixListed, "N7");

        Assert.Null(resolved);
    }
}

/// <summary>The near futures' live ticks (OiReplayLiveFeedService.OnTick): they are not option legs, and the legs'
/// early return used to drop them - OI Replay's futures chart never ticked and today's futures bars stayed empty.</summary>
public sealed class OiReplayLiveFuturesTickTests
{
    private const uint FuturesId = 48699;

    private static (OiReplayLiveFeedService Service, LiveBroadcastBatcher Batcher, LiveOptionLegStore Store) Service()
    {
        var batcher = new LiveBroadcastBatcher(null, Microsoft.Extensions.Logging.Abstractions.NullLogger<LiveBroadcastBatcher>.Instance);
        var store = new LiveOptionLegStore();
        var service = new OiReplayLiveFeedService(null!, null!, null!, null!, null!, null!, batcher,
            Microsoft.Extensions.Logging.Abstractions.NullLogger<OiReplayLiveFeedService>.Instance, legStore: store);
        service.FuturesLegs[FuturesId] = new OiReplayLiveFeedService.FuturesLeg("NIFTY", IstClock.Today().AddDays(7));
        return (service, batcher, store);
    }

    // Both ticks in one minute: not in the last half second of one.
    private static void AwayFromMinuteEdge()
    {
        var now = DateTimeOffset.UtcNow;
        if (now.Second == 59 && now.Millisecond > 500) Thread.Sleep(600);
    }

    private static OptionAnalytics.Server.Dhan.SpotTick Tick(uint id, decimal price, long volume) =>
        new(id, price, price, price, price, price, volume, 0, 0, 1_000_000, DateTimeOffset.UtcNow);

    [Fact]
    public void A_futures_tick_is_sent_to_the_page_and_kept_as_todays_bar()
    {
        var (service, batcher, store) = Service();
        batcher.Join("page", "u:NIFTY");
        AwayFromMinuteEdge();
        var started = DateTimeOffset.UtcNow.ToOffset(IstClock.Offset);

        service.OnTick(Tick(FuturesId, 25_610.5m, 1_200));
        service.OnTick(Tick(FuturesId, 25_612m, 1_500));

        var items = batcher.Flush(DateTimeOffset.UtcNow).Single(b => b.ConnectionId == "page").Batch.Items;
        var sent = Assert.IsType<LiveFuturesTick>(Assert.Single(items.Where(i => i.E == "futuresTicks").SelectMany(i => (IEnumerable<object>)i.D)));
        Assert.Equal(("NIFTY", 25_612m, 25_610.5m, 1_500L), (sent.Underlying, sent.Price, sent.Open, sent.DayVolume));

        var bar = Assert.Single(store.FuturesBarsFrom("NIFTY", started));
        Assert.Equal((25_610.5m, 25_612m), (bar.Open, bar.Close));
    }

    [Fact]
    public void Another_instruments_tick_is_ignored()
    {
        var (service, batcher, store) = Service();
        batcher.Join("page", "u:NIFTY");
        var started = DateTimeOffset.UtcNow.ToOffset(IstClock.Offset);

        service.OnTick(Tick(FuturesId + 1, 25_610.5m, 1_200));

        Assert.DoesNotContain(batcher.Flush(DateTimeOffset.UtcNow).SelectMany(b => b.Batch.Items), i => i.E == "futuresTicks");
        Assert.Empty(store.FuturesBarsFrom("NIFTY", started));
    }
}

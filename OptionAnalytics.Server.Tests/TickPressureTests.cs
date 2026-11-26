using System.Diagnostics;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.TrueData;

namespace OptionAnalytics.Server.Tests;

/// <summary>The tick path under pressure: a burst through the feed's inbox keeps every tick in order, the per-tick work of the books and of the big-order
/// watch stays cheap at a rate far past what TrueData sends (a few hundred a second), and a snapshot asked for again is not built again. Generous
/// time bounds - they catch an order-of-magnitude regression (a scan of every event per tick), not a slow machine.</summary>
public sealed class TickPressureTests
{
    private static readonly TimeSpan Ist = TimeSpan.FromMinutes(330);
    private static readonly DateTimeOffset T0 = new(2026, 11, 24, 10, 0, 0, Ist);
    private const int Lot = 65;

    private static TrueDataLiveFeed Feed() => new(Options.Create(new TrueDataOptions
    {
        Enabled = true, UserId = "u", Password = "p",
        Live = new TrueDataLiveOptions { Enabled = true, Instruments = new() { new() { Underlying = "NIFTY", Symbol = "NIFTY-I", LotSize = Lot, TickSize = 0.05m } } },
    }), NullLogger<TrueDataLiveFeed>.Instance) { Clock = () => T0 };

    [Fact]
    public async Task ABurstThroughTheInboxKeepsEveryTickInOrder_WithNoGapAndNothingLeftQueued()
    {
        const int n = 150_000;
        var feed = Feed();
        feed.Register(new[] { new TrueDataSymbol("NIFTY-I", "7") });
        using var stop = new CancellationTokenSource();
        var worker = feed.ProcessInboxAsync(stop.Token);
        var clock = Stopwatch.StartNew();
        for (var i = 1; i <= n; i++)
        {
            var price = 25000m + (i % 40) * 0.05m;
            var trade = new TrueDataTrade("7", T0.AddMilliseconds(i), price, Lot, price, i * (long)Lot, 0, 0, 0, 0, 0, "", i, price - 0.05m, 100, price, 100);
            await feed.EnqueueAsync(new TrueDataFrame("trade", Trade: trade), CancellationToken.None);
        }
        while (feed.QueueSnapshot().Depth > 0) await Task.Delay(2);
        clock.Stop();
        stop.Cancel();
        await worker;

        var meta = feed.BookFor("NIFTY")!.Meta();
        Assert.Equal(n, meta.Prints);                       // none lost
        Assert.Equal(0, meta.SequenceGaps);                 // none out of order
        var q = feed.QueueSnapshot();
        Assert.Equal(n, q.Processed);
        Assert.Equal(0, q.Errors);
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(20), $"{n} ticks took {clock.Elapsed}");
    }

    [Fact]
    public async Task AFullInboxHoldsTheSocketRatherThanDroppingATick()
    {
        // A worker that has not started: the queue fills to its capacity, the next write waits (and is counted), and every tick is there once it starts.
        var feed = Feed();
        feed.Register(new[] { new TrueDataSymbol("NIFTY-I", "7") });
        const int fill = 200_000, extra = 3;
        for (var i = 1; i <= fill; i++)
            await feed.EnqueueAsync(new TrueDataFrame("bidask", Quote: new TrueDataQuote("7", T0, 100m, 1, 100.05m, 1)), CancellationToken.None);
        Assert.Equal(0, feed.QueueSnapshot().Backpressure);
        var waiting = Enumerable.Range(0, 1).Select(async _ =>
        {
            for (var i = 0; i < extra; i++)
                await feed.EnqueueAsync(new TrueDataFrame("bidask", Quote: new TrueDataQuote("7", T0, 100m, 1, 100.05m, 1)), CancellationToken.None);
        }).Single();
        await Task.Delay(100);
        Assert.False(waiting.IsCompleted);                   // held, not dropped
        using var stop = new CancellationTokenSource();
        var worker = feed.ProcessInboxAsync(stop.Token);
        await waiting;
        while (feed.QueueSnapshot().Depth > 0) await Task.Delay(2);
        stop.Cancel();
        await worker;
        var q = feed.QueueSnapshot();
        Assert.Equal(fill + extra, q.Processed);
        Assert.True(q.Backpressure >= 1);
        Assert.True(q.MaxDepth >= fill);
    }

    [Fact]
    public void TheBigOrderWatchTakesHundredsOfThousandsOfTicksAcrossFortyTwoOptions_WithoutAScanPerTick()
    {
        var w = new OptionBigOrderWatch { Atm = 25000, Step = 50 };
        var contracts = new List<OptionContract>();
        for (var k = 0; k < 21; k++)
        {
            var strike = 24500m + k * 50;
            contracts.Add(new OptionContract($"{k}1", $"C{k}", strike, true, new DateOnly(2026, 12, 1), Lot));
            contracts.Add(new OptionContract($"{k}2", $"P{k}", strike, false, new DateOnly(2026, 12, 1), Lot));
        }
        foreach (var c in contracts) w.Track(c);
        var clock = Stopwatch.StartNew();
        var rnd = new Random(1);
        long events = 0;
        const int perOption = 5_000;                          // 210 000 ticks - a day is ~25 000 s of ~1 tick a second an option
        for (var i = 1; i <= perOption; i++)
            foreach (var c in contracts)
            {
                var lots = rnd.Next(100) < 10 ? 40 + rnd.Next(60) : 1 + rnd.Next(5);   // 10% big
                var price = 100m + (i % 7) * 0.05m;
                var tick = new TrueDataTrade(c.SymbolId, T0.AddSeconds(i), price, lots * Lot, price, i * 200L, 0, 0, 0, 0, 1000 + i, "", i, price - 0.05m, 500, price, 500);
                if (w.OnTrade(tick, T0.AddSeconds(i)) is not null) events++;
            }
        var feedTime = clock.Elapsed;
        clock.Restart();
        for (var i = 0; i < 2_000; i++) w.Since(w.Meta().LastSeq - 50);       // a page's poll for the last few orders
        var pollTime = clock.Elapsed;

        Assert.True(events > 1_000);
        Assert.Equal(OptionBigOrderWatch.Capacity, w.Since(0, 100_000).Count);   // capped, newest kept
        Assert.True(feedTime < TimeSpan.FromSeconds(15), $"210 000 ticks took {feedTime}");
        Assert.True(pollTime < TimeSpan.FromSeconds(2), $"2 000 polls took {pollTime}");
        Assert.Equal(42, w.TrackedCount);
    }

    [Fact]
    public void ASnapshotAskedForAgainWithNothingNewIsTheOneAlreadyBuilt_AndAChangeBuildsANewOne()
    {
        var book = new TickBook("NIFTY", "NIFTY-I", Lot, 0.05m);
        for (var i = 1; i <= 2_000; i++)
            book.OnTrade(T0.AddSeconds(i), i, 25000m + (i % 30) * 0.05m, Lot, 24999.9m, 100, 25000.1m, 100);
        var first = book.Snapshot(1, 1, 6000);
        var again = book.Snapshot(1, 1, 6000);
        Assert.Same(first, again);                                   // same version, same question: not rebuilt
        book.OnTrade(T0.AddSeconds(5000), 2_001, 25001m, Lot, 25000.9m, 100, 25001.1m, 100);
        var next = book.Snapshot(1, 1, 6000);
        Assert.NotSame(first, next);
        Assert.Equal(first.Bars.Count + 1, next.Bars.Count);         // the new minute
        Assert.Same(first.Bars[0], next.Bars[0]);                    // a finished minute is the same object - not rebuilt
        Assert.NotSame(next, book.Snapshot(5, 1, 6000));             // another row size is another snapshot
        // The newest bubbles that pass the filter, oldest first, none more than asked.
        var big = book.Snapshot(1, Lot * 1, 10);
        Assert.Equal(10, big.Bubbles.Count);
        Assert.True(big.Bubbles.Zip(big.Bubbles.Skip(1), (a, b) => a.Time <= b.Time).All(x => x));
    }
}

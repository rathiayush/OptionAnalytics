using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Tests;

/// <summary>TickConsumerQueue - each live-tick consumer on its own queue and worker, so one slow
/// consumer (CDV recomputing history, say) can no longer hold up the Dhan receive loop and with it
/// every other consumer's data.</summary>
public sealed class TickConsumerQueueTests
{
    private static SpotTick Tick(uint id) => new(id, 100, 100, 100, 100, 100, 0, 0, 0, 0, DateTimeOffset.UtcNow);

    [Fact]
    public async Task ASlowConsumerNeverHoldsUpAFastOne()
    {
        var fastSeen = 0;
        using var slow = new TickConsumerQueue("slow", _ => Thread.Sleep(50), NullLogger.Instance);
        using var fast = new TickConsumerQueue("fast", _ => Interlocked.Increment(ref fastSeen), NullLogger.Instance);

        var enqueue = System.Diagnostics.Stopwatch.StartNew();
        for (uint i = 0; i < 40; i++) { slow.Enqueue(Tick(i)); fast.Enqueue(Tick(i)); }
        enqueue.Stop();

        // Enqueue never waits for a handler - 40 ticks into a 50ms-per-tick consumer would otherwise take 2s.
        Assert.True(enqueue.ElapsedMilliseconds < 200, $"enqueue took {enqueue.ElapsedMilliseconds}ms");
        for (var waited = 0; Volatile.Read(ref fastSeen) < 40 && waited < 2000; waited += 10) await Task.Delay(10);
        Assert.Equal(40, Volatile.Read(ref fastSeen));
        Assert.True(slow.GetStats().Queued > 20, "the slow consumer is still working through its own queue");
    }

    [Fact]
    public void TicksArriveInOrder()
    {
        var seen = new List<uint>();
        using var queue = new TickConsumerQueue("order", t => seen.Add(t.SecurityId), NullLogger.Instance, startWorker: false);
        for (uint i = 0; i < 100; i++) queue.Enqueue(Tick(i));
        queue.Drain();
        Assert.Equal(Enumerable.Range(0, 100).Select(i => (uint)i), seen);
        Assert.Equal(100, queue.GetStats().Processed);
    }

    [Fact]
    public void AFailingTickDoesNotStopTheConsumer()
    {
        var seen = new List<uint>();
        using var queue = new TickConsumerQueue("throws", t =>
        {
            if (t.SecurityId == 3) throw new InvalidOperationException("bad tick");
            seen.Add(t.SecurityId);
        }, NullLogger.Instance, startWorker: false);
        for (uint i = 0; i < 6; i++) queue.Enqueue(Tick(i));
        queue.Drain();
        Assert.Equal(new uint[] { 0, 1, 2, 4, 5 }, seen);
    }

    [Fact]
    public void AStuckConsumerDropsItsOldestTicksInsteadOfGrowingForever()
    {
        uint? first = null;
        using var queue = new TickConsumerQueue("stuck", t => first ??= t.SecurityId, NullLogger.Instance, startWorker: false);
        for (uint i = 0; i < TickConsumerQueue.Capacity + 5; i++) queue.Enqueue(Tick(i));

        var stats = queue.GetStats();
        Assert.Equal(TickConsumerQueue.Capacity, stats.Queued);
        Assert.Equal(5, stats.Dropped);
        queue.Drain();
        Assert.Equal(5u, first);
    }
}

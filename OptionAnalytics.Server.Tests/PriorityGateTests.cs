using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>The live-trading order gate (PriorityGate): one action at a time, an EXIT let in before entries queued ahead of it.</summary>
public sealed class PriorityGateTests
{
    [Fact]
    public async Task An_exit_waiting_goes_before_entries_queued_ahead_of_it()
    {
        var gate = new PriorityGate();
        await gate.WaitAsync(CancellationToken.None);                   // an entry is being placed
        var order = new List<string>();
        var entry1 = gate.WaitAsync(CancellationToken.None).ContinueWith(_ => { lock (order) order.Add("entry1"); gate.Release(); });
        var entry2 = gate.WaitAsync(CancellationToken.None).ContinueWith(_ => { lock (order) order.Add("entry2"); gate.Release(); });
        Assert.False(gate.UrgentWaiting);
        var exit = gate.WaitAsync(CancellationToken.None, urgent: true).ContinueWith(_ => { lock (order) order.Add("exit"); gate.Release(); });
        Assert.True(gate.UrgentWaiting);                                // the entry holding it can see an exit is waiting
        gate.Release();
        await Task.WhenAll(entry1, entry2, exit);
        Assert.Equal(new[] { "exit", "entry1", "entry2" }, order);
        Assert.True(await gate.WaitAsync(0));                           // free again
    }

    [Fact]
    public async Task Try_takes_it_only_when_free_and_a_cancelled_waiter_leaves_the_queue()
    {
        var gate = new PriorityGate();
        Assert.True(await gate.WaitAsync(0));
        Assert.False(await gate.WaitAsync(0));
        using var cts = new CancellationTokenSource();
        var waiting = gate.WaitAsync(cts.Token, urgent: true);
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => waiting);
        Assert.False(gate.UrgentWaiting);
        var next = gate.WaitAsync(CancellationToken.None);
        gate.Release();
        await next;                                                     // passed to the next waiter, not lost to the cancelled one
        gate.Release();
        Assert.Throws<SemaphoreFullException>(() => gate.Release());
    }
}

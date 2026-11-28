namespace OptionAnalytics.Server.Services;

/// <summary>
/// ONE ORDER ACTION AT A TIME, EXITS FIRST (asked for - "can the order API always get priority without blocking anything"): the live-trading
/// lock every place / exit / cancel / modify takes (LiveTradingService's <c>_actionLock</c>). Like a SemaphoreSlim(1, 1), but a waiter marked
/// URGENT (an exit: a strategy's stop-loss / target / trail, Close, Exit all, a partial exit, a target reached) is let in before any ordinary
/// one (an entry, a level change) queued ahead of it - so an exit never sits behind another strategy's entry. The holder is never
/// interrupted; <see cref="UrgentWaiting"/> lets a long holder (an entry retrying a rejection) stop early and hand over.
/// </summary>
public sealed class PriorityGate
{
    private readonly object _lock = new();
    private readonly LinkedList<TaskCompletionSource<bool>> _urgent = new();
    private readonly LinkedList<TaskCompletionSource<bool>> _normal = new();
    private bool _held;

    /// <summary>An urgent action (an exit) is waiting for the gate.</summary>
    public bool UrgentWaiting { get { lock (_lock) return _urgent.Count > 0; } }

    /// <summary>Takes the gate at once or not at all (SemaphoreSlim.WaitAsync(0)).</summary>
    public Task<bool> WaitAsync(int millisecondsTimeout)
    {
        if (millisecondsTimeout != 0) throw new ArgumentOutOfRangeException(nameof(millisecondsTimeout), "only 0 (try) is supported");
        lock (_lock)
        {
            if (_held) return Task.FromResult(false);
            _held = true;
            return Task.FromResult(true);
        }
    }

    public Task WaitAsync() => WaitAsync(CancellationToken.None);

    /// <summary>Waits for the gate; <paramref name="urgent"/> goes ahead of every ordinary waiter.</summary>
    public Task WaitAsync(CancellationToken cancellationToken, bool urgent = false)
    {
        TaskCompletionSource<bool> waiter;
        LinkedListNode<TaskCompletionSource<bool>> node;
        lock (_lock)
        {
            if (!_held) { _held = true; return Task.CompletedTask; }
            cancellationToken.ThrowIfCancellationRequested();
            waiter = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            node = (urgent ? _urgent : _normal).AddLast(waiter);
        }
        if (!cancellationToken.CanBeCanceled) return waiter.Task;
        var registration = cancellationToken.Register(() =>
        {
            bool removed;
            lock (_lock)
            {
                removed = node.List is not null;
                node.List?.Remove(node);
            }
            if (removed) waiter.TrySetCanceled(cancellationToken);
        });
        return waiter.Task.ContinueWith(t => { registration.Dispose(); return t; }, TaskScheduler.Default).Unwrap();
    }

    /// <summary>Hands the gate to the next waiter - an urgent one first - or frees it.</summary>
    public void Release()
    {
        TaskCompletionSource<bool>? next = null;
        lock (_lock)
        {
            if (!_held) throw new SemaphoreFullException();
            var list = _urgent.Count > 0 ? _urgent : _normal.Count > 0 ? _normal : null;
            if (list is null) { _held = false; return; }
            next = list.First!.Value;
            list.RemoveFirst();
        }
        next.TrySetResult(true);    // the gate stays held - it passes to the waiter
    }
}

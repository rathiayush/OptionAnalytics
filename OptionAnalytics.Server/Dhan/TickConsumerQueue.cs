using System.Diagnostics;
using System.Threading.Channels;

namespace OptionAnalytics.Server.Dhan;

/// <summary>One live-tick consumer (spot, CDV, OI Replay) with its own queue and worker.
///
/// Every consumer used to run synchronously on the Dhan WebSocket receive loop, so the slowest one
/// set the pace for all of them: any heavy work (or lock wait) in one consumer left packets unread
/// in the socket, and every page - spot included - went stale while the connection looked healthy.
/// Now the receive loop only hands each consumer the tick (Enqueue never blocks), and each consumer
/// works through its own queue at its own pace. A slow consumer only delays itself.
///
/// The queue is bounded: past Capacity the OLDEST tick is dropped (and counted) rather than letting
/// a stuck consumer grow memory without limit - its newest ticks are the ones worth processing.
/// Stats (queue depth, slowest handler, longest wait, drops) cover roughly the last minute, so the
/// app can show which consumer, if any, is falling behind.</summary>
public sealed class TickConsumerQueue : IDisposable
{
    public const int Capacity = 100_000;
    private static readonly TimeSpan StatsWindow = TimeSpan.FromSeconds(60);

    private readonly Channel<(SpotTick Tick, long EnqueuedAt)> _channel;
    private readonly Action<SpotTick> _handler;
    private readonly ILogger _logger;
    private readonly CancellationTokenSource _stop = new();
    private readonly Task _worker;

    private readonly object _statsLock = new();
    private long _processed;
    private long _dropped;
    private DateTimeOffset _windowStart = DateTimeOffset.UtcNow;
    private double _windowMaxHandlerMs, _previousMaxHandlerMs;
    private double _windowMaxWaitMs, _previousMaxWaitMs;
    private long _lastErrorLoggedAt;

    public TickConsumerQueue(string name, Action<SpotTick> handler, ILogger logger, bool startWorker = true)
    {
        Name = name;
        _handler = handler;
        _logger = logger;
        _channel = Channel.CreateBounded<(SpotTick, long)>(
            new BoundedChannelOptions(Capacity) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true, SingleWriter = false },
            _ => Interlocked.Increment(ref _dropped));
        _worker = startWorker ? Task.Run(RunAsync) : Task.CompletedTask;
    }

    public string Name { get; }

    /// <summary>Called on the receive loop - never blocks.</summary>
    public void Enqueue(SpotTick tick) => _channel.Writer.TryWrite((tick, Stopwatch.GetTimestamp()));

    /// <summary>Processes everything queued so far on the calling thread (tests drive the queue
    /// with startWorker: false).</summary>
    internal void Drain()
    {
        while (_channel.Reader.TryRead(out var item)) Process(item.Tick, item.EnqueuedAt);
    }

    private async Task RunAsync()
    {
        try
        {
            await foreach (var (tick, enqueuedAt) in _channel.Reader.ReadAllAsync(_stop.Token))
                Process(tick, enqueuedAt);
        }
        catch (OperationCanceledException)
        {
        }
    }

    private void Process(SpotTick tick, long enqueuedAt)
    {
        var started = Stopwatch.GetTimestamp();
        try
        {
            _handler(tick);
        }
        catch (Exception ex)
        {
            // One bad tick must never stop this consumer's worker; log at most once a minute.
            var now = Environment.TickCount64;
            if (now - Interlocked.Read(ref _lastErrorLoggedAt) > 60_000)
            {
                Interlocked.Exchange(ref _lastErrorLoggedAt, now);
                _logger.LogError(ex, "Live tick consumer {Consumer} failed on a tick for security {SecurityId}.", Name, tick.SecurityId);
            }
        }
        var finished = Stopwatch.GetTimestamp();
        Record(Stopwatch.GetElapsedTime(enqueuedAt, started).TotalMilliseconds, Stopwatch.GetElapsedTime(started, finished).TotalMilliseconds);
    }

    private void Record(double waitMs, double handlerMs)
    {
        lock (_statsLock)
        {
            RollWindow(DateTimeOffset.UtcNow);
            _processed++;
            _windowMaxWaitMs = Math.Max(_windowMaxWaitMs, waitMs);
            _windowMaxHandlerMs = Math.Max(_windowMaxHandlerMs, handlerMs);
        }
    }

    private void RollWindow(DateTimeOffset now)
    {
        if (now - _windowStart < StatsWindow) return;
        _previousMaxHandlerMs = _windowMaxHandlerMs;
        _previousMaxWaitMs = _windowMaxWaitMs;
        _windowMaxHandlerMs = _windowMaxWaitMs = 0;
        _windowStart = now;
    }

    public TickConsumerStats GetStats()
    {
        lock (_statsLock)
        {
            RollWindow(DateTimeOffset.UtcNow);
            return new TickConsumerStats(
                Name, _channel.Reader.Count, _processed, Interlocked.Read(ref _dropped),
                Math.Round(Math.Max(_windowMaxHandlerMs, _previousMaxHandlerMs), 1),
                Math.Round(Math.Max(_windowMaxWaitMs, _previousMaxWaitMs), 1));
        }
    }

    public void Dispose()
    {
        _channel.Writer.TryComplete();
        _stop.Cancel();
        try { _worker.Wait(TimeSpan.FromSeconds(2)); } catch { /* stopping anyway */ }
        _stop.Dispose();
    }
}

/// <summary>QueueWaitMaxMs: the longest any tick sat in the queue before its consumer got to it
/// (roughly the last minute) - how far behind live that consumer has been. HandlerMaxMs: the slowest
/// single tick it processed.</summary>
public sealed record TickConsumerStats(
    string Name, int Queued, long Processed, long Dropped, double HandlerMaxMs, double QueueWaitMaxMs);

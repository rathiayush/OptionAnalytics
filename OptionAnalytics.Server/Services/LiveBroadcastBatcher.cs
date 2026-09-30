using Microsoft.AspNetCore.SignalR;
using OptionAnalytics.Server.Hubs;

namespace OptionAnalytics.Server.Services;

/// <summary>An accumulated live entry that knows how to fold an OLDER entry for the same key into
/// itself (keep the older open, widen high/low) - so skipping sends never loses a price extreme.</summary>
public interface ILiveMergeable
{
    ILiveMergeable MergeAfter(ILiveMergeable older);
}

/// <summary>
/// Delivers every high-frequency live push (spot, option legs, futures, CDV) as CONFLATED state:
/// each browser only ever gets the LATEST data, never a queue of stale updates.
///
/// Why: Dhan delivers 100+ ticks a second. Pushing each one straight to every browser meant a
/// phone on a weak connection (or a busy page) fell behind, and because the server kept writing,
/// the backlog sat in network buffers - the screen then showed data that was 10s, 20s, a minute
/// old, and got worse the longer the session ran.
///
/// How (the standard market-data "conflation" approach):
///  1. Ticks update pending state immediately (SetLatest / Accumulate) - no network work per tick.
///  2. Every FlushInterval that state is folded into each subscribed connection's own outbox, where
///     newer values simply replace older ones (merged, for accumulated entries).
///  3. A connection is sent its outbox as one "liveBatch" message only once it has ACKNOWLEDGED the
///     previous one (SpotHub.AckLive, which the browser calls after applying it). A slow connection
///     therefore just skips intermediate states and gets the newest picture next time - at most one
///     batch is ever in flight, so lag cannot build up anywhere between here and the screen. AckTimeout
///     keeps a connection that lost an ack (or an older page that never sends one) from stalling.
/// </summary>
public sealed class LiveBroadcastBatcher : BackgroundService
{
    public static readonly TimeSpan FlushInterval = TimeSpan.FromMilliseconds(300);
    public static readonly TimeSpan AckTimeout = TimeSpan.FromSeconds(5);

    private readonly IHubContext<SpotHub>? _hub;
    private readonly ILogger<LiveBroadcastBatcher> _logger;
    private readonly object _lock = new();

    // Pending since the last flush, per group.
    private Dictionary<(string Group, string Event, string Key), Func<object>> _latest = new();
    private Dictionary<(string Group, string Event), Dictionary<string, ILiveMergeable>> _accumulated = new();

    private readonly Dictionary<string, Outbox> _outboxes = new();
    private readonly Dictionary<string, HashSet<string>> _members = new();

    public LiveBroadcastBatcher(IHubContext<SpotHub>? hub, ILogger<LiveBroadcastBatcher> logger)
    {
        _hub = hub;
        _logger = logger;
    }

    public void SetLatest(string group, string eventName, string key, Func<object> payloadFactory)
    {
        lock (_lock) _latest[(group, eventName, key)] = payloadFactory;
    }

    public void Accumulate(string group, string eventName, string key, ILiveMergeable entry)
    {
        lock (_lock)
        {
            if (!_accumulated.TryGetValue((group, eventName), out var entries))
                _accumulated[(group, eventName)] = entries = new Dictionary<string, ILiveMergeable>();
            entries[key] = entries.TryGetValue(key, out var older) ? entry.MergeAfter(older) : entry;
        }
    }

    /// <summary>Whether any connection has joined <paramref name="group"/> - lets a producer skip
    /// building a payload nobody will receive.</summary>
    public bool HasMembers(string group)
    {
        lock (_lock) return _members.ContainsKey(group);
    }

    public void Join(string connectionId, string group)
    {
        lock (_lock)
        {
            OutboxFor(connectionId).Groups.Add(group);
            if (!_members.TryGetValue(group, out var members)) _members[group] = members = new HashSet<string>();
            members.Add(connectionId);
        }
    }

    public void Leave(string connectionId, string group)
    {
        lock (_lock)
        {
            if (_outboxes.TryGetValue(connectionId, out var outbox)) outbox.Groups.Remove(group);
            if (_members.TryGetValue(group, out var members) && members.Remove(connectionId) && members.Count == 0) _members.Remove(group);
        }
    }

    public void Disconnected(string connectionId)
    {
        lock (_lock)
        {
            if (!_outboxes.Remove(connectionId, out var outbox)) return;
            foreach (var group in outbox.Groups)
                if (_members.TryGetValue(group, out var members) && members.Remove(connectionId) && members.Count == 0) _members.Remove(group);
        }
    }

    /// <summary>The browser has applied batch <paramref name="sequence"/> - it may be sent the next one.
    /// An ack for anything but the batch currently awaited (a stale or duplicate ack) is ignored.</summary>
    public void Ack(string connectionId, long sequence)
    {
        lock (_lock)
        {
            if (_outboxes.TryGetValue(connectionId, out var outbox) && outbox.AwaitingSequence == sequence)
                outbox.AwaitingSequence = null;
        }
    }

    /// <summary>One flush: fold everything pending into each subscribed connection's outbox, then take
    /// the batches for every connection that is free to receive one. Separate from the timer and
    /// SignalR so a test can drive it directly.</summary>
    internal IReadOnlyList<(string ConnectionId, LiveBatch Batch)> Flush(DateTimeOffset now)
    {
        Dictionary<(string Group, string Event, string Key), Func<object>> latest;
        Dictionary<(string Group, string Event), Dictionary<string, ILiveMergeable>> accumulated;
        lock (_lock)
        {
            latest = _latest;
            accumulated = _accumulated;
            _latest = new();
            _accumulated = new();
            // Nobody subscribed to a group (e.g. no Dashboard open for a non-default expiry's CDV):
            // don't build its payload at all - the factories read other services' state under their
            // locks, the same locks the Dhan receive thread takes on every tick.
            foreach (var id in latest.Keys.Where(id => !_members.ContainsKey(id.Group)).ToList()) latest.Remove(id);
        }

        // Payloads are built outside the lock - the factories read other services' state.
        var built = new List<((string Group, string Event, string Key) Id, object Payload)>(latest.Count);
        foreach (var (id, factory) in latest)
        {
            try { built.Add((id, factory())); }
            catch (Exception ex) { _logger.LogDebug(ex, "Live broadcast: building a {Event} payload failed.", id.Event); }
        }

        var ready = new List<(string, LiveBatch)>();
        lock (_lock)
        {
            foreach (var (id, payload) in built)
            {
                if (!_members.TryGetValue(id.Group, out var members)) continue;
                foreach (var connectionId in members) _outboxes[connectionId].Latest[id] = payload;
            }

            foreach (var ((group, eventName), entries) in accumulated)
            {
                if (!_members.TryGetValue(group, out var members)) continue;
                foreach (var connectionId in members)
                {
                    var pending = _outboxes[connectionId].Accumulated;
                    if (!pending.TryGetValue((group, eventName), out var target))
                        pending[(group, eventName)] = target = new Dictionary<string, ILiveMergeable>();
                    foreach (var (key, entry) in entries)
                        target[key] = target.TryGetValue(key, out var older) ? entry.MergeAfter(older) : entry;
                }
            }

            foreach (var (connectionId, outbox) in _outboxes)
            {
                if (outbox.Latest.Count == 0 && outbox.Accumulated.Count == 0) continue;
                if (outbox.AwaitingSequence is not null && now - outbox.SentAt < AckTimeout) continue;

                var items = new List<LiveBatchItem>(outbox.Latest.Count + outbox.Accumulated.Count);
                foreach (var ((_, eventName, _), payload) in outbox.Latest) items.Add(new LiveBatchItem(eventName, payload));
                foreach (var ((_, eventName), entries) in outbox.Accumulated) items.Add(new LiveBatchItem(eventName, entries.Values.Cast<object>().ToList()));
                outbox.Latest.Clear();
                outbox.Accumulated.Clear();

                var sequence = ++outbox.Sequence;
                outbox.AwaitingSequence = sequence;
                outbox.SentAt = now;
                ready.Add((connectionId, new LiveBatch(sequence, now, items)));
            }
        }
        return ready;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(FlushInterval);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                // Not awaited per connection: each connection has at most one batch in flight (the
                // ack gate above), so a slow one can never hold up anyone else's delivery.
                foreach (var (connectionId, batch) in Flush(DateTimeOffset.UtcNow))
                    _ = SendAsync(connectionId, batch);
            }
        }
        catch (OperationCanceledException)
        {
        }
    }

    private async Task SendAsync(string connectionId, LiveBatch batch)
    {
        try
        {
            await _hub!.Clients.Client(connectionId).SendAsync("liveBatch", batch);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Live broadcast: sending a batch to {ConnectionId} failed.", connectionId);
        }
    }

    private Outbox OutboxFor(string connectionId)
    {
        if (!_outboxes.TryGetValue(connectionId, out var outbox)) _outboxes[connectionId] = outbox = new Outbox();
        return outbox;
    }

    private sealed class Outbox
    {
        public HashSet<string> Groups { get; } = new();
        public Dictionary<(string Group, string Event, string Key), object> Latest { get; } = new();
        public Dictionary<(string Group, string Event), Dictionary<string, ILiveMergeable>> Accumulated { get; } = new();
        public long Sequence { get; set; }
        public long? AwaitingSequence { get; set; }
        public DateTimeOffset SentAt { get; set; }
    }
}

/// <summary>What one connection receives per flush: every live event that changed since its last
/// batch, newest values only. The browser acks Sequence once applied, and measures how far behind it
/// is showing things from SentAtUtc (compared at paint time, so slow rendering counts too).</summary>
public sealed record LiveBatch(long Sequence, DateTimeOffset SentAtUtc, IReadOnlyList<LiveBatchItem> Items);

/// <summary>One event inside a batch - E is the event name the page already handles (spotUpdate,
/// cdvUpdate, oiReplayTicks, ...), D its payload. Typed object (and accumulated entries listed as
/// object) on purpose: System.Text.Json serializes object-typed values by their runtime type, where
/// the ILiveMergeable interface type would serialize as an empty {}.</summary>
public sealed record LiveBatchItem(string E, object D);

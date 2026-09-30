using Microsoft.AspNetCore.SignalR;
using OptionAnalytics.Server.Hubs;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Coalesces high-frequency live pushes and sends them to SignalR on a fixed cadence
/// (FlushInterval) instead of once per Dhan tick. Dhan delivers a Full packet for every change on
/// every subscribed strike - 100+ a second across a strike band - and pushing each one as its own
/// SignalR message made every browser parse and apply each one individually, which is what let a
/// page fall behind the feed. Here every tick still updates the pending state immediately; the
/// browser just receives the result at most once per FlushInterval per (group, event), so a page
/// is never more than ~FlushInterval behind and never has more work than it can keep up with.
///
/// Two shapes:
///  - SetLatest: only the newest value matters (a snapshot of cumulative state, e.g. CDV). The
///    factory runs at FLUSH time, not per tick, so building the snapshot costs nothing extra on the
///    Dhan receive thread no matter how fast ticks arrive.
///  - Accumulate: several independent keys per message (one entry per option leg), each folded with
///    a caller-supplied merge so nothing a coarser cadence would lose (a price's high/low inside the
///    window) is dropped. Sent as one array per (group, event).
/// </summary>
public sealed class LiveBroadcastBatcher : BackgroundService
{
    public static readonly TimeSpan FlushInterval = TimeSpan.FromMilliseconds(300);

    private readonly IHubContext<SpotHub> _hub;
    private readonly ILogger<LiveBroadcastBatcher> _logger;
    private readonly object _lock = new();

    private Dictionary<(string Group, string Event, string Key), Func<object>> _latest = new();
    private Dictionary<(string Group, string Event), Dictionary<string, object>> _accumulated = new();

    public LiveBroadcastBatcher(IHubContext<SpotHub> hub, ILogger<LiveBroadcastBatcher> logger)
    {
        _hub = hub;
        _logger = logger;
    }

    public void SetLatest(string group, string eventName, string key, Func<object> payloadFactory)
    {
        lock (_lock) _latest[(group, eventName, key)] = payloadFactory;
    }

    public void Accumulate<T>(string group, string eventName, string key, Func<T?, T> merge) where T : class
    {
        lock (_lock)
        {
            if (!_accumulated.TryGetValue((group, eventName), out var entries))
                _accumulated[(group, eventName)] = entries = new Dictionary<string, object>();
            entries[key] = merge(entries.TryGetValue(key, out var existing) ? existing as T : null);
        }
    }

    /// <summary>Everything pending, cleared - separated from the send so a test can drive it
    /// without SignalR or a timer.</summary>
    internal IReadOnlyList<(string Group, string Event, object Payload)> Drain()
    {
        Dictionary<(string Group, string Event, string Key), Func<object>> latest;
        Dictionary<(string Group, string Event), Dictionary<string, object>> accumulated;
        lock (_lock)
        {
            if (_latest.Count == 0 && _accumulated.Count == 0) return Array.Empty<(string, string, object)>();
            latest = _latest;
            accumulated = _accumulated;
            _latest = new();
            _accumulated = new();
        }

        var messages = new List<(string, string, object)>(latest.Count + accumulated.Count);
        foreach (var ((group, eventName, _), factory) in latest)
        {
            try { messages.Add((group, eventName, factory())); }
            catch (Exception ex) { _logger.LogDebug(ex, "Live broadcast: building a {Event} payload failed.", eventName); }
        }
        foreach (var ((group, eventName), entries) in accumulated)
            messages.Add((group, eventName, entries.Values.ToList()));
        return messages;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(FlushInterval);
        try
        {
            // Awaited before the next flush on purpose: a slow client backs this loop up, and
            // everything that ticks meanwhile simply coalesces into the next flush (latest wins)
            // instead of piling up as an unbounded queue of stale messages.
            while (await timer.WaitForNextTickAsync(stoppingToken))
                await Task.WhenAll(Drain().Select(m => SendAsync(m.Group, m.Event, m.Payload, stoppingToken)));
        }
        catch (OperationCanceledException)
        {
        }
    }

    private async Task SendAsync(string group, string eventName, object payload, CancellationToken cancellationToken)
    {
        try
        {
            await _hub.Clients.Group(group).SendAsync(eventName, payload, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogDebug(ex, "Live broadcast: sending {Event} to {Group} failed.", eventName, group);
        }
    }
}

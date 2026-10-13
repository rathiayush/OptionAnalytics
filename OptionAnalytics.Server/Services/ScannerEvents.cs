using System.Text.Json.Nodes;
using Microsoft.AspNetCore.SignalR;
using OptionAnalytics.Server.Hubs;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Tells every open page the moment the server scanner's trades change, so its paper and live trades and their P&amp;L
/// show at once instead of at the page's next poll. Plain SpotHub group events (not the conflated live batch - they are
/// few, and each one matters):
///  - "scannerStatus" (group "scanner"): what the runner just reported, in GET /api/scanner-runner/status's shape -
///    today's signals and paper / live option trades per index with their premium now and P&amp;L. Sent when they differ
///    from what was last sent (the runner reports at once on a new trade or an exit, else every 5 s with the P&amp;L),
///    and at least every 30 s.
///  - "scannerRecord" (group "scanner"): a day of the scanner's record was saved (server-signals / server-trades.csv, or
///    the pages' signals / trades.csv) - {source, underlying, date}; the record views read it again.
///  - "scannerLive" (admin-only group "scanner-live"): a server scanner live trade changed (placed, legs moved, closed,
///    settled from Dhan's fills) or an index was switched Live / paper - the Live today views read GET
///    /api/scanner-runner/live again.
/// Polling stays on the pages as the fallback; a send that fails is logged, never thrown.
/// </summary>
public sealed class ScannerEvents
{
    public const string Group = "scanner";
    public const string LiveGroup = "scanner-live";
    /// <summary>The status is sent at least this often even when nothing in it changed (the page's "reported" time).</summary>
    internal static readonly TimeSpan StatusHeartbeat = TimeSpan.FromSeconds(30);

    private readonly Func<string, string, object, Task> _send;
    private readonly ILogger<ScannerEvents> _logger;
    private readonly Func<DateTimeOffset> _now;
    private readonly object _lock = new();
    private string? _lastStatus;
    private DateTimeOffset _lastStatusAt;

    public ScannerEvents(IHubContext<SpotHub> hub, ILogger<ScannerEvents> logger)
        : this((group, name, payload) => hub.Clients.Group(group).SendAsync(name, payload), logger) { }

    internal ScannerEvents(Func<string, string, object, Task> send, ILogger<ScannerEvents> logger, Func<DateTimeOffset>? now = null)
    {
        _send = send;
        _logger = logger;
        _now = now ?? (() => DateTimeOffset.UtcNow);
    }

    /// <summary>The runner's report (<paramref name="reported"/>, as it posted it) is in; <paramref name="status"/> is what
    /// GET /status now gives. Sent when its signals / trades / P&amp;L changed, or the heartbeat is due.</summary>
    public void Status(JsonNode reported, object status)
    {
        var fingerprint = Fingerprint(reported);
        lock (_lock)
        {
            var now = _now();
            if (fingerprint == _lastStatus && now - _lastStatusAt < StatusHeartbeat) return;
            _lastStatus = fingerprint;
            _lastStatusAt = now;
        }
        Send(Group, "scannerStatus", status);
    }

    /// <summary>A day of the record was saved.</summary>
    public void Record(string? source, string? underlying, string? date) =>
        Send(Group, "scannerRecord", new { source = string.IsNullOrWhiteSpace(source) ? "page" : source, underlying, date });

    /// <summary>A server scanner live trade, or an index's Live today, changed.</summary>
    public void Live() => Send(LiveGroup, "scannerLive", new { atUtc = _now() });

    /// <summary>What a page shows of a report: per index its state, signals, trades and P&amp;L - not the runner's clock,
    /// which moves on every report.</summary>
    internal static string Fingerprint(JsonNode reported) =>
        string.Join("\n", (reported["indices"] as JsonArray ?? new JsonArray()).Select(ix => ix is null ? "" : string.Join("|",
            ix["underlying"]?.ToJsonString(), ix["enabled"]?.ToJsonString(), ix["ready"]?.ToJsonString(), ix["error"]?.ToJsonString(),
            ix["pnl"]?.ToJsonString(), ix["signals"]?.ToJsonString(), ix["trades"]?.ToJsonString())));

    private void Send(string group, string name, object payload)
    {
        try
        {
            _send(group, name, payload).ContinueWith(t => _logger.LogDebug(t.Exception, "{Event} not sent.", name), TaskContinuationOptions.OnlyOnFaulted);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "{Event} not sent.", name);
        }
    }
}

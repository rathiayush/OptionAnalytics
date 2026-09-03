using System.Text.Json;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Every order-pipeline outcome StrategyTriggerHostedService.NotifyFollowUpAsync has sent to
/// Telegram - placements, fills, re-prices, cancels, failures, skips - kept here too so the Triggers
/// page can answer "did this actually place an order, and what happened to it" without depending on
/// catching that Telegram message (easy to miss, and tells you nothing once it has scrolled past).
///
/// Same JSON-file-backed pattern as StrategyTriggerStore, but this is an activity LOG rather than
/// configuration: it only needs to answer "what happened recently", so it is capped (MaxEvents)
/// instead of growing forever.
/// </summary>
public sealed class TriggerOrderHistoryStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    /// <summary>Kept across ALL triggers combined, not per-trigger - a busy day with several armed
    /// triggers should not let one trigger's chatter push another's out of the file, but the file
    /// still needs a ceiling. Comfortably covers a full trading day's worth of placements/re-prices/
    /// fills for several triggers at once; GetRecent's own limit is what the page actually renders.</summary>
    private const int MaxEvents = 1000;

    private readonly string _path;
    private readonly ILogger<TriggerOrderHistoryStore> _logger;
    private readonly object _lock = new();
    private readonly List<TriggerOrderEvent> _events = new();

    public TriggerOrderHistoryStore(IHostEnvironment environment, IConfiguration configuration, ILogger<TriggerOrderHistoryStore> logger)
    {
        // Same override pattern as StrategyTriggerStore.Path - Storage:OrderHistoryPath (env var
        // Storage__OrderHistoryPath) points this at the mounted volume in a container, otherwise a
        // redeploy would silently discard the log. See docker-compose.yml.
        var configured = configuration["Storage:OrderHistoryPath"];
        _path = string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(environment.ContentRootPath, "trigger-order-history.json")
            : configured;
        _logger = logger;

        var directory = Path.GetDirectoryName(_path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        Load();
    }

    /// <summary>Appends one event and trims the oldest once MaxEvents is exceeded. Status is
    /// extracted from <paramref name="message"/>'s own leading "[TAG]" here, rather than asked of
    /// every NotifyFollowUpAsync call site - that method already has the fully composed message and
    /// nothing else needs to know the tag convention.</summary>
    public void Record(string triggerId, string triggerName, string message)
    {
        var evt = new TriggerOrderEvent(Guid.NewGuid().ToString("n")[..12], triggerId, triggerName, DateTimeOffset.UtcNow, ExtractStatus(message), message);

        lock (_lock)
        {
            _events.Add(evt);
            while (_events.Count > MaxEvents) _events.RemoveAt(0);
            SaveNoLock();
        }
    }

    /// <summary>Most recent first, optionally filtered to one trigger - what the Triggers page's
    /// order history panel reads.</summary>
    public IReadOnlyList<TriggerOrderEvent> GetRecent(string? triggerId, int limit)
    {
        lock (_lock)
        {
            IEnumerable<TriggerOrderEvent> query = _events;
            if (!string.IsNullOrWhiteSpace(triggerId)) query = query.Where(e => e.TriggerId == triggerId);
            return query.Reverse().Take(Math.Max(1, limit)).ToList();
        }
    }

    private static string ExtractStatus(string message)
    {
        var end = message.IndexOf(']');
        return message.StartsWith('[') && end > 0 ? message[1..end] : "UNKNOWN";
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_path)) return;

            var stored = JsonSerializer.Deserialize<List<TriggerOrderEvent>>(File.ReadAllText(_path));
            if (stored is null) return;

            _events.AddRange(stored);
            _logger.LogInformation("Loaded {Count} trigger order event(s) from {Path}.", _events.Count, _path);
        }
        catch (Exception ex)
        {
            // A corrupt or unreadable file must not stop the app booting - it just starts with no
            // history, and the next Record rewrites the file cleanly.
            _logger.LogError(ex, "Could not read trigger order history from {Path} - starting with none.", _path);
        }
    }

    private void SaveNoLock()
    {
        try
        {
            File.WriteAllText(_path, JsonSerializer.Serialize(_events, JsonOptions));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not save trigger order history to {Path}.", _path);
        }
    }
}

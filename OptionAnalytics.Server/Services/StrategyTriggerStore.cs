using System.Text.Json;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Holds the configured strategy triggers, backed by a small JSON file next to the app.
///
/// Everything else in this app is deliberately in-memory and re-fetched from Dhan on each restart
/// (see SpotFeedHostedService) - but triggers are CONFIGURATION rather than market data. Losing the
/// rules you tuned every time the process restarts would make the feature useless, so these alone
/// are persisted. It is a plain JSON file rather than a database because that is all this needs:
/// a handful of small records, written on change, read once at startup.
/// </summary>
public sealed class StrategyTriggerStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    private readonly string _path;
    private readonly ILogger<StrategyTriggerStore> _logger;
    private readonly object _lock = new();
    private readonly Dictionary<string, StrategyTrigger> _triggers = new();

    public StrategyTriggerStore(IHostEnvironment environment, IConfiguration configuration, ILogger<StrategyTriggerStore> logger)
    {
        // Next to the app by default, which is what a local run wants. In a container the content
        // root is the image's own read-only-ish app directory, so Storage:TriggersPath (env var
        // Storage__TriggersPath) points this at a mounted volume instead - otherwise every redeploy
        // would silently discard the armed triggers. See docker-compose.yml.
        var configured = configuration["Storage:TriggersPath"];
        _path = string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(environment.ContentRootPath, "strategy-triggers.json")
            : configured;
        _logger = logger;

        var directory = Path.GetDirectoryName(_path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        Load();
    }

    public IReadOnlyList<StrategyTrigger> GetAll()
    {
        lock (_lock) { return _triggers.Values.OrderBy(t => t.CreatedUtc).ToList(); }
    }

    public StrategyTrigger? Find(string id)
    {
        lock (_lock) { return _triggers.GetValueOrDefault(id); }
    }

    public StrategyTrigger Create(StrategyTriggerRequest request)
    {
        var trigger = new StrategyTrigger(
            Guid.NewGuid().ToString("n")[..12],
            string.IsNullOrWhiteSpace(request.Name) ? $"{request.Underlying} {request.StrategyKey}" : request.Name.Trim(),
            request.Underlying.ToUpperInvariant(),
            request.StrategyKey,
            Math.Max(1, request.TimeframeMinutes),
            request.Parameters ?? new Dictionary<string, decimal>(),
            request.Enabled,
            DateTimeOffset.UtcNow)
        {
            LiveTradingEnabled = request.LiveTradingEnabled,
            QuantityLots = Math.Max(1, request.QuantityLots),
            SlippagePoints = Math.Max(0, request.SlippagePoints),
            MaxDeviationPercent = request.MaxDeviationPercent > 0 ? request.MaxDeviationPercent : 10,
            UseLivePremiumEntry = request.UseLivePremiumEntry,
            OrderExpiry = request.OrderExpiry,
            AdjustStopLossOnOpenPosition = request.AdjustStopLossOnOpenPosition,
            HedgeOtmSteps = Math.Max(0, request.HedgeOtmSteps),
            HedgeMinOpenInterestPercent = ClampHedgeMinOpenInterestPercent(request.HedgeMinOpenInterestPercent),
        };

        lock (_lock)
        {
            _triggers[trigger.Id] = trigger;
            SaveNoLock();
        }
        return trigger;
    }

    public StrategyTrigger? Update(string id, StrategyTriggerRequest request)
    {
        lock (_lock)
        {
            if (!_triggers.TryGetValue(id, out var existing)) return null;

            // Changing what a trigger watches invalidates where it had got to, so the signal
            // pointer is dropped and the next evaluation re-primes it - otherwise a trigger
            // re-pointed at a different strategy could immediately fire on that strategy's backlog.
            var watchChanged = existing.Underlying != request.Underlying.ToUpperInvariant()
                || existing.StrategyKey != request.StrategyKey
                || existing.TimeframeMinutes != Math.Max(1, request.TimeframeMinutes)
                || !ParametersEqual(existing.Parameters, request.Parameters);

            var updated = existing with
            {
                Name = string.IsNullOrWhiteSpace(request.Name) ? existing.Name : request.Name.Trim(),
                Underlying = request.Underlying.ToUpperInvariant(),
                StrategyKey = request.StrategyKey,
                TimeframeMinutes = Math.Max(1, request.TimeframeMinutes),
                Parameters = request.Parameters ?? new Dictionary<string, decimal>(),
                Enabled = request.Enabled,
                LiveTradingEnabled = request.LiveTradingEnabled,
                QuantityLots = Math.Max(1, request.QuantityLots),
                SlippagePoints = Math.Max(0, request.SlippagePoints),
                MaxDeviationPercent = request.MaxDeviationPercent > 0 ? request.MaxDeviationPercent : 10,
                UseLivePremiumEntry = request.UseLivePremiumEntry,
                // Deliberately NOT part of watchChanged: this only decides which contract an order
                // is placed in, never which signals the trigger watches, so re-pointing it must not
                // throw away where the trigger had got to and re-prime it.
                OrderExpiry = request.OrderExpiry,
                AdjustStopLossOnOpenPosition = request.AdjustStopLossOnOpenPosition,
                HedgeOtmSteps = Math.Max(0, request.HedgeOtmSteps),
                HedgeMinOpenInterestPercent = ClampHedgeMinOpenInterestPercent(request.HedgeMinOpenInterestPercent),
                LastSignalUtc = watchChanged ? null : existing.LastSignalUtc,
            };

            _triggers[id] = updated;
            SaveNoLock();
            return updated;
        }
    }

    public bool Delete(string id)
    {
        lock (_lock)
        {
            if (!_triggers.Remove(id)) return false;
            SaveNoLock();
            return true;
        }
    }

    /// <summary>Records how far a trigger has been evaluated. <paramref name="firedSummary"/> is
    /// null when this was only a re-prime (arming, or catching up) rather than a real alert.</summary>
    public void MarkEvaluated(string id, DateTimeOffset lastSignalUtc, string? firedSummary)
    {
        lock (_lock)
        {
            if (!_triggers.TryGetValue(id, out var existing)) return;

            _triggers[id] = existing with
            {
                LastSignalUtc = lastSignalUtc,
                LastFiredUtc = firedSummary is null ? existing.LastFiredUtc : DateTimeOffset.UtcNow,
                LastFiredSummary = firedSummary ?? existing.LastFiredSummary,
            };
            SaveNoLock();
        }
    }

    /// <summary>Records (or clears, passing null) which Dhan order this trigger is currently
    /// responsible for - see StrategyTrigger.LastOrderId's own doc comment for who reads this and
    /// why.</summary>
    public void SetLastOrderId(string id, string? orderId)
    {
        lock (_lock)
        {
            if (!_triggers.TryGetValue(id, out var existing)) return;

            _triggers[id] = existing with { LastOrderId = orderId };
            SaveNoLock();
        }
    }

    /// <summary>Records (or clears, passing null) which Dhan order this trigger's PROTECTIVE hedge
    /// leg is currently open under - SetLastOrderId's own counterpart, for StrategyTrigger.
    /// LastHedgeOrderId.</summary>
    public void SetLastHedgeOrderId(string id, string? orderId)
    {
        lock (_lock)
        {
            if (!_triggers.TryGetValue(id, out var existing)) return;

            _triggers[id] = existing with { LastHedgeOrderId = orderId };
            SaveNoLock();
        }
    }

    /// <summary>Keeps StrategyTrigger.HedgeMinOpenInterestPercent inside 0-100, preserving null
    /// (= "use the default") rather than collapsing it to 0 (= "check disabled"), since those two
    /// mean opposite things. A negative value is a nonsense threshold rather than a disable switch -
    /// 0 already says that explicitly - so it clamps up to 0 the same way every other field here
    /// clamps rather than being rejected.</summary>
    private static int? ClampHedgeMinOpenInterestPercent(int? percent) =>
        percent is null ? null : Math.Clamp(percent.Value, 0, 100);

    private static bool ParametersEqual(IReadOnlyDictionary<string, decimal> a, IReadOnlyDictionary<string, decimal>? b)
    {
        if (b is null) return a.Count == 0;
        if (a.Count != b.Count) return false;
        return a.All(kv => b.TryGetValue(kv.Key, out var v) && v == kv.Value);
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_path)) return;

            var stored = JsonSerializer.Deserialize<List<StrategyTrigger>>(File.ReadAllText(_path));
            if (stored is null) return;

            foreach (var trigger in stored) _triggers[trigger.Id] = trigger;
            _logger.LogInformation("Loaded {Count} strategy trigger(s) from {Path}.", _triggers.Count, _path);
        }
        catch (Exception ex)
        {
            // A corrupt or unreadable file must not stop the app booting - it just starts with no
            // triggers, and the next save rewrites the file cleanly.
            _logger.LogError(ex, "Could not read strategy triggers from {Path} - starting with none.", _path);
        }
    }

    private void SaveNoLock()
    {
        try
        {
            File.WriteAllText(_path, JsonSerializer.Serialize(_triggers.Values.ToList(), JsonOptions));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not save strategy triggers to {Path}.", _path);
        }
    }
}

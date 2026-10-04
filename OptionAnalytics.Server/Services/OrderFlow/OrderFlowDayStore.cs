using System.Collections.Concurrent;

namespace OptionAnalytics.Server.Services.OrderFlow;

/// <summary>
/// The past order flow days the Order Flow page can replay EXACTLY, kept IN MEMORY only - nothing is
/// written to disk, so a restart clears them. Today is always replayable straight from the live
/// engine; this holds the days before it, handed over by OrderFlowService when an engine rolls into a
/// new day (or is replaced at a futures rollover). The newest OrderFlow:DaysInMemory days (default 3)
/// are kept per contract. A day that is not here is rebuilt from Dhan's 1-minute candles instead (an
/// estimate - see OrderFlowEstimator).
///
/// Add(OrderFlowDay) is also the way in for days kept anywhere else: anything that can produce an
/// OrderFlowDay (OrderFlowEngine.ExportDay's shape) can make it replayable.
/// </summary>
public sealed class OrderFlowDayStore
{
    private readonly int _maxDays;
    // Per contract: "{UNDERLYING}:{securityId}".
    private readonly ConcurrentDictionary<string, SortedDictionary<DateOnly, OrderFlowEngine>> _days = new(StringComparer.OrdinalIgnoreCase);

    public OrderFlowDayStore(IConfiguration? configuration = null)
    {
        _maxDays = Math.Clamp(configuration?.GetValue("OrderFlow:DaysInMemory", 3) ?? 3, 0, 30);
    }

    private static string Key(string underlying, uint securityId) => $"{underlying.ToUpperInvariant()}:{securityId}";

    /// <summary>Keeps a finished day for replay, replacing any held for the same contract and date.</summary>
    public void Add(OrderFlowDay day)
    {
        if (_maxDays == 0 || day.Bars.Count == 0 && day.Snapshots.Count == 0) return;
        var days = _days.GetOrAdd(Key(day.Underlying, day.SecurityId), _ => new SortedDictionary<DateOnly, OrderFlowEngine>());
        var engine = OrderFlowEngine.FromDay(day);
        lock (days)
        {
            days[day.Day] = engine;
            while (days.Count > _maxDays) days.Remove(days.Keys.First());
        }
        EvictOlderDates();
    }

    /// <summary>Keeps only the newest DaysInMemory trading dates across EVERY contract: per-contract
    /// limits alone would keep an expired contract's last days forever (a new futures contract gets a
    /// new key each month), growing the server's memory month after month.</summary>
    private void EvictOlderDates()
    {
        var keep = _days.Values.SelectMany(d => { lock (d) return d.Keys.ToList(); }).Distinct().OrderByDescending(d => d).Take(_maxDays).ToHashSet();
        foreach (var (key, days) in _days)
        {
            lock (days)
            {
                foreach (var date in days.Keys.Where(d => !keep.Contains(d)).ToList()) days.Remove(date);
                if (days.Count == 0) _days.TryRemove(key, out _);
            }
        }
    }

    public OrderFlowEngine? EngineFor(string underlying, uint securityId, DateOnly date)
    {
        if (!_days.TryGetValue(Key(underlying, securityId), out var days)) return null;
        lock (days) return days.TryGetValue(date, out var engine) ? engine : null;
    }

    /// <summary>The days held for an underlying (every contract), newest first.</summary>
    public IReadOnlyList<(DateOnly Date, string ContractSymbol, DateOnly? Expiry)> Days(string underlying)
    {
        var prefix = underlying.ToUpperInvariant() + ":";
        var result = new List<(DateOnly, string, DateOnly?)>();
        foreach (var (key, days) in _days)
        {
            if (!key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
            lock (days) result.AddRange(days.Select(kv => (kv.Key, kv.Value.ContractSymbol, kv.Value.Expiry)));
        }
        return result.OrderByDescending(d => d.Item1).ToList();
    }
}

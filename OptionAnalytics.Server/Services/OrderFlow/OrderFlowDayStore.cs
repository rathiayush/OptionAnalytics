using System.Collections.Concurrent;

namespace OptionAnalytics.Server.Services.OrderFlow;

/// <summary>
/// The past order flow days the Order Flow page can replay, kept IN MEMORY only - nothing is written
/// to disk, so a restart clears them. Today is always replayable straight from the live engine; this
/// holds the days before it, handed over by OrderFlowService when an engine rolls into a new day (or
/// is replaced at a futures rollover). The newest OrderFlow:DaysInMemory days (default 3) are kept per
/// underlying.
///
/// Add(OrderFlowDay) is also the way in for days kept anywhere else: anything that can produce an
/// OrderFlowDay (OrderFlowEngine.ExportDay's shape) can make it replayable.
/// </summary>
public sealed class OrderFlowDayStore
{
    private readonly int _maxDays;
    private readonly ConcurrentDictionary<string, SortedDictionary<DateOnly, OrderFlowEngine>> _days = new(StringComparer.OrdinalIgnoreCase);

    public OrderFlowDayStore(IConfiguration? configuration = null)
    {
        _maxDays = Math.Clamp(configuration?.GetValue("OrderFlow:DaysInMemory", 3) ?? 3, 0, 30);
    }

    /// <summary>Keeps a finished day for replay, replacing any held for the same underlying and date.</summary>
    public void Add(OrderFlowDay day)
    {
        if (_maxDays == 0 || day.Bars.Count == 0 && day.Snapshots.Count == 0) return;
        var days = _days.GetOrAdd(day.Underlying, _ => new SortedDictionary<DateOnly, OrderFlowEngine>());
        var engine = OrderFlowEngine.FromDay(day);
        lock (days)
        {
            days[day.Day] = engine;
            while (days.Count > _maxDays) days.Remove(days.Keys.First());
        }
    }

    public OrderFlowEngine? EngineFor(string underlying, DateOnly date)
    {
        if (!_days.TryGetValue(underlying, out var days)) return null;
        lock (days) return days.TryGetValue(date, out var engine) ? engine : null;
    }

    /// <summary>The days held for an underlying, newest first.</summary>
    public IReadOnlyList<(DateOnly Date, string ContractSymbol)> Days(string underlying)
    {
        if (!_days.TryGetValue(underlying, out var days)) return Array.Empty<(DateOnly, string)>();
        lock (days) return days.Reverse().Select(kv => (kv.Key, kv.Value.ContractSymbol)).ToList();
    }
}

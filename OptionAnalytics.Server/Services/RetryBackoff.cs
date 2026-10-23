namespace OptionAnalytics.Server.Services;

/// <summary>How long a background timer waits before asking Dhan again after its call failed: `first`, doubling with each
/// failure in a row, at most `max`. Dhan support saw the same failing requests asked again and again ("running in a loop")
/// - a timer that fails must slow down, not keep its normal pace. A page load or a click is never held back; only the
/// timers are. Failures are not cached: the next attempt goes to Dhan.</summary>
public static class RetryBackoff
{
    public static TimeSpan After(int failuresInARow, TimeSpan first, TimeSpan max) =>
        failuresInARow <= 0 ? TimeSpan.Zero : TimeSpan.FromTicks(Math.Min(max.Ticks, first.Ticks << Math.Min(failuresInARow - 1, 20)));
}

/// <summary>Per-key backoff for a timer that asks Dhan for several things (an index each): Due(key) says whether it may
/// ask now, Failed / Succeeded record the answer.</summary>
public sealed class KeyedBackoff(TimeSpan first, TimeSpan max, Func<DateTimeOffset>? clock = null)
{
    private readonly Dictionary<string, (int Failures, DateTimeOffset NextTry)> _state = new(StringComparer.OrdinalIgnoreCase);
    private readonly Func<DateTimeOffset> _clock = clock ?? (() => DateTimeOffset.UtcNow);

    public bool Due(string key) { lock (_state) return !_state.TryGetValue(key, out var s) || _clock() >= s.NextTry; }

    public TimeSpan Failed(string key)
    {
        lock (_state)
        {
            var failures = (_state.TryGetValue(key, out var s) ? s.Failures : 0) + 1;
            var wait = RetryBackoff.After(failures, first, max);
            _state[key] = (failures, _clock() + wait);
            return wait;
        }
    }

    public void Succeeded(string key) { lock (_state) _state.Remove(key); }
}

namespace OptionAnalytics.Server.Services;

/// <summary>
/// TODAY's answer from Dhan for one series (an option strike's day so far, the spot, the futures), reused by
/// every later request for <see cref="Window"/> - page reloads, other tabs and users, another index's seed -
/// instead of asking Dhan again. Dhan's intraday APIs only take whole days, so each ask re-sends the whole day
/// so far (an OI Replay run is 40+ calls), and asking again and again breached Dhan's per-user rate limit.
/// Within the window the page's own live ticks carry the data on. Requests arriving while one is being fetched
/// share it. In memory only; any other day is fetched as before.
/// </summary>
public sealed class TodayFetchShare
{
    public static readonly TimeSpan DefaultWindow = TimeSpan.FromSeconds(60);
    private readonly Dictionary<string, (DateTimeOffset At, Task<object?> Fetch)> _entries = new();
    private readonly object _lock = new();
    private readonly Func<DateTimeOffset> _clock;

    public TodayFetchShare(TimeSpan? window = null, Func<DateTimeOffset>? clock = null)
    {
        Window = window ?? DefaultWindow;
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
    }

    public TimeSpan Window { get; }

    /// <summary>`fetch` for `date` == `today`, shared (see the class comment); any other day is just fetched.
    /// An answer `keep` rejects (empty - an error, nothing yet) is not reused. The shared fetch is not cancelled
    /// by one caller leaving; each caller stops waiting on its own token.</summary>
    public async Task<T> ReuseAsync<T>(string key, DateOnly date, DateOnly today, Func<CancellationToken, Task<T>> fetch, Func<T, bool> keep, CancellationToken cancellationToken) =>
        (await ReuseWithTimeAsync(key, date, today, fetch, keep, cancellationToken)).Value;

    /// <summary>As ReuseAsync, also saying when the answer was fetched; `window` (default <see cref="Window"/>)
    /// how long it is reused - TimeSpan.MaxValue keeps it for the rest of the day (a backfill the live feed's own
    /// bars carry on from).</summary>
    public async Task<(T Value, DateTimeOffset FetchedAt)> ReuseWithTimeAsync<T>(string key, DateOnly date, DateOnly today, Func<CancellationToken, Task<T>> fetch, Func<T, bool> keep, CancellationToken cancellationToken, TimeSpan? window = null)
    {
        if (date != today) return (await fetch(cancellationToken), _clock());
        var reuseFor = window ?? Window;
        var dayKey = $"{date:yyyyMMdd}|";
        var fullKey = dayKey + key;
        Task<object?> task;
        DateTimeOffset at;
        lock (_lock)
        {
            var now = _clock();
            if (!_entries.TryGetValue(fullKey, out var hit) || hit.Fetch.IsFaulted || hit.Fetch.IsCanceled || (hit.Fetch.IsCompleted && now - hit.At >= reuseFor))
            {
                foreach (var old in _entries.Keys.Where(k => !k.StartsWith(dayKey, StringComparison.Ordinal)).ToList()) _entries.Remove(old);
                hit = (now, Boxed(fetch(CancellationToken.None)));
                _entries[fullKey] = hit;
            }
            task = hit.Fetch;
            at = hit.At;
        }
        var value = (T)(await task.WaitAsync(cancellationToken))!;
        if (!keep(value))
            lock (_lock) { if (_entries.TryGetValue(fullKey, out var hit) && hit.Fetch == task) _entries.Remove(fullKey); }
        return (value, at);

        static async Task<object?> Boxed(Task<T> t) => await t;
    }

    /// <summary>Drops every held answer whose key starts with `keyPrefix` - the next ask fetches afresh.</summary>
    public void Invalidate(string keyPrefix)
    {
        lock (_lock)
        {
            foreach (var key in _entries.Keys.Where(k => k[(k.IndexOf('|') + 1)..].StartsWith(keyPrefix, StringComparison.Ordinal)).ToList()) _entries.Remove(key);
        }
    }
}

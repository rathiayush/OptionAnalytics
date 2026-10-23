using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace OptionAnalytics.Server.Dhan;

/// <summary>Dhan's rate-limit categories (https://dhanhq.co/docs/v2/ - Rate Limit): each has its own limits, for the whole
/// account.</summary>
public enum DhanApiCategory
{
    /// <summary>Placing, modifying and cancelling orders (and exiting all positions, which places orders): 10 a second,
    /// 250 a minute, 1000 an hour, 7000 a day.</summary>
    Order,
    /// <summary>Historical / intraday charts, the rolling (expired) option chain, the option chain: 5 a second, 100,000 a day.</summary>
    Data,
    /// <summary>Market quote snapshots (/marketfeed): 1 a second.</summary>
    Quote,
    /// <summary>Everything else - order / super order books, positions, kill switch, P&amp;L exit, profile: 20 a second.</summary>
    NonTrading,
}

/// <summary>
/// The ONE gate every Dhan REST call in this server goes through - DhanApiClient takes a slot here before each request
/// (an auth retry included), so no caller can reach Dhan around it. A singleton: Dhan counts per ACCOUNT, so only one
/// shared instance sees the combined rate.
///
/// Each category is limited on its own - a burst of chart downloads never makes a live order wait, and orders never eat
/// the data budget:
///  - Data: DhanDataApiRateLimiter (evenly spaced, as calls actually go, page loads ahead of background work) and a day
///    cap under Dhan's 100,000;
///  - Order: under 10 in any 1.1 s, 250 a minute, 1000 an hour and 7000 a day. A call waits for the per-second room (well
///    under a second); one that would have to wait out the minute / hour / day limit is NOT sent - it fails at once with
///    the reason, rather than holding a live order for minutes;
///  - Quote: one every 1.1 s; NonTrading: under 20 in any 1.1 s.
/// Limits are kept a little under Dhan's own (a margin for network jitter - Dhan counts calls as they arrive). After Dhan
/// answers "too many requests", that category pauses (NoteRateLimited).
/// </summary>
public sealed class DhanRestRateLimiter
{
    internal const int DataDayLimit = 99_000;
    private readonly DhanDataApiRateLimiter _data;
    private readonly WindowLimiter _orders;
    private readonly WindowLimiter _quotes;
    private readonly WindowLimiter _nonTrading;
    private readonly Func<DateTimeOffset> _clock;
    private readonly object _dayLock = new();
    private DateOnly _dataDay;
    private int _dataToday;

    /// <summary>For the tests: Data API calls counted today (IST).</summary>
    internal int DataToday { get => _dataToday; init => _dataToday = value; }

    public DhanRestRateLimiter(DhanDataApiRateLimiter data) : this(data, () => DateTimeOffset.UtcNow) { }

    internal DhanRestRateLimiter(DhanDataApiRateLimiter data, Func<DateTimeOffset> clock)
    {
        _data = data;
        _clock = clock;
        _dataDay = IstClock.IstDate(clock());
        _orders = new WindowLimiter("order", clock, maxWait: TimeSpan.FromSeconds(2),
            (8, TimeSpan.FromSeconds(1.1), "10 a second"), (240, TimeSpan.FromMinutes(1), "250 a minute"),
            (960, TimeSpan.FromHours(1), "1000 an hour"), (6_900, TimeSpan.FromDays(1), "7000 a day"));
        _quotes = new WindowLimiter("quote", clock, maxWait: null, (1, TimeSpan.FromSeconds(1.1), "1 a second"));
        _nonTrading = new WindowLimiter("non-trading", clock, maxWait: null, (18, TimeSpan.FromSeconds(1.1), "20 a second"));
    }

    /// <summary>A limiter of its own - for a DhanApiClient built without the app's (tests, tools).</summary>
    internal static DhanRestRateLimiter Standalone(IOptions<DhanOptions> options) =>
        new(new DhanDataApiRateLimiter(options, NullLogger<DhanDataApiRateLimiter>.Instance));

    internal DhanDataApiRateLimiter Data => _data;

    /// <summary>Which of Dhan's categories a REST call is.</summary>
    public static DhanApiCategory CategoryOf(HttpMethod method, string path)
    {
        if (DhanApiClient.IsDataApi(path) && !path.StartsWith("/marketfeed", StringComparison.OrdinalIgnoreCase)) return DhanApiCategory.Data;
        if (path.StartsWith("/marketfeed", StringComparison.OrdinalIgnoreCase)) return DhanApiCategory.Quote;
        var changes = method != HttpMethod.Get;
        var orders = path.StartsWith("/orders", StringComparison.OrdinalIgnoreCase)
                     || path.StartsWith("/super/orders", StringComparison.OrdinalIgnoreCase)
                     || path.StartsWith("/forever/orders", StringComparison.OrdinalIgnoreCase);
        // DELETE /positions exits every position - it places orders.
        var exitAll = method == HttpMethod.Delete && path.StartsWith("/positions", StringComparison.OrdinalIgnoreCase);
        return (changes && orders) || exitAll ? DhanApiCategory.Order : DhanApiCategory.NonTrading;
    }

    /// <summary>Waits for this call's slot in its category - null when it may go now, else why it must not be sent (an
    /// order past the minute / hour / day limit, the data day cap). <paramref name="interactive"/> only matters for Data:
    /// a page load goes ahead of background work.</summary>
    public async Task<string?> WaitAsync(DhanApiCategory category, bool interactive, CancellationToken cancellationToken)
    {
        switch (category)
        {
            case DhanApiCategory.Data:
                lock (_dayLock)
                {
                    var today = IstClock.IstDate(_clock());
                    if (today != _dataDay) { _dataDay = today; _dataToday = 0; }
                    if (_dataToday >= DataDayLimit)
                        return $"Not sent: {_dataToday:N0} Dhan data calls today - Dhan allows 100,000 a day.";
                    _dataToday++;
                }
                await _data.WaitForPermitAsync(interactive, cancellationToken);
                return null;
            case DhanApiCategory.Order: return await _orders.WaitAsync(cancellationToken);
            case DhanApiCategory.Quote: return await _quotes.WaitAsync(cancellationToken);
            default: return await _nonTrading.WaitAsync(cancellationToken);
        }
    }

    /// <summary>Dhan answered "too many requests" for a call of this category: hold its next calls back.</summary>
    public void NoteRateLimited(DhanApiCategory category)
    {
        switch (category)
        {
            case DhanApiCategory.Data: _data.NoteRateLimited(); break;
            case DhanApiCategory.Order: _orders.Pause(DhanDataApiRateLimiter.RateLimitPause); break;
            case DhanApiCategory.Quote: _quotes.Pause(DhanDataApiRateLimiter.RateLimitPause); break;
            default: _nonTrading.Pause(DhanDataApiRateLimiter.RateLimitPause); break;
        }
    }

    /// <summary>For the tests: calls let go in a category (Data: the data limiter's own count).</summary>
    internal int Sent(DhanApiCategory category) => category switch
    {
        DhanApiCategory.Data => _data.PermitsGiven,
        DhanApiCategory.Order => _orders.Sent,
        DhanApiCategory.Quote => _quotes.Sent,
        _ => _nonTrading.Sent,
    };

    /// <summary>At most Count calls within any Span, for every window - judged on the times calls actually went. A call
    /// waits for room; one that would wait longer than maxWait is refused (the window's reason).</summary>
    private sealed class WindowLimiter
    {
        private readonly string _name;
        private readonly Func<DateTimeOffset> _clock;
        private readonly TimeSpan? _maxWait;
        private readonly (int Count, TimeSpan Span, string Dhan)[] _windows;
        private readonly TimeSpan _longest;
        private readonly List<DateTimeOffset> _sent = new();
        private readonly object _lock = new();
        private DateTimeOffset _pausedUntil = DateTimeOffset.MinValue;

        public WindowLimiter(string name, Func<DateTimeOffset> clock, TimeSpan? maxWait, params (int Count, TimeSpan Span, string Dhan)[] windows)
        {
            _name = name;
            _clock = clock;
            _maxWait = maxWait;
            _windows = windows;
            _longest = windows.Max(w => w.Span);
        }

        public int Sent { get; private set; }

        public void Pause(TimeSpan pause)
        {
            lock (_lock)
            {
                var until = _clock() + pause;
                if (_pausedUntil < until) _pausedUntil = until;
            }
        }

        public async Task<string?> WaitAsync(CancellationToken cancellationToken)
        {
            while (true)
            {
                TimeSpan wait;
                lock (_lock)
                {
                    var now = _clock();
                    var expired = _sent.FindIndex(t => now - t < _longest);
                    if (expired < 0) _sent.Clear(); else if (expired > 0) _sent.RemoveRange(0, expired);
                    wait = _pausedUntil > now ? _pausedUntil - now : TimeSpan.Zero;
                    string? limit = null;
                    foreach (var (count, span, dhan) in _windows)
                    {
                        // The count-th most recent call must have left the window before another may go.
                        if (_sent.Count < count) continue;
                        var free = _sent[^count] + span - now;
                        if (free > wait) { wait = free; limit = dhan; }
                    }
                    if (wait <= TimeSpan.Zero)
                    {
                        _sent.Add(now);
                        Sent++;
                        return null;
                    }
                    if (_maxWait is { } max && wait > max)
                        return $"Not sent: Dhan allows {limit ?? "fewer"} {_name} requests and this account is at it - retry in {Math.Ceiling(wait.TotalSeconds):0} s.";
                }
                await Task.Delay(wait, cancellationToken);
            }
        }
    }
}

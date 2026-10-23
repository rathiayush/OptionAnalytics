using System.Threading.RateLimiting;
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

/// <summary>One sliding window: at most Permits calls within any Span, counted in Segments (the window slides a segment
/// at a time); Dhan: Dhan's own limit, for messages.</summary>
internal sealed record DhanRateWindow(int Permits, TimeSpan Span, int Segments, string Dhan);

/// <summary>The windows each category is held to. Waited for: the per-second limits (well under a second). Refused, not
/// waited for: the order minute / hour / day limits and the data day cap - a call past one fails at once with the reason
/// rather than holding a live order for minutes. Kept under Dhan's own numbers with room for the segment the window
/// slides by (a window can see one segment beyond its span) and for network jitter (Dhan counts calls as they arrive).</summary>
internal sealed record DhanRateLimits(
    DhanRateWindow OrderPerSecond, DhanRateWindow[] OrderRefused, DhanRateWindow QuotePerSecond, DhanRateWindow NonTradingPerSecond, DhanRateWindow[] DataRefused)
{
    public static readonly DhanRateLimits Dhan = new(
        OrderPerSecond: new(8, TimeSpan.FromSeconds(1.1), 11, "10 a second"),
        // 240 + one 1 s segment (8) < 250; 900 + one 10 s segment (80) < 1000; 6000 + one 10 min segment (<= the hour's 900) < 7000.
        OrderRefused: new DhanRateWindow[]
        {
            new(240, TimeSpan.FromMinutes(1), 60, "250 a minute"),
            new(900, TimeSpan.FromHours(1), 360, "1000 an hour"),
            new(6_000, TimeSpan.FromDays(1), 144, "7000 a day"),
        },
        QuotePerSecond: new(1, TimeSpan.FromSeconds(1.5), 15, "1 a second"),
        NonTradingPerSecond: new(18, TimeSpan.FromSeconds(1.1), 11, "20 a second"),
        // 97,000 + one 10 min segment of data calls (under 5 a second: < 3,000) < 100,000.
        DataRefused: new DhanRateWindow[] { new(97_000, TimeSpan.FromDays(1), 144, "100,000 a day") });
}

/// <summary>
/// The ONE limiter every Dhan REST call in this server goes through - DhanApiClient's Polly pipeline takes a slot here
/// (its rate-limiter step) for every attempt, retries included, so no caller reaches Dhan around it. A singleton: Dhan
/// counts per ACCOUNT, so only one shared instance sees the combined rate.
///
/// Each category is limited on its own - a burst of chart downloads never makes a live order wait, and orders never eat
/// the data budget (DhanRateLimits):
///  - Order, Quote, NonTrading: .NET's own sliding-window limiters (System.Threading.RateLimiting - what Polly's rate
///    limiter runs on);
///  - Data: DhanDataApiRateLimiter - evenly spaced calls as they actually go, page loads ahead of background work (no
///    built-in limiter does either: a token bucket can let 6 through within a second, a sliding window lets 5 go at
///    once), plus a sliding day cap.
/// After Dhan answers "too many requests", that category pauses (NoteRateLimited).
/// </summary>
public sealed class DhanRestRateLimiter : IDisposable
{
    private readonly DhanDataApiRateLimiter _data;
    private readonly Dictionary<DhanApiCategory, RateLimiter> _waited;
    private readonly Dictionary<DhanApiCategory, (RateLimiter Limiter, string Dhan)[]> _refused;
    private readonly Dictionary<DhanApiCategory, DateTimeOffset> _pausedUntil = new();
    private readonly Dictionary<DhanApiCategory, int> _sent = new();
    private readonly object _lock = new();

    public DhanRestRateLimiter(DhanDataApiRateLimiter data) : this(data, DhanRateLimits.Dhan) { }

    internal DhanRestRateLimiter(DhanDataApiRateLimiter data, DhanRateLimits limits)
    {
        _data = data;
        _waited = new()
        {
            [DhanApiCategory.Order] = Sliding(limits.OrderPerSecond, queue: true),
            [DhanApiCategory.Quote] = Sliding(limits.QuotePerSecond, queue: true),
            [DhanApiCategory.NonTrading] = Sliding(limits.NonTradingPerSecond, queue: true),
        };
        _refused = new()
        {
            [DhanApiCategory.Order] = limits.OrderRefused.Select(w => ((RateLimiter)Sliding(w, queue: false), w.Dhan)).ToArray(),
            [DhanApiCategory.Data] = limits.DataRefused.Select(w => ((RateLimiter)Sliding(w, queue: false), w.Dhan)).ToArray(),
        };
    }

    private static SlidingWindowRateLimiter Sliding(DhanRateWindow w, bool queue) => new(new SlidingWindowRateLimiterOptions
    {
        PermitLimit = w.Permits,
        Window = w.Span,
        SegmentsPerWindow = w.Segments,
        QueueLimit = queue ? 10_000 : 0,
        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
        AutoReplenishment = true,
    });

    /// <summary>A limiter of its own - for a DhanApiClient built without the app's (tests, tools).</summary>
    internal static DhanRestRateLimiter Standalone(IOptions<DhanOptions> options) =>
        new(new DhanDataApiRateLimiter(options, NullLogger<DhanDataApiRateLimiter>.Instance));

    internal DhanDataApiRateLimiter Data => _data;

    /// <summary>Which of Dhan's categories a REST call is.</summary>
    public static DhanApiCategory CategoryOf(HttpMethod method, string path)
    {
        if (path.StartsWith("/marketfeed", StringComparison.OrdinalIgnoreCase)) return DhanApiCategory.Quote;
        if (DhanApiClient.IsDataApi(path)) return DhanApiCategory.Data;
        var changes = method != HttpMethod.Get;
        var orders = path.StartsWith("/orders", StringComparison.OrdinalIgnoreCase)
                     || path.StartsWith("/super/orders", StringComparison.OrdinalIgnoreCase)
                     || path.StartsWith("/forever/orders", StringComparison.OrdinalIgnoreCase);
        // DELETE /positions exits every position - it places orders.
        var exitAll = method == HttpMethod.Delete && path.StartsWith("/positions", StringComparison.OrdinalIgnoreCase);
        return (changes && orders) || exitAll ? DhanApiCategory.Order : DhanApiCategory.NonTrading;
    }

    /// <summary>This call's slot in its category - an acquired lease when it may go now, or a refused one (its reason in
    /// MetadataName.ReasonPhrase) when it must not be sent: an order past the minute / hour / day limit, the data day
    /// cap. <paramref name="interactive"/> only matters for Data: a page load goes ahead of background work.</summary>
    public async ValueTask<RateLimitLease> AcquireAsync(DhanApiCategory category, bool interactive, CancellationToken cancellationToken)
    {
        TimeSpan pause;
        lock (_lock) pause = _pausedUntil.TryGetValue(category, out var until) ? until - DateTimeOffset.UtcNow : TimeSpan.Zero;
        if (pause > TimeSpan.Zero) await Task.Delay(pause, cancellationToken);

        // The limits a call is refused at: checked before any is taken, so a refused call uses none of them up.
        if (_refused.TryGetValue(category, out var refused))
        {
            lock (_lock)
            {
                foreach (var (limiter, dhan) in refused)
                    if (limiter.GetStatistics()?.CurrentAvailablePermits < 1)
                        return new Refused($"Not sent: Dhan allows {dhan} {Name(category)} requests and this account has used them - try again shortly.");
                foreach (var (limiter, _) in refused) limiter.AttemptAcquire(1).Dispose();
            }
        }

        if (category == DhanApiCategory.Data) await _data.WaitForPermitAsync(interactive, cancellationToken);
        else
        {
            using var lease = await _waited[category].AcquireAsync(1, cancellationToken);
            if (!lease.IsAcquired) return new Refused($"Not sent: too many {Name(category)} requests waiting for Dhan's limit.");
        }
        lock (_lock) _sent[category] = _sent.GetValueOrDefault(category) + 1;
        return Acquired.Instance;
    }

    /// <summary>Dhan answered "too many requests" for a call of this category: hold its next calls back.</summary>
    public void NoteRateLimited(DhanApiCategory category)
    {
        if (category == DhanApiCategory.Data) { _data.NoteRateLimited(); return; }
        lock (_lock) _pausedUntil[category] = DateTimeOffset.UtcNow + DhanDataApiRateLimiter.RateLimitPause;
    }

    /// <summary>For the tests: calls let go in a category.</summary>
    internal int Sent(DhanApiCategory category) { lock (_lock) return _sent.GetValueOrDefault(category); }

    private static string Name(DhanApiCategory category) => category switch
    {
        DhanApiCategory.Order => "order",
        DhanApiCategory.Data => "data",
        DhanApiCategory.Quote => "quote",
        _ => "non-trading",
    };

    public void Dispose()
    {
        foreach (var limiter in _waited.Values) limiter.Dispose();
        foreach (var limiter in _refused.Values.SelectMany(r => r)) limiter.Limiter.Dispose();
    }

    private sealed class Acquired : RateLimitLease
    {
        public static readonly Acquired Instance = new();
        public override bool IsAcquired => true;
        public override IEnumerable<string> MetadataNames => Array.Empty<string>();
        public override bool TryGetMetadata(string metadataName, out object? metadata) { metadata = null; return false; }
    }

    private sealed class Refused(string reason) : RateLimitLease
    {
        public override bool IsAcquired => false;
        public override IEnumerable<string> MetadataNames => new[] { MetadataName.ReasonPhrase.Name };
        public override bool TryGetMetadata(string metadataName, out object? metadata)
        {
            metadata = metadataName == MetadataName.ReasonPhrase.Name ? reason : null;
            return metadata is not null;
        }
    }
}

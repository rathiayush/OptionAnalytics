using System.Collections.Concurrent;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// One PAST day's 1-minute futures candles, fetched ONCE however many parts of the app want them.
///
/// Two different endpoints want the very same contract-day: GET /api/oi-replay/{u}/run (through
/// OiReplayService.GetFuturesAsync - the day's futures bars beside its option OI) and GET
/// /api/order-flow/{u}/day/{date} (through OrderFlowHistory - the same candles, to estimate that
/// day's order flow from). A strategy tuning job in Futures + OI mode asks for both for every day it
/// scans, so a 95-day job used to make the same Dhan intraday call twice per day - about 190 calls
/// it had no use for. Both now go through here, so the second one is free.
///
/// Only PAST days are kept (date before today, IST): a past day's candles never change, which is
/// what makes caching them indefinitely correct rather than a staleness risk. Today is never cached
/// here at all - it is still forming, and OrderFlowHistory has its own short time-to-live for it.
/// A fetch that failed, or came back with no bars at all, is not kept either (NSE may simply have
/// been unreachable); the next caller tries again. Concurrent callers for the same contract-day
/// share one in-flight fetch rather than racing, which is also what makes a batch of days scanned
/// together cost one call each and not two.
/// </summary>
public sealed class PastFuturesCandleCache
{
    /// <summary>How many contract-days are kept. A 250-day tuning job is the widest real caller and
    /// each entry is one day of 1-minute bars (375 of them), so this is bounded by design rather
    /// than by hope; the oldest-fetched entry goes first once it is reached.</summary>
    private const int MaxEntries = 400;

    private readonly ConcurrentDictionary<(uint SecurityId, DateOnly Day), (PastFuturesCandles.Result Result, long FetchedTicks)> _kept = new();
    private readonly ConcurrentDictionary<(uint SecurityId, DateOnly Day), Task<PastFuturesCandles.Result>> _inFlight = new();

    /// <summary>How many fetches this cache served from memory instead of calling Dhan - read by the
    /// tests, and worth logging if the saving is ever in doubt.</summary>
    public long Hits => Interlocked.Read(ref _hits);
    private long _hits;

    /// <summary>PastFuturesCandles.FetchAsync, but a past contract-day already fetched is not fetched
    /// again. The arguments and the result are exactly that method's, so a caller swaps one for the
    /// other with no other change.</summary>
    public async Task<PastFuturesCandles.Result> FetchAsync(
        DhanHistoricalDataService historical, DhanFuturesInstrument contract, IEnumerable<DhanFuturesInstrument> listedThatDay, DateOnly date,
        CancellationToken cancellationToken, NseChartHistory? nse = null)
    {
        var cacheable = date < IstClock.Today();
        if (!cacheable) return await PastFuturesCandles.FetchAsync(historical, contract, listedThatDay, date, cancellationToken, nse);

        var key = (contract.SecurityId, date);
        // A force fetch skips what is kept and replaces it with what the sources answer now.
        if (!DhanDataCache.ForceRefresh && _kept.TryGetValue(key, out var hit))
        {
            Interlocked.Increment(ref _hits);
            return hit.Result;
        }

        // The same contract-day asked for twice at once (the tuning job scans several days together,
        // and each day wants its futures twice) is fetched once and shared.
        var pending = _inFlight.GetOrAdd(key, _ => PastFuturesCandles.FetchAsync(historical, contract, listedThatDay, date, cancellationToken, nse));
        try
        {
            var result = await pending;
            // Only a real answer is kept: an error, or no bars at all, may be NSE having been
            // unreachable for a moment rather than a fact about the day.
            if (result.Error is null && result.Bars.Count > 0)
            {
                _kept[key] = (result, DateTimeOffset.UtcNow.UtcTicks);
                while (_kept.Count > MaxEntries)
                {
                    var oldest = _kept.OrderBy(kv => kv.Value.FetchedTicks).Select(kv => kv.Key).FirstOrDefault();
                    if (!_kept.TryRemove(oldest, out _)) break;
                }
            }
            return result;
        }
        finally
        {
            _inFlight.TryRemove(key, out _);
        }
    }
}

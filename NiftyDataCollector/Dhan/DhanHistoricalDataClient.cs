using System.Globalization;
using System.Text.Json;

namespace NiftyDataCollector.Dhan;

public sealed record DhanHistoricalBar(DateTimeOffset Time, decimal Open, decimal High, decimal Low, decimal Close, long Volume, long? OpenInterest);

/// <summary>Called once per successfully-fetched chunk, bars for [ChunkFrom, ChunkTo] only - lets
/// the caller save progress incrementally rather than holding a whole multi-hundred-day fetch in
/// memory and writing nothing until every chunk succeeds (see FetchAsync's own doc comment on
/// why chunk-at-a-time save+report matters here).</summary>
public delegate Task DhanHistoricalChunkSavedCallback(IReadOnlyList<DhanHistoricalBar> bars, DateOnly chunkFrom, DateOnly chunkTo);

/// <summary>
/// Dhan's Intraday Historical Data API (POST /v2/charts/intraday) - the one endpoint that can give
/// this collector actual OHLC HISTORY (Dhan's docs cap a single call at roughly 90 days) for a
/// specific security, rather than a live-only snapshot. Ported from OptionAnalytics.Server's own
/// DhanHistoricalDataService's request/response shape, with two additions: the optional "oi": true
/// request field (Dhan's docs describe it returning an "open_interest" array for F&amp;O
/// instruments), and chunking for a range longer than Dhan will serve in one call.
///
/// THIS IS AN OPEN QUESTION THIS COLLECTOR EXISTS PARTLY TO ANSWER: OptionAnalytics.Server's own
/// DhanOptionChainQuotes is built on the (previously confirmed) assumption that OI has NO history
/// anywhere in Dhan's API, only ever a live snapshot - but Dhan's docs for THIS endpoint separately
/// describe an "oi" request flag with an "open_interest" response array, and their own example
/// shows it (all zeros in the doc's generic sample, which proves nothing either way about real
/// data). ReadOpenInterest below parses that array whenever present; check the actual values that
/// come back from a real authenticated call against real option contracts to find out which is
/// true. If it turns out to carry real historical OI, that reopens the door to backtesting an
/// OI-based strategy the way OiUnwindStrategy (removed from OptionAnalytics.Server, live-only OI
/// having been the reason) could not.
///
/// CHUNKING: a caller asking for BackfillDays=500 worth of history gets that split into ~90-day
/// chunks, each its own rate-limited call, fed to the caller's onChunkFetched callback as soon as
/// it succeeds - deliberately NOT buffered until the whole range is done. That way a failure
/// partway through a long backfill (rate limit, a transient Dhan error) still leaves every earlier
/// chunk's data safely saved rather than losing the whole call; the caller (CollectorHostedService)
/// only marks a contract "fully backfilled" once every chunk in the range came back clean, so a
/// partial failure gets the WHOLE range retried (an idempotent no-op for the chunks that already
/// succeeded, thanks to upsert) on the next cycle rather than silently leaving a permanent gap. If
/// a specific chunk's saved data ever looks wrong, deleting just that date range from Postgres and
/// letting the next cycle's retry refill it is a normal, supported way to recover - see the
/// project README.
/// </summary>
public sealed class DhanHistoricalDataClient
{
    private const string OptionInstrument = "OPTIDX";
    private const string IndexInstrument = "INDEX";

    /// <summary>Dhan's own documented ceiling per /charts/intraday call. Kept a few days under the
    /// ~100 Dhan's docs mention as margin.</summary>
    private const int MaxDaysPerChunk = 90;

    private readonly DhanApiClient _api;
    private readonly DhanRateLimiter _rateLimiter;
    private readonly ILogger<DhanHistoricalDataClient> _logger;

    public DhanHistoricalDataClient(DhanApiClient api, DhanRateLimiter rateLimiter, ILogger<DhanHistoricalDataClient> logger)
    {
        _api = api;
        _rateLimiter = rateLimiter;
        _logger = logger;
    }

    public Task<(int TotalBars, bool FullyComplete, string? LastError)> GetSpotIntradayAsync(
        uint securityId, string dhanSegment, DateOnly fromDay, DateOnly toDay, int intervalMinutes,
        DhanHistoricalChunkSavedCallback onChunkFetched, CancellationToken cancellationToken) =>
        FetchAsync(securityId, dhanSegment, IndexInstrument, fromDay, toDay, intervalMinutes, includeOi: false, onChunkFetched, cancellationToken);

    public Task<(int TotalBars, bool FullyComplete, string? LastError)> GetOptionIntradayAsync(
        uint securityId, string dhanSegment, DateOnly fromDay, DateOnly toDay, int intervalMinutes,
        DhanHistoricalChunkSavedCallback onChunkFetched, CancellationToken cancellationToken) =>
        FetchAsync(securityId, dhanSegment, OptionInstrument, fromDay, toDay, intervalMinutes, includeOi: true, onChunkFetched, cancellationToken);

    private async Task<(int TotalBars, bool FullyComplete, string? LastError)> FetchAsync(
        uint securityId, string dhanSegment, string instrument, DateOnly fromDay, DateOnly toDay, int intervalMinutes, bool includeOi,
        DhanHistoricalChunkSavedCallback onChunkFetched, CancellationToken cancellationToken)
    {
        var totalBars = 0;
        var fullyComplete = true;
        string? lastError = null;
        var chunkFrom = fromDay;

        while (chunkFrom <= toDay)
        {
            var chunkTo = chunkFrom.AddDays(MaxDaysPerChunk - 1);
            if (chunkTo > toDay) chunkTo = toDay;

            await _rateLimiter.WaitForHistoricalDataSlotAsync(cancellationToken);

            var payload = new
            {
                securityId = securityId.ToString(CultureInfo.InvariantCulture),
                exchangeSegment = dhanSegment,
                instrument,
                interval = intervalMinutes.ToString(CultureInfo.InvariantCulture),
                oi = includeOi,
                fromDate = $"{chunkFrom:yyyy-MM-dd} 09:15:00",
                toDate = $"{chunkTo:yyyy-MM-dd} 15:30:00",
            };

            using var response = await _api.SendAsync(HttpMethod.Post, "/charts/intraday", payload,
                $"{instrument} intraday ({dhanSegment}:{securityId}, {chunkFrom:yyyy-MM-dd}..{chunkTo:yyyy-MM-dd})", cancellationToken);

            if (!response.Success)
            {
                fullyComplete = false;
                lastError = response.ErrorMessage;
                _logger.LogWarning(
                    "{Instrument} intraday chunk FAILED for {Segment}:{Id} [{ChunkFrom}..{ChunkTo}] - {Error}. " +
                    "Stopping here for this security this cycle rather than continuing further chunks - the checkpoint stays before this chunk, " +
                    "so the next cycle resumes from here instead of redoing the whole [{From}..{To}] range.",
                    instrument, dhanSegment, securityId, chunkFrom, chunkTo, response.ErrorMessage, fromDay, toDay);
                break; // Stop at the first failure: the checkpoint's "contiguous coverage up to this date" guarantee
                       // would break if a later chunk succeeded past a hole left by this one.
            }

            var bars = ParseBars(response.Root);
            totalBars += bars.Count;
            // Called even for a zero-bar chunk (e.g. before an option contract existed) - the
            // callback still needs to advance the checkpoint past it, or every future cycle would
            // keep re-requesting the same known-empty range forever.
            await onChunkFetched(bars, chunkFrom, chunkTo);

            chunkFrom = chunkTo.AddDays(1);
        }

        return (totalBars, fullyComplete, lastError);
    }

    private static List<DhanHistoricalBar> ParseBars(JsonElement root)
    {
        var bars = new List<DhanHistoricalBar>();
        if (!root.TryGetProperty("timestamp", out var timestamps) || timestamps.ValueKind != JsonValueKind.Array)
            return bars;

        var open = GetDecimalArray(root, "open");
        var high = GetDecimalArray(root, "high");
        var low = GetDecimalArray(root, "low");
        var close = GetDecimalArray(root, "close");
        var volume = GetDecimalArray(root, "volume");
        var openInterest = GetOptionalLongArray(root, "open_interest");

        var count = timestamps.GetArrayLength();
        for (var i = 0; i < count; i++)
        {
            try
            {
                var epochSeconds = (long)timestamps[i].GetDouble();
                bars.Add(new DhanHistoricalBar(
                    Time: DateTimeOffset.FromUnixTimeSeconds(epochSeconds),
                    Open: i < open.Count ? open[i] : 0m,
                    High: i < high.Count ? high[i] : 0m,
                    Low: i < low.Count ? low[i] : 0m,
                    Close: i < close.Count ? close[i] : 0m,
                    Volume: i < volume.Count ? (long)volume[i] : 0,
                    OpenInterest: openInterest is not null && i < openInterest.Count ? openInterest[i] : null));
            }
            catch (Exception ex) when (ex is FormatException or InvalidOperationException or OverflowException)
            {
                // Skipped, not thrown - one bad element must not lose every other bar in the call.
            }
        }

        return bars;
    }

    private static List<decimal> GetDecimalArray(JsonElement root, string propertyName)
    {
        var result = new List<decimal>();
        if (root.TryGetProperty(propertyName, out var array) && array.ValueKind == JsonValueKind.Array)
            foreach (var element in array.EnumerateArray())
                result.Add(element.ValueKind == JsonValueKind.Number ? element.GetDecimal() : 0m);
        return result;
    }

    private static List<long>? GetOptionalLongArray(JsonElement root, string propertyName)
    {
        if (!root.TryGetProperty(propertyName, out var array) || array.ValueKind != JsonValueKind.Array) return null;
        var result = new List<long>();
        foreach (var element in array.EnumerateArray())
            result.Add(element.ValueKind == JsonValueKind.Number ? (long)element.GetDouble() : 0);
        return result;
    }
}

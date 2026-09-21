using System.Globalization;
using System.Text.Json;

namespace NiftyDataCollector.Dhan;

public sealed record DhanRollingOptionBar(
    DateTimeOffset Time, decimal? Open, decimal? High, decimal? Low, decimal? Close,
    long? Volume, long? OpenInterest, decimal? ImpliedVolatility, decimal? Strike, decimal? SpotPrice);

/// <summary>Called once per successfully-fetched chunk - see DhanHistoricalDataClient's own
/// DhanHistoricalChunkSavedCallback doc comment for why chunk-at-a-time save+checkpoint matters;
/// the same reasoning applies here.</summary>
public delegate Task DhanRollingOptionChunkSavedCallback(IReadOnlyList<DhanRollingOptionBar> bars, DateOnly chunkFrom, DateOnly chunkTo);

/// <summary>
/// Dhan's "Rolling Options" historical data API (POST /v2/charts/rollingoption) - genuinely
/// different from DhanHistoricalDataClient's /charts/intraday:
///
///  - You don't name a specific contract (security id / fixed strike). You name a RULE -
///    "{expiryCode}-th {expiryFlag} cycle's ATM{+/-N} strike" - and Dhan resolves that rule fresh
///    for every day in the requested range, stitching together whichever actual contract matched
///    on each day into one continuous series. This is what makes a multi-year "always the nearest
///    weekly ATM+3 CE" backtest possible without you first having to enumerate years of past
///    expiries and figure out what was ATM on every one of them - Dhan does that resolution
///    server-side. Because the rule can resolve to a different absolute strike on different days
///    (spot moves, expiries roll), the resolved strike (and spot price) come back PER BAR, not
///    just once per request - see DhanRollingOptionBar.Strike/SpotPrice.
///  - The response includes open_interest AND implied_volatility history. This is notable: both
///    OptionAnalytics.Server's DhanOptionChainQuotes and this collector's own
///    DhanHistoricalDataClient doc comment were built on/around the assumption that OI (and IV)
///    have no history anywhere in Dhan's API, only ever a live snapshot - that assumption is about
///    /optionchain and /charts/intraday specifically. This endpoint's own documented response
///    shape says otherwise: real historical OI/IV, at least for this rolling/ATM-relative query
///    shape. Worth confirming against real returned values once this runs for real (same "verify,
///    don't just trust the docs" caution as /charts/intraday's own "oi" flag), but the endpoint's
///    entire purpose being systematic ATM backtesting makes it a credible source either way.
///  - Dhan's own cap here is 30 days per call (smaller than /charts/intraday's 90) - see
///    MaxDaysPerChunk. Same chunk-at-a-time save/checkpoint contract as DhanHistoricalDataClient:
///    stop at the first failed chunk so a checkpoint's "contiguous coverage" guarantee holds.
///
/// expiryCode is 1-INDEXED - CONFIRMED against a real account: 1 is the currently-rolling nearest
/// cycle, 2 the one after that, and so on. 0 is NOT a valid "cycle zero" - Dhan's API rejects it
/// outright with "Input_Exception: expiryCode is required" (i.e. a literal 0 is treated the same
/// as the field being omitted entirely, not as an index). This was the original assumption of
/// this doc comment (0-indexed, "unconfirmed") before it was tested against a real account and
/// found wrong - left this note so the same mistake doesn't get re-introduced later.
/// </summary>
public sealed class DhanRollingOptionClient
{
    private const string OptionChainSegment = "NSE_FNO";
    private const string OptionInstrument = "OPTIDX";

    /// <summary>Dhan's own documented ceiling per /charts/rollingoption call.</summary>
    private const int MaxDaysPerChunk = 30;

    private readonly DhanApiClient _api;
    private readonly DhanRateLimiter _rateLimiter;
    private readonly ILogger<DhanRollingOptionClient> _logger;

    public DhanRollingOptionClient(DhanApiClient api, DhanRateLimiter rateLimiter, ILogger<DhanRollingOptionClient> logger)
    {
        _api = api;
        _rateLimiter = rateLimiter;
        _logger = logger;
    }

    public async Task<(int TotalBars, bool FullyComplete, string? LastError)> GetRollingOptionBarsAsync(
        uint underlyingSecurityId, string expiryFlag, int expiryCode, string strikeOffset, bool isCall,
        DateOnly fromDay, DateOnly toDay, DhanRollingOptionChunkSavedCallback onChunkFetched, CancellationToken cancellationToken)
    {
        var totalBars = 0;
        var fullyComplete = true;
        string? lastError = null;
        var chunkFrom = fromDay;

        while (chunkFrom <= toDay)
        {
            var chunkTo = chunkFrom.AddDays(MaxDaysPerChunk - 1);
            if (chunkTo > toDay) chunkTo = toDay;

            await _rateLimiter.WaitForRollingOptionSlotAsync(cancellationToken);

            var payload = new
            {
                exchangeSegment = OptionChainSegment,
                interval = "1",
                securityId = underlyingSecurityId,
                instrument = OptionInstrument,
                expiryFlag,
                expiryCode,
                strike = strikeOffset,
                drvOptionType = isCall ? "CALL" : "PUT",
                requiredData = new[] { "open", "high", "low", "close", "volume", "oi", "iv", "strike", "spot" },
                fromDate = chunkFrom.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                toDate = chunkTo.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            };

            using var response = await _api.SendAsync(HttpMethod.Post, "/charts/rollingoption", payload,
                $"rolling option ({expiryFlag}:{expiryCode}, {strikeOffset}{(isCall ? "CE" : "PE")}, {chunkFrom:yyyy-MM-dd}..{chunkTo:yyyy-MM-dd})", cancellationToken);

            if (!response.Success)
            {
                fullyComplete = false;
                lastError = response.ErrorMessage;
                _logger.LogWarning(
                    "Rolling option chunk FAILED for {ExpiryFlag}:{ExpiryCode} {StrikeOffset}{Side} [{ChunkFrom}..{ChunkTo}] - {Error}. " +
                    "Stopping here for this series this cycle rather than continuing further chunks - the checkpoint stays before this chunk, " +
                    "so the next cycle resumes from here instead of redoing the whole [{From}..{To}] range.",
                    expiryFlag, expiryCode, strikeOffset, isCall ? "CE" : "PE", chunkFrom, chunkTo, response.ErrorMessage, fromDay, toDay);
                break;
            }

            var bars = ParseBars(response.Root, isCall);
            totalBars += bars.Count;
            await onChunkFetched(bars, chunkFrom, chunkTo);

            chunkFrom = chunkTo.AddDays(1);
        }

        return (totalBars, fullyComplete, lastError);
    }

    private static List<DhanRollingOptionBar> ParseBars(JsonElement root, bool isCall)
    {
        var bars = new List<DhanRollingOptionBar>();
        if (!root.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object) return bars;

        var legName = isCall ? "ce" : "pe";
        if (!data.TryGetProperty(legName, out var leg) || leg.ValueKind != JsonValueKind.Object) return bars;

        if (!leg.TryGetProperty("timestamp", out var timestamps) || timestamps.ValueKind != JsonValueKind.Array) return bars;

        var open = GetDecimalArray(leg, "open");
        var high = GetDecimalArray(leg, "high");
        var low = GetDecimalArray(leg, "low");
        var close = GetDecimalArray(leg, "close");
        var volume = GetOptionalLongArray(leg, "volume");
        var oi = GetOptionalLongArray(leg, "oi");
        var iv = GetDecimalArray(leg, "iv");
        var strike = GetDecimalArray(leg, "strike");
        var spot = GetDecimalArray(leg, "spot");

        var count = timestamps.GetArrayLength();
        for (var i = 0; i < count; i++)
        {
            try
            {
                var epochSeconds = (long)timestamps[i].GetDouble();
                bars.Add(new DhanRollingOptionBar(
                    Time: DateTimeOffset.FromUnixTimeSeconds(epochSeconds),
                    Open: i < open.Count ? open[i] : null,
                    High: i < high.Count ? high[i] : null,
                    Low: i < low.Count ? low[i] : null,
                    Close: i < close.Count ? close[i] : null,
                    Volume: volume is not null && i < volume.Count ? volume[i] : null,
                    OpenInterest: oi is not null && i < oi.Count ? oi[i] : null,
                    ImpliedVolatility: i < iv.Count ? iv[i] : null,
                    Strike: i < strike.Count ? strike[i] : null,
                    SpotPrice: i < spot.Count ? spot[i] : null));
            }
            catch (Exception ex) when (ex is FormatException or InvalidOperationException or OverflowException)
            {
                // Skipped, not thrown - one bad element must not lose every other bar in the call.
            }
        }

        return bars;
    }

    private static List<decimal> GetDecimalArray(JsonElement leg, string propertyName)
    {
        var result = new List<decimal>();
        if (leg.TryGetProperty(propertyName, out var array) && array.ValueKind == JsonValueKind.Array)
            foreach (var element in array.EnumerateArray())
                result.Add(element.ValueKind == JsonValueKind.Number ? element.GetDecimal() : 0m);
        return result;
    }

    private static List<long>? GetOptionalLongArray(JsonElement leg, string propertyName)
    {
        if (!leg.TryGetProperty(propertyName, out var array) || array.ValueKind != JsonValueKind.Array) return null;
        var result = new List<long>();
        foreach (var element in array.EnumerateArray())
            result.Add(element.ValueKind == JsonValueKind.Number ? (long)element.GetDouble() : 0);
        return result;
    }
}

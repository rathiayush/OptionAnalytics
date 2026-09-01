using System.Globalization;
using System.Text.Json;

namespace OptionAnalytics.Server.Dhan;

/// <summary>One strike's live CE/PE quote from Dhan's Option Chain API.</summary>
public sealed record DhanOptionChainQuote(
    decimal Strike,
    decimal? CeLastPrice,
    long? CeOpenInterest,
    decimal? PeLastPrice,
    long? PeOpenInterest);

/// <summary>
/// Dhan's Option Chain API (POST /v2/optionchain), used purely to DECORATE the dashboard's strike
/// picker with each strike's live premium and open interest, so a strike can be chosen on what the
/// market is actually doing there rather than on its number alone.
///
/// Deliberately NOT the source of anything structural. The strike list, security IDs and expiries
/// all still come from DhanOptionChainMaster (the scrip master CSV): that is a cached 12-hour
/// download with no rate limit, whereas this endpoint is capped at ONE REQUEST EVERY 3 SECONDS per
/// underlying/expiry and only ever returns a live snapshot - it has no history, so it could not feed
/// a chart even if it were free to call. Everything here therefore degrades to null rather than
/// failing: an unauthenticated session, a rate-limit rejection, or a call outside market hours costs
/// the picker its price/OI column and nothing else.
///
/// The 3-second limit is respected two ways: a per-key result cache (so repeated page loads and the
/// picker re-opening cost nothing), and a hard minimum spacing between actual outbound calls.
/// </summary>
public sealed class DhanOptionChainQuotes
{
    /// <summary>Comfortably inside Dhan's "one unique request every 3 seconds" - open interest is a
    /// slow-moving number, so a snapshot this old is no less useful for picking a strike.</summary>
    private static readonly TimeSpan CacheLifetime = TimeSpan.FromSeconds(30);

    /// <summary>Floor on the gap between two real outbound calls, with headroom over the documented
    /// 3 seconds so a burst of near-simultaneous requests can't trip the limit.</summary>
    private static readonly TimeSpan MinimumCallSpacing = TimeSpan.FromSeconds(3.5);

    private readonly DhanApiClient _api;
    private readonly ILogger<DhanOptionChainQuotes> _logger;
    private readonly SemaphoreSlim _callLock = new(1, 1);
    private readonly Dictionary<string, (DateTimeOffset FetchedAt, IReadOnlyList<DhanOptionChainQuote> Quotes)> _cache = new();

    private DateTimeOffset _lastCallAt = DateTimeOffset.MinValue;

    public DhanOptionChainQuotes(DhanApiClient api, ILogger<DhanOptionChainQuotes> logger)
    {
        _api = api;
        _logger = logger;
    }

    /// <summary>Every strike's CE/PE quote for one underlying/expiry, or an EMPTY list whenever the
    /// call isn't available - never an exception, and never a partial failure the caller has to
    /// handle: an empty result simply means the picker shows strikes without prices.</summary>
    public async Task<IReadOnlyList<DhanOptionChainQuote>> GetQuotesAsync(
        uint underlyingSecurityId, string underlyingSegment, DateOnly expiry, CancellationToken cancellationToken)
    {
        var key = $"{underlyingSegment}:{underlyingSecurityId}:{expiry:yyyy-MM-dd}";

        lock (_cache)
        {
            if (_cache.TryGetValue(key, out var cached) && DateTimeOffset.UtcNow - cached.FetchedAt < CacheLifetime)
                return cached.Quotes;
        }

        if (!_api.HasSession) return Array.Empty<DhanOptionChainQuote>();

        await _callLock.WaitAsync(cancellationToken);
        try
        {
            // Another caller may have filled the cache while this one waited for the lock.
            lock (_cache)
            {
                if (_cache.TryGetValue(key, out var cached) && DateTimeOffset.UtcNow - cached.FetchedAt < CacheLifetime)
                    return cached.Quotes;
            }

            var sinceLastCall = DateTimeOffset.UtcNow - _lastCallAt;
            if (sinceLastCall < MinimumCallSpacing)
                await Task.Delay(MinimumCallSpacing - sinceLastCall, cancellationToken);

            var payload = new
            {
                UnderlyingScrip = (int)underlyingSecurityId,
                UnderlyingSeg = underlyingSegment,
                Expiry = expiry.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            };

            _lastCallAt = DateTimeOffset.UtcNow;
            using var response = await _api.SendAsync(HttpMethod.Post, "/optionchain", payload,
                $"option chain quotes ({underlyingSegment}:{underlyingSecurityId}, {expiry:yyyy-MM-dd})", cancellationToken);

            if (!response.Success)
            {
                // Debug, not Warning: this is an optional decoration, and the most common failure
                // (called again inside the 3-second window, or outside market hours) is expected.
                _logger.LogDebug("Option chain quotes unavailable for {Segment}:{Id} {Expiry} - {Error}",
                    underlyingSegment, underlyingSecurityId, expiry, response.ErrorMessage);
                return Array.Empty<DhanOptionChainQuote>();
            }

            var quotes = Parse(response.Root);
            lock (_cache) { _cache[key] = (DateTimeOffset.UtcNow, quotes); }
            return quotes;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogDebug(ex, "Option chain quote request failed for {Segment}:{Id} {Expiry}", underlyingSegment, underlyingSecurityId, expiry);
            return Array.Empty<DhanOptionChainQuote>();
        }
        finally
        {
            _callLock.Release();
        }
    }

    /// <summary>Dhan's shape: {"data":{"last_price":…,"oc":{"25650.000000":{"ce":{…},"pe":{…}},…}}} -
    /// strikes are OBJECT KEYS formatted as decimals, so each one is parsed back to a number rather
    /// than string-matched against a strike computed elsewhere.</summary>
    private static List<DhanOptionChainQuote> Parse(JsonElement root)
    {
        var quotes = new List<DhanOptionChainQuote>();

        if (!root.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object) return quotes;
        if (!data.TryGetProperty("oc", out var chain) || chain.ValueKind != JsonValueKind.Object) return quotes;

        foreach (var strikeEntry in chain.EnumerateObject())
        {
            if (!decimal.TryParse(strikeEntry.Name, NumberStyles.Float, CultureInfo.InvariantCulture, out var strike)) continue;
            if (strikeEntry.Value.ValueKind != JsonValueKind.Object) continue;

            var (ceLtp, ceOi) = ReadLeg(strikeEntry.Value, "ce");
            var (peLtp, peOi) = ReadLeg(strikeEntry.Value, "pe");
            quotes.Add(new DhanOptionChainQuote(strike, ceLtp, ceOi, peLtp, peOi));
        }

        return quotes;
    }

    private static (decimal? LastPrice, long? OpenInterest) ReadLeg(JsonElement strike, string legName)
    {
        if (!strike.TryGetProperty(legName, out var leg) || leg.ValueKind != JsonValueKind.Object) return (null, null);

        decimal? lastPrice = leg.TryGetProperty("last_price", out var lp) && lp.ValueKind == JsonValueKind.Number
            ? lp.GetDecimal()
            : null;

        // OI comes back as a plain number, but Dhan is inconsistent about integer-vs-float
        // formatting elsewhere in its API (see DhanHistoricalDataService's timestamp handling), so
        // go through double rather than GetInt64, which throws on a trailing ".0".
        long? openInterest = leg.TryGetProperty("oi", out var oi) && oi.ValueKind == JsonValueKind.Number
            ? (long)oi.GetDouble()
            : null;

        return (lastPrice, openInterest);
    }
}

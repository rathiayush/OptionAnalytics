using System.Globalization;
using System.Text.Json;

namespace NiftyDataCollector.Dhan;

/// <summary>One CE/PE leg's full live snapshot from Dhan's Option Chain API - every field Dhan
/// actually returns per Dhan's own documented example (average_price, greeks, implied_volatility,
/// last_price, oi, previous_close_price/oi/volume, security_id, top_bid/ask price+quantity,
/// volume), not just the last_price+oi subset OptionAnalytics.Server's own DhanOptionChainQuotes
/// keeps - this collector's whole point is capturing everything Dhan offers, including IV and the
/// greeks, neither of which OptionAnalytics.Server currently stores anywhere.</summary>
public sealed record DhanOptionLegSnapshot(
    long SecurityId,
    decimal? LastPrice,
    decimal? AveragePrice,
    long? OpenInterest,
    long? PreviousOpenInterest,
    long? Volume,
    long? PreviousVolume,
    decimal? PreviousClosePrice,
    decimal? ImpliedVolatility,
    decimal? Delta,
    decimal? Theta,
    decimal? Gamma,
    decimal? Vega,
    decimal? TopBidPrice,
    long? TopBidQuantity,
    decimal? TopAskPrice,
    long? TopAskQuantity);

public sealed record DhanOptionChainStrikeSnapshot(decimal Strike, DhanOptionLegSnapshot? Ce, DhanOptionLegSnapshot? Pe);

public sealed record DhanOptionChainSnapshot(decimal? UnderlyingLastPrice, IReadOnlyList<DhanOptionChainStrikeSnapshot> Strikes);

/// <summary>
/// Dhan's Option Chain API (POST /v2/optionchain) and its sibling Expiry List endpoint
/// (POST /v2/optionchain/expirylist) - both rate limited to ONE REQUEST EVERY 3 SECONDS per unique
/// underlying/expiry combination (Dhan's own documented limit; OptionAnalytics.Server's own
/// DhanOptionChainQuotes independently arrived at the same number). Pacing across MULTIPLE expiries
/// is the caller's job (see DhanRateLimiter) - this class makes exactly one call per invocation and
/// never batches or retries on its own.
/// </summary>
public sealed class DhanOptionChainClient
{
    private readonly DhanApiClient _api;
    private readonly ILogger<DhanOptionChainClient> _logger;

    public DhanOptionChainClient(DhanApiClient api, ILogger<DhanOptionChainClient> logger)
    {
        _api = api;
        _logger = logger;
    }

    public async Task<IReadOnlyList<DateOnly>> GetExpiriesAsync(uint underlyingScrip, string underlyingSeg, CancellationToken cancellationToken)
    {
        var payload = new { UnderlyingScrip = (int)underlyingScrip, UnderlyingSeg = underlyingSeg };
        using var response = await _api.SendAsync(HttpMethod.Post, "/optionchain/expirylist", payload, "expiry list", cancellationToken);

        if (!response.Success)
        {
            _logger.LogWarning("Expiry list request failed for {Seg}:{Scrip} - {Error}", underlyingSeg, underlyingScrip, response.ErrorMessage);
            return Array.Empty<DateOnly>();
        }

        if (!response.Root.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
            return Array.Empty<DateOnly>();

        var expiries = new List<DateOnly>();
        foreach (var element in data.EnumerateArray())
        {
            if (element.ValueKind == JsonValueKind.String
                && DateOnly.TryParseExact(element.GetString(), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var expiry))
                expiries.Add(expiry);
        }
        return expiries.OrderBy(e => e).ToList();
    }

    public async Task<DhanOptionChainSnapshot?> GetChainAsync(uint underlyingScrip, string underlyingSeg, DateOnly expiry, CancellationToken cancellationToken)
    {
        var payload = new
        {
            UnderlyingScrip = (int)underlyingScrip,
            UnderlyingSeg = underlyingSeg,
            Expiry = expiry.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        };

        using var response = await _api.SendAsync(HttpMethod.Post, "/optionchain", payload,
            $"option chain ({underlyingSeg}:{underlyingScrip}, {expiry:yyyy-MM-dd})", cancellationToken);

        if (!response.Success)
        {
            _logger.LogWarning("Option chain request failed for {Seg}:{Scrip} {Expiry} - {Error}", underlyingSeg, underlyingScrip, expiry, response.ErrorMessage);
            return null;
        }

        return Parse(response.Root);
    }

    private static DhanOptionChainSnapshot Parse(JsonElement root)
    {
        var strikes = new List<DhanOptionChainStrikeSnapshot>();
        if (!root.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
            return new DhanOptionChainSnapshot(null, strikes);

        decimal? underlyingLastPrice = data.TryGetProperty("last_price", out var ulp) && ulp.ValueKind == JsonValueKind.Number ? ulp.GetDecimal() : null;

        if (!data.TryGetProperty("oc", out var chain) || chain.ValueKind != JsonValueKind.Object)
            return new DhanOptionChainSnapshot(underlyingLastPrice, strikes);

        foreach (var strikeEntry in chain.EnumerateObject())
        {
            if (!decimal.TryParse(strikeEntry.Name, NumberStyles.Float, CultureInfo.InvariantCulture, out var strike)) continue;
            if (strikeEntry.Value.ValueKind != JsonValueKind.Object) continue;

            strikes.Add(new DhanOptionChainStrikeSnapshot(strike, ReadLeg(strikeEntry.Value, "ce"), ReadLeg(strikeEntry.Value, "pe")));
        }

        return new DhanOptionChainSnapshot(underlyingLastPrice, strikes.OrderBy(s => s.Strike).ToList());
    }

    private static DhanOptionLegSnapshot? ReadLeg(JsonElement strike, string legName)
    {
        if (!strike.TryGetProperty(legName, out var leg) || leg.ValueKind != JsonValueKind.Object) return null;

        decimal? Dec(string name) => leg.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDecimal() : null;
        // OI/volume/quantities come back as plain numbers, but Dhan is inconsistent about integer-
        // vs-float formatting across its API (see OptionAnalytics.Server's own
        // DhanHistoricalDataService doc comment on the same point) - go through double rather than
        // GetInt64, which throws on a trailing ".0".
        long? Int(string name) => leg.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? (long)v.GetDouble() : null;

        leg.TryGetProperty("greeks", out var greeks);
        decimal? Greek(string name) => greeks.ValueKind == JsonValueKind.Object && greeks.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDecimal() : null;

        return new DhanOptionLegSnapshot(
            SecurityId: Int("security_id") ?? 0,
            LastPrice: Dec("last_price"),
            AveragePrice: Dec("average_price"),
            OpenInterest: Int("oi"),
            PreviousOpenInterest: Int("previous_oi"),
            Volume: Int("volume"),
            PreviousVolume: Int("previous_volume"),
            PreviousClosePrice: Dec("previous_close_price"),
            ImpliedVolatility: Dec("implied_volatility"),
            Delta: Greek("delta"),
            Theta: Greek("theta"),
            Gamma: Greek("gamma"),
            Vega: Greek("vega"),
            TopBidPrice: Dec("top_bid_price"),
            TopBidQuantity: Int("top_bid_quantity"),
            TopAskPrice: Dec("top_ask_price"),
            TopAskQuantity: Int("top_ask_quantity"));
    }
}

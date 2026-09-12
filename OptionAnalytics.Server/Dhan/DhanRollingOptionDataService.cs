using System.Globalization;
using System.Text.Json;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// Dhan's Expired/Rolling Option Data API (POST /v2/charts/rollingoption) - unlike
/// DhanHistoricalDataService's /charts/intraday (one specific, still-live contract), this endpoint
/// resolves a contract RELATIVE to a date range: "the Nth weekly/monthly expiry out from
/// fromDate, ATM+-K strike, as of each day in [fromDate,toDate]" - and the returned series rolls
/// across contracts as the range crosses each one's own expiry, splicing in the next one at the
/// same relative position. That is what makes testing an EXPIRED contract possible at all: point
/// the date range into the past rather than passing anything that identifies an expired contract
/// directly (its own security id is not resolvable via the live scrip master once it has expired).
///
/// Request/response shapes per Dhan's docs:
///   request:  {"exchangeSegment":"NSE_FNO","interval","securityId" (the UNDERLYING's own spot
///             security id, e.g. 13 for NIFTY - NOT an expired contract's own id),"instrument":
///             "OPTIDX","expiryFlag":"WEEK"|"MONTH","expiryCode" (0,1,2... - see
///             ExpiredOptionBacktestService.ComputeExpiryCode for how this app derives it from an
///             actual calendar expiry date), "strike":"ATM"|"ATM+-1".."ATM+-10","drvOptionType":
///             "CALL"|"PUT","requiredData":[...],"fromDate","toDate"} (fromDate/toDate are plain
///             "yyyy-MM-dd", unlike /charts/intraday's date-TIME strings - this endpoint has no
///             intraday session concept, one bar's "day" is the calendar date its relative expiry
///             was resolved against). Capped by Dhan at 30 days per call.
///   response: {"data":{"ce":{"open":[...],"high":[...],...,"timestamp":[...]},"pe":null-or-same}}
///             - requesting drvOptionType CALL fills "ce" and leaves "pe" null (and vice versa for
///             PUT), so getting both sides costs two calls, not one.
///
/// expiryCode's exact semantics are NOT spelled out in Dhan's docs beyond a single worked example
/// (expiryCode 1, querying August 2021 - a small positive number for a multi-year-old date, which
/// only makes sense if it counts forward from the query's OWN date range rather than from today).
/// Confirmed independently against a real cached Dhan scrip master: SEM_EXPIRY_CODE is "0" for
/// every single index-option row in it, an unrelated legacy futures column, not this parameter.
/// Not verified against a live call from this sandbox - build defensively, and let Dhan's own error
/// message surface immediately if this assumption is wrong.
/// </summary>
public sealed class DhanRollingOptionDataService
{
    private const string FnoSegment = "NSE_FNO";
    private const string OptionInstrument = "OPTIDX";
    private static readonly string[] RequiredData = { "open", "high", "low", "close", "volume" };

    // Dhan's own stated cap (see the endpoint's docs) - chunked into successive calls so a caller
    // can still ask for a range wider than one call supports, rather than needing to paginate it.
    private const int MaxChunkDays = 30;

    private readonly DhanApiClient _api;
    private readonly ILogger<DhanRollingOptionDataService> _logger;

    public DhanRollingOptionDataService(DhanApiClient api, ILogger<DhanRollingOptionDataService> logger)
    {
        _api = api;
        _logger = logger;
    }

    /// <summary>Every candle for [fromDay,toDay] inclusive, one relative contract
    /// (expiryFlag/expiryCode/strike/drvOptionType), chunked transparently across Dhan's 30-day
    /// per-call cap. Stops and returns whatever already succeeded plus Dhan's own error the moment
    /// one chunk fails, rather than silently discarding partial history.</summary>
    public async Task<(IReadOnlyList<CandleWithVolume> Candles, string? Error)> GetRollingOptionCandlesAsync(
        uint underlyingSecurityId, string expiryFlag, int expiryCode, string strike, string drvOptionType,
        DateOnly fromDay, DateOnly toDay, int intervalMinutes, CancellationToken cancellationToken)
    {
        if (!_api.HasSession)
            return (Array.Empty<CandleWithVolume>(), "Dhan is not authenticated (check Dhan:ClientId/Dhan:AccessToken).");

        if (toDay < fromDay)
            return (Array.Empty<CandleWithVolume>(), "'to' date must not be before 'from' date.");

        var all = new List<CandleWithVolume>();
        var chunkStart = fromDay;

        while (chunkStart <= toDay)
        {
            var chunkEnd = chunkStart.AddDays(MaxChunkDays - 1);
            if (chunkEnd > toDay) chunkEnd = toDay;

            var payload = new
            {
                exchangeSegment = FnoSegment,
                interval = intervalMinutes.ToString(CultureInfo.InvariantCulture),
                securityId = underlyingSecurityId,
                instrument = OptionInstrument,
                expiryFlag,
                expiryCode,
                strike,
                drvOptionType,
                requiredData = RequiredData,
                fromDate = chunkStart.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                toDate = chunkEnd.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            };

            using var response = await _api.SendAsync(HttpMethod.Post, "/charts/rollingoption", payload,
                $"rolling option candles ({underlyingSecurityId}, {expiryFlag}+{expiryCode}, {strike} {drvOptionType}, {chunkStart:yyyy-MM-dd}..{chunkEnd:yyyy-MM-dd})",
                cancellationToken);

            if (!response.Success)
            {
                _logger.LogWarning("Rolling option candle request failed for {Id} ({ExpiryFlag}+{ExpiryCode}, {Strike} {Side}, {From}..{To}) - {Error}",
                    underlyingSecurityId, expiryFlag, expiryCode, strike, drvOptionType, chunkStart, chunkEnd, response.ErrorMessage);
                return (all, response.ErrorMessage);
            }

            all.AddRange(ParseSide(response.Root, drvOptionType));

            chunkStart = chunkEnd.AddDays(1);
        }

        return (all, null);
    }

    private List<CandleWithVolume> ParseSide(JsonElement root, string drvOptionType)
    {
        var candles = new List<CandleWithVolume>();

        if (!root.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
            return candles;

        var sideKey = string.Equals(drvOptionType, "PUT", StringComparison.OrdinalIgnoreCase) ? "pe" : "ce";
        if (!data.TryGetProperty(sideKey, out var side) || side.ValueKind != JsonValueKind.Object)
            return candles; // The requested side simply has no data for this window - not an error.

        if (!side.TryGetProperty("timestamp", out var timestamps) || timestamps.ValueKind != JsonValueKind.Array)
            return candles;

        var open = GetArray(side, "open");
        var high = GetArray(side, "high");
        var low = GetArray(side, "low");
        var close = GetArray(side, "close");
        var volume = GetArray(side, "volume");

        var count = timestamps.GetArrayLength();
        for (var i = 0; i < count; i++)
        {
            try
            {
                // Same float-formatted-whole-number tolerance as DhanHistoricalDataService's own
                // candle parsing - GetInt64() throws outright on a literal like "1756698300.0".
                var epochSeconds = (long)timestamps[i].GetDouble();
                var o = i < open.Count ? open[i] : 0m;
                var h = i < high.Count ? high[i] : 0m;
                var l = i < low.Count ? low[i] : 0m;
                var c = i < close.Count ? close[i] : 0m;

                if (!OptionPriceSanity.IsPlausibleBar(o, h, l, c))
                {
                    _logger.LogWarning("Skipped an implausible rolling-option candle at index {Index} (O={Open} H={High} L={Low} C={Close}).", i, o, h, l, c);
                    continue;
                }

                candles.Add(new CandleWithVolume(
                    DateTimeOffset.FromUnixTimeSeconds(epochSeconds), o, h, l, c, i < volume.Count ? (long)volume[i] : 0));
            }
            catch (Exception ex) when (ex is FormatException or InvalidOperationException or OverflowException)
            {
                _logger.LogDebug(ex, "Skipped an unparsable rolling-option candle at index {Index}", i);
            }
        }

        return candles;
    }

    private static List<decimal> GetArray(JsonElement root, string propertyName)
    {
        var result = new List<decimal>();
        if (root.TryGetProperty(propertyName, out var array) && array.ValueKind == JsonValueKind.Array)
        {
            foreach (var element in array.EnumerateArray())
                result.Add(element.ValueKind == JsonValueKind.Number ? element.GetDecimal() : 0m);
        }
        return result;
    }
}

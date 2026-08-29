using System.Globalization;
using System.Text.Json;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// Dhan's Intraday Historical Data API (POST /v2/charts/intraday), used to backfill a chart with
/// today's candles before the live feed has produced enough of its own. Ported from
/// LiveSpreadCalculator's DhanHistoricalDataService, narrowed to the one instrument type this app
/// ever asks for: index spot ("INDEX" / "IDX_I").
///
/// Request/response shapes per Dhan's docs:
///   request:  {"securityId","exchangeSegment","instrument","interval","fromDate","toDate"}
///             fromDate/toDate are "yyyy-MM-dd HH:mm:ss" IST wall-clock, not UTC.
///   response: {"open":[...],"high":[...],"low":[...],"close":[...],"volume":[...],"timestamp":[...]}
///             - parallel arrays, one entry per candle; timestamp is Unix epoch seconds.
/// </summary>
public sealed class DhanHistoricalDataService
{
    private const string Instrument = "INDEX";

    private readonly DhanApiClient _api;
    private readonly ILogger<DhanHistoricalDataService> _logger;

    public DhanHistoricalDataService(DhanApiClient api, ILogger<DhanHistoricalDataService> logger)
    {
        _api = api;
        _logger = logger;
    }

    public async Task<IReadOnlyList<Candle>> GetIntradayCandlesAsync(
        uint securityId, string dhanSegment, DateOnly day, int intervalMinutes, CancellationToken cancellationToken)
    {
        if (!_api.HasSession)
        {
            _logger.LogWarning("Cannot fetch intraday candles for {Segment}:{Id} - Dhan is not authenticated (check Dhan:ClientId/Dhan:AccessToken).", dhanSegment, securityId);
            return Array.Empty<Candle>();
        }

        var payload = new
        {
            securityId = securityId.ToString(CultureInfo.InvariantCulture),
            exchangeSegment = dhanSegment,
            instrument = Instrument,
            interval = intervalMinutes.ToString(CultureInfo.InvariantCulture),
            fromDate = $"{day:yyyy-MM-dd} 09:15:00",
            toDate = $"{day:yyyy-MM-dd} 15:30:00",
        };

        using var response = await _api.SendAsync(HttpMethod.Post, "/charts/intraday", payload, $"intraday candles ({dhanSegment}:{securityId}, {day:yyyy-MM-dd})", cancellationToken);

        if (!response.Success)
        {
            _logger.LogWarning("Intraday candle request failed for {Segment}:{Id} on {Day} - {Error}", dhanSegment, securityId, day, response.ErrorMessage);
            return Array.Empty<Candle>();
        }

        return ParseCandles(response.Root);
    }

    private List<Candle> ParseCandles(JsonElement root)
    {
        var candles = new List<Candle>();
        if (!root.TryGetProperty("timestamp", out var timestamps) || timestamps.ValueKind != JsonValueKind.Array)
            return candles;

        var open = GetArray(root, "open");
        var high = GetArray(root, "high");
        var low = GetArray(root, "low");
        var close = GetArray(root, "close");

        var count = timestamps.GetArrayLength();
        for (var i = 0; i < count; i++)
        {
            try
            {
                var epochSeconds = timestamps[i].GetInt64();
                candles.Add(new Candle(
                    Time: DateTimeOffset.FromUnixTimeSeconds(epochSeconds),
                    Open: i < open.Count ? open[i] : 0m,
                    High: i < high.Count ? high[i] : 0m,
                    Low: i < low.Count ? low[i] : 0m,
                    Close: i < close.Count ? close[i] : 0m));
            }
            catch (Exception ex) when (ex is FormatException or InvalidOperationException or OverflowException)
            {
                _logger.LogDebug(ex, "Skipped an unparsable candle at index {Index}", i);
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

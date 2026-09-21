using System.Globalization;
using System.Text.Json;

namespace NiftyDataCollector.Dhan;

public sealed record DhanHistoricalBar(DateTimeOffset Time, decimal Open, decimal High, decimal Low, decimal Close, long Volume, long? OpenInterest);

/// <summary>
/// Dhan's Intraday Historical Data API (POST /v2/charts/intraday) - the one endpoint that can give
/// this collector actual OHLC HISTORY (up to 90 days per call, per Dhan's docs) for a specific
/// security, rather than a live-only snapshot. Ported from OptionAnalytics.Server's own
/// DhanHistoricalDataService's request/response shape, with one addition: the optional "oi": true
/// request field, which Dhan's docs describe as returning an "open_interest" array alongside
/// OHLCV for F&amp;O instruments.
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
/// </summary>
public sealed class DhanHistoricalDataClient
{
    private const string OptionInstrument = "OPTIDX";
    private const string IndexInstrument = "INDEX";

    private readonly DhanApiClient _api;
    private readonly ILogger<DhanHistoricalDataClient> _logger;

    public DhanHistoricalDataClient(DhanApiClient api, ILogger<DhanHistoricalDataClient> logger)
    {
        _api = api;
        _logger = logger;
    }

    public Task<(IReadOnlyList<DhanHistoricalBar> Bars, string? Error, string? RawJson)> GetSpotIntradayAsync(
        uint securityId, string dhanSegment, DateOnly fromDay, DateOnly toDay, int intervalMinutes, CancellationToken cancellationToken) =>
        FetchAsync(securityId, dhanSegment, IndexInstrument, fromDay, toDay, intervalMinutes, includeOi: false, cancellationToken);

    public Task<(IReadOnlyList<DhanHistoricalBar> Bars, string? Error, string? RawJson)> GetOptionIntradayAsync(
        uint securityId, string dhanSegment, DateOnly fromDay, DateOnly toDay, int intervalMinutes, CancellationToken cancellationToken) =>
        FetchAsync(securityId, dhanSegment, OptionInstrument, fromDay, toDay, intervalMinutes, includeOi: true, cancellationToken);

    private async Task<(IReadOnlyList<DhanHistoricalBar> Bars, string? Error, string? RawJson)> FetchAsync(
        uint securityId, string dhanSegment, string instrument, DateOnly fromDay, DateOnly toDay, int intervalMinutes, bool includeOi, CancellationToken cancellationToken)
    {
        var payload = new
        {
            securityId = securityId.ToString(CultureInfo.InvariantCulture),
            exchangeSegment = dhanSegment,
            instrument,
            interval = intervalMinutes.ToString(CultureInfo.InvariantCulture),
            oi = includeOi,
            fromDate = $"{fromDay:yyyy-MM-dd} 09:15:00",
            toDate = $"{toDay:yyyy-MM-dd} 15:30:00",
        };

        using var response = await _api.SendAsync(HttpMethod.Post, "/charts/intraday", payload,
            $"{instrument} intraday ({dhanSegment}:{securityId}, {fromDay:yyyy-MM-dd}..{toDay:yyyy-MM-dd})", cancellationToken);

        if (!response.Success)
        {
            _logger.LogDebug("{Instrument} intraday request failed for {Segment}:{Id} ({From}..{To}) - {Error}", instrument, dhanSegment, securityId, fromDay, toDay, response.ErrorMessage);
            return (Array.Empty<DhanHistoricalBar>(), response.ErrorMessage, response.RawBody);
        }

        return (ParseBars(response.Root), null, response.RawBody);
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

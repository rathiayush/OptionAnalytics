using System.Globalization;
using System.Text.Json;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// Dhan's Intraday Historical Data API (POST /v2/charts/intraday), used to backfill a chart's
/// in-memory history before the live feed has produced enough of its own - everything this app
/// holds is in-memory only, so this range call (rather than one call per day) is what fills the
/// last several trading days back into RAM on every restart. Ported from LiveSpreadCalculator's
/// DhanHistoricalDataService, narrowed to the one instrument type this app ever asks for: index
/// spot ("INDEX" / "IDX_I").
///
/// Request/response shapes per Dhan's docs:
///   request:  {"securityId","exchangeSegment","instrument","interval","fromDate","toDate"}
///             fromDate/toDate are "yyyy-MM-dd HH:mm:ss" IST wall-clock, not UTC. A single call
///             can span multiple calendar days - Dhan just returns every 09:15-15:30 session in
///             the window, which is what lets one request fill several trading days at once
///             instead of one request per day.
///   response: {"open":[...],"high":[...],"low":[...],"close":[...],"volume":[...],"timestamp":[...]}
///             - parallel arrays, one entry per candle across the whole range; timestamp is Unix
///             epoch seconds.
/// </summary>
public sealed class DhanHistoricalDataService
{
    private const string Instrument = "INDEX";
    private const string OptionInstrument = "OPTIDX";
    private const string FuturesInstrument = "FUTIDX";

    private readonly DhanApiClient _api;
    private readonly ILogger<DhanHistoricalDataService> _logger;

    public DhanHistoricalDataService(DhanApiClient api, ILogger<DhanHistoricalDataService> logger)
    {
        _api = api;
        _logger = logger;
    }

    /// <summary>Every candle Dhan has for [fromDay, toDay] inclusive (both IST calendar dates) -
    /// spans weekends/holidays fine, since Dhan simply has no data for those and they contribute
    /// nothing to the result.</summary>
    public async Task<IReadOnlyList<Candle>> GetIntradayCandlesAsync(
        uint securityId, string dhanSegment, DateOnly fromDay, DateOnly toDay, int intervalMinutes, CancellationToken cancellationToken)
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
            fromDate = $"{fromDay:yyyy-MM-dd} 09:15:00",
            toDate = $"{toDay:yyyy-MM-dd} 15:30:00",
        };

        using var response = await _api.SendAsync(HttpMethod.Post, "/charts/intraday", payload,
            $"intraday candles ({dhanSegment}:{securityId}, {fromDay:yyyy-MM-dd}..{toDay:yyyy-MM-dd})", cancellationToken);

        if (!response.Success)
        {
            _logger.LogWarning("Intraday candle request failed for {Segment}:{Id} ({From}..{To}) - {Error}", dhanSegment, securityId, fromDay, toDay, response.ErrorMessage);
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
                // Dhan sends timestamp as a JSON number, but not reliably as an integer literal -
                // it comes back as e.g. 1786938360.0 (a float-formatted whole number), which
                // JsonElement.GetInt64() rejects outright (it throws on any literal with a decimal
                // point, even a trailing ".0"). Going through GetDouble() first tolerates both
                // shapes; every one of the 4340-odd candles in a typical backfill was silently
                // dropped by the old GetInt64() call, since the per-candle catch below swallowed
                // that FormatException for each and every index.
                var epochSeconds = (long)timestamps[i].GetDouble();
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

    /// <summary>Same range-call shape as GetIntradayCandlesAsync, but for an option contract
    /// (instrument "OPTIDX", not "INDEX" - CDV's underlying spot backfill uses that method, this
    /// one is what CdvHostedService calls per strike) and carrying Volume too, since both OBV and
    /// the CDV backfill's bar-proxy delta classification need it and the plain Candle shape
    /// doesn't carry it.</summary>
    /// <summary>Returns the candles plus, when the call did not succeed, Dhan's own reason for it.
    /// The reason is surfaced rather than swallowed because a per-strike failure is logged at Debug
    /// (see below) and so is invisible at normal log level - which made "an entire underlying's
    /// option history is missing" indistinguishable from "those strikes simply didn't trade", with
    /// no way to tell which without turning on Debug logging in production. The caller aggregates
    /// these into one line per backfill batch.</summary>
    public Task<(IReadOnlyList<CandleWithVolume> Candles, string? Error)> GetIntradayOptionCandlesAsync(
        uint securityId, string dhanSegment, DateOnly fromDay, DateOnly toDay, int intervalMinutes, CancellationToken cancellationToken) =>
        GetIntradayDerivativeCandlesAsync(securityId, dhanSegment, OptionInstrument, fromDay, toDay, intervalMinutes, cancellationToken);

    /// <summary>The same call for an index FUTURE (instrument "FUTIDX") - what
    /// DhanFuturesInstrument exists for. An index carries no volume of its own, so this is the only
    /// route to a real traded-volume series for NIFTY/BANKNIFTY/SENSEX.</summary>
    public Task<(IReadOnlyList<CandleWithVolume> Candles, string? Error)> GetIntradayFuturesCandlesAsync(
        uint securityId, string dhanSegment, DateOnly fromDay, DateOnly toDay, int intervalMinutes, CancellationToken cancellationToken) =>
        GetIntradayDerivativeCandlesAsync(securityId, dhanSegment, FuturesInstrument, fromDay, toDay, intervalMinutes, cancellationToken);

    private async Task<(IReadOnlyList<CandleWithVolume> Candles, string? Error)> GetIntradayDerivativeCandlesAsync(
        uint securityId, string dhanSegment, string instrumentType, DateOnly fromDay, DateOnly toDay, int intervalMinutes, CancellationToken cancellationToken)
    {
        if (!_api.HasSession)
        {
            _logger.LogWarning("Cannot fetch intraday {Instrument} candles for {Segment}:{Id} - Dhan is not authenticated.", instrumentType, dhanSegment, securityId);
            return (Array.Empty<CandleWithVolume>(), "Dhan is not authenticated");
        }

        var payload = new
        {
            securityId = securityId.ToString(CultureInfo.InvariantCulture),
            exchangeSegment = dhanSegment,
            instrument = instrumentType,
            interval = intervalMinutes.ToString(CultureInfo.InvariantCulture),
            fromDate = $"{fromDay:yyyy-MM-dd} 09:15:00",
            toDate = $"{toDay:yyyy-MM-dd} 15:30:00",
        };

        using var response = await _api.SendAsync(HttpMethod.Post, "/charts/intraday", payload,
            $"{instrumentType} intraday candles ({dhanSegment}:{securityId}, {fromDay:yyyy-MM-dd}..{toDay:yyyy-MM-dd})", cancellationToken);

        if (!response.Success)
        {
            // Debug, not Warning - routine for a strike that simply didn't trade/exist for part of
            // the lookback window (added to the chain partway through, or never traded some days),
            // which CdvHostedService.RecenterAsync would otherwise log once per strike as noise.
            _logger.LogDebug("{Instrument} intraday candle request failed for {Segment}:{Id} ({From}..{To}) - {Error}", instrumentType, dhanSegment, securityId, fromDay, toDay, response.ErrorMessage);
            return (Array.Empty<CandleWithVolume>(), string.IsNullOrWhiteSpace(response.ErrorMessage) ? $"HTTP {(int)response.StatusCode}" : response.ErrorMessage);
        }

        return (ParseCandlesWithVolume(response.Root), null);
    }

    private List<CandleWithVolume> ParseCandlesWithVolume(JsonElement root)
    {
        var candles = new List<CandleWithVolume>();
        if (!root.TryGetProperty("timestamp", out var timestamps) || timestamps.ValueKind != JsonValueKind.Array)
            return candles;

        var open = GetArray(root, "open");
        var high = GetArray(root, "high");
        var low = GetArray(root, "low");
        var close = GetArray(root, "close");
        var volume = GetArray(root, "volume");

        var count = timestamps.GetArrayLength();
        for (var i = 0; i < count; i++)
        {
            try
            {
                var epochSeconds = (long)timestamps[i].GetDouble();
                var o = i < open.Count ? open[i] : 0m;
                var h = i < high.Count ? high[i] : 0m;
                var l = i < low.Count ? low[i] : 0m;
                var c = i < close.Count ? close[i] : 0m;

                // A corrupt bar from Dhan's own API - seen once as a premium chart whose price axis
                // blew out to the tens of millions while its real candles sat in the hundreds - must
                // never reach a chart, a backtest's entry/stop/target math, or a live order. Skipped
                // like an unparsable one below, just for implausibility rather than a parse failure -
                // see OptionPriceSanity's own doc comment for why this bound is safe against ever
                // rejecting a real premium.
                if (!OptionPriceSanity.IsPlausibleBar(o, h, l, c))
                {
                    _logger.LogWarning("Skipped an implausible option candle at index {Index} (O={Open} H={High} L={Low} C={Close}) - looks like corrupt upstream data, not a real premium.",
                        i, o, h, l, c);
                    continue;
                }

                candles.Add(new CandleWithVolume(
                    Time: DateTimeOffset.FromUnixTimeSeconds(epochSeconds),
                    Open: o,
                    High: h,
                    Low: l,
                    Close: c,
                    Volume: i < volume.Count ? (long)volume[i] : 0));
            }
            catch (Exception ex) when (ex is FormatException or InvalidOperationException or OverflowException)
            {
                _logger.LogDebug(ex, "Skipped an unparsable option candle at index {Index}", i);
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

using OptionAnalytics.Server.Services;
using System.Globalization;
using System.Net;
using System.Text.Json;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// Dhan's Intraday Historical Data API (POST /v2/charts/intraday), used to backfill a chart's
/// in-memory history before the live feed has produced enough of its own - everything this app
/// holds is in-memory only, so this range call (rather than one call per day) is what fills the
/// last several trading days back into RAM on every restart. Ported from LiveSpreadCalculator's
/// DhanHistoricalDataService, narrowed to the instrument types this app asks for: index spot
/// ("INDEX" / "IDX_I") and index options ("OPTIDX").
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
///
/// The "volume" array is now read for INDEX requests too, not just OPTIDX - Dhan rolled out real
/// index volume (sum of each index's constituent stocks' own traded volume, the same convention
/// NSE and TradingView use) across both its historical and live feeds in January 2026; before
/// that, an index genuinely had no traded volume of its own to report (indices aren't directly
/// tradeable), which is why this class used to discard the field outright for INDEX. See
/// VwapCalculator for what this unlocks.
/// </summary>
public sealed class DhanHistoricalDataService
{
    private const string Instrument = "INDEX";
    private const string OptionInstrument = "OPTIDX";
    private const string FuturesInstrument = "FUTIDX";

    private readonly DhanApiClient _api;
    private readonly ILogger<DhanHistoricalDataService> _logger;
    private readonly DhanDataCache? _cache;

    /// <summary><paramref name="cache"/>: a past window's response is kept on disk and answered from there next time
    /// (DhanDataCache) - null = every call goes to Dhan.</summary>
    public DhanHistoricalDataService(DhanApiClient api, ILogger<DhanHistoricalDataService> logger, DhanDataCache? cache = null)
    {
        _api = api;
        _logger = logger;
        _cache = cache;
    }

    private const string IntradayPath = "/charts/intraday";

    /// <summary>A cached response read back as Dhan's own (the parsing below cannot tell them apart).</summary>
    private static DhanApiResponse FromCache(JsonDocument doc) => new(true, HttpStatusCode.OK, doc, null);

    /// <summary>Every candle Dhan has for [fromDay, toDay] inclusive (both IST calendar dates) -
    /// spans weekends/holidays fine, since Dhan simply has no data for those and they contribute
    /// nothing to the result. Error carries Dhan's own reason when the call itself failed (auth,
    /// rate limit, a window Dhan's intraday endpoint won't serve) - null when it succeeded, even if
    /// that meant zero candles (a real closed market span). Surfaced so a caller with its own error
    /// budget (ExpiredOptionBacktestService's own Failed() message, in particular) can report the
    /// ACTUAL reason instead of guessing at one.
    ///
    /// Returns CandleWithVolume, not the plain Candle this used to return - Dhan now sends real
    /// index volume too (see this class's own doc comment). A caller that only ever wanted OHLC can
    /// still get that via CandleWithVolume.ToCandle(); one computing VWAP (VwapCalculator) needs the
    /// Volume this shape carries.</summary>
    /// <summary>The end of an intraday request ending on `to`: the session's close (15:30) - except a request ending TODAY
    /// while the session is still on, which ends at the minute after `now` (never before 09:16): no minute after now
    /// exists yet, and a range running into the future is not asked of Dhan at all (Dhan answered such a request,
    /// for the spot and the futures alike, with Input_Exception DH-905 on 23 Oct 2026).</summary>
    internal static string IntradayToDate(DateOnly to, DateTimeOffset now)
    {
        var ist = now.ToOffset(IstClock.Offset);
        var close = new TimeOnly(15, 30);
        var time = TimeOnly.FromDateTime(ist.DateTime);
        if (DateOnly.FromDateTime(ist.DateTime) != to || time >= close)
            return $"{to:yyyy-MM-dd} 15:30:00";
        var end = new TimeOnly(time.Hour, time.Minute).AddMinutes(1);
        if (end < new TimeOnly(9, 16)) end = new TimeOnly(9, 16);
        return $"{to:yyyy-MM-dd} {end:HH:mm}:00";
    }

    public async Task<(IReadOnlyList<CandleWithVolume> Candles, string? Error)> GetIntradayCandlesAsync(
        uint securityId, string dhanSegment, DateOnly fromDay, DateOnly toDay, int intervalMinutes, CancellationToken cancellationToken, bool interactive = true)
    {
        var id = securityId.ToString(CultureInfo.InvariantCulture);
        var interval = intervalMinutes.ToString(CultureInfo.InvariantCulture);
        // The request without its dates names the series on disk (one file per day); the payload is Dhan's request (and
        // the key of an older whole-window file).
        var key = new { securityId = id, exchangeSegment = dhanSegment, instrument = Instrument, interval };
        object PayloadFor(DateOnly from, DateOnly to) => new
        {
            securityId = id,
            exchangeSegment = dhanSegment,
            instrument = Instrument,
            interval,
            fromDate = $"{from:yyyy-MM-dd} 09:15:00",
            toDate = IntradayToDate(to, DateTimeOffset.UtcNow),
        };

        var (parts, error) = await IntradayPartsAsync(key, PayloadFor, fromDay, toDay, intervalMinutes, $"intraday candles ({dhanSegment}:{securityId})", LogLevel.Warning, interactive, cancellationToken);
        var candles = new List<CandleWithVolume>();
        foreach (var part in parts) using (part) candles.AddRange(ParseCandlesWithVolume(part.Root));
        return (candles.OrderBy(c => c.Time).ToList(), error);
    }

    /// <summary>Same range-call shape as GetIntradayCandlesAsync, but for an option contract
    /// (instrument "OPTIDX", not "INDEX" - CDV's underlying spot backfill uses that method, this
    /// one is what CdvHostedService calls per strike). Returns the candles plus, when the call did
    /// not succeed, Dhan's own reason for it. The reason is surfaced rather than swallowed because a
    /// per-strike failure is logged at Debug (see below) and so is invisible at normal log level -
    /// which made "an entire underlying's option history is missing" indistinguishable from "those
    /// strikes simply didn't trade", with no way to tell which without turning on Debug logging in
    /// production. The caller aggregates these into one line per backfill batch.</summary>
    public Task<(IReadOnlyList<CandleWithVolume> Candles, string? Error)> GetIntradayOptionCandlesAsync(
        uint securityId, string dhanSegment, DateOnly fromDay, DateOnly toDay, int intervalMinutes, CancellationToken cancellationToken, bool interactive = true) =>
        GetIntradayDerivativeCandlesAsync(securityId, dhanSegment, OptionInstrument, fromDay, toDay, intervalMinutes, cancellationToken, interactive);

    /// <summary>OHLC + volume + (best-effort) open interest for one futures contract - the OI
    /// Replay page's own "show me the futures too" chart. UNLIKE GetIntradayOptionCandlesAsync,
    /// this passes "oi": true - Dhan's docs describe this flag as returning historical
    /// open_interest for a derivative instrument, but this app has never actually exercised it
    /// before now (every other OI-aware fetch here goes through DhanRollingOptionDataService's own
    /// /charts/rollingoption instead, which is confirmed to return OI). OiFieldPresent tells the
    /// caller whether Dhan's response actually included an "open_interest" array at all, so a
    /// genuine "this endpoint doesn't return OI for futures" can be told apart from "OI was 0/
    /// missing for these particular bars" - the first is a page-level "OI not available" message,
    /// the second is normal, unremarkable missing data.</summary>
    public Task<(IReadOnlyList<(CandleWithVolume Bar, long? OpenInterest)> Bars, bool OiFieldPresent, string? Error)> GetIntradayFuturesCandlesAsync(
        uint securityId, string dhanSegment, DateOnly fromDay, DateOnly toDay, int intervalMinutes, CancellationToken cancellationToken, bool interactive = true) =>
        GetIntradayWithOiAsync(securityId, dhanSegment, FuturesInstrument, "futures", fromDay, toDay, intervalMinutes, cancellationToken, interactive);

    /// <summary>One option CONTRACT's (an actual security id) 1-minute bars with open interest - /charts/intraday with
    /// "oi": true, its toDate capped at now like every intraday call. TODAY's option series for the OI Replay come from here:
    /// the rolling (expired-options) endpoint takes whole days with a non-inclusive toDate, so today needed toDate =
    /// tomorrow - a future date Dhan refuses with DH-905 Input_Exception.</summary>
    public Task<(IReadOnlyList<(CandleWithVolume Bar, long? OpenInterest)> Bars, bool OiFieldPresent, string? Error)> GetIntradayOptionCandlesWithOiAsync(
        uint securityId, string dhanSegment, DateOnly fromDay, DateOnly toDay, int intervalMinutes, CancellationToken cancellationToken, bool interactive = true) =>
        GetIntradayWithOiAsync(securityId, dhanSegment, OptionInstrument, "option", fromDay, toDay, intervalMinutes, cancellationToken, interactive);

    private async Task<(IReadOnlyList<(CandleWithVolume Bar, long? OpenInterest)> Bars, bool OiFieldPresent, string? Error)> GetIntradayWithOiAsync(
        uint securityId, string dhanSegment, string instrumentType, string what, DateOnly fromDay, DateOnly toDay, int intervalMinutes, CancellationToken cancellationToken, bool interactive)
    {
        var id = securityId.ToString(CultureInfo.InvariantCulture);
        var interval = intervalMinutes.ToString(CultureInfo.InvariantCulture);
        var key = new { securityId = id, exchangeSegment = dhanSegment, instrument = instrumentType, interval, oi = true };
        object PayloadFor(DateOnly from, DateOnly to) => new
        {
            securityId = id,
            exchangeSegment = dhanSegment,
            instrument = instrumentType,
            interval,
            fromDate = $"{from:yyyy-MM-dd} 09:15:00",
            toDate = IntradayToDate(to, DateTimeOffset.UtcNow),
            oi = true,
        };

        var (parts, error) = await IntradayPartsAsync(key, PayloadFor, fromDay, toDay, intervalMinutes, $"{what} intraday candles ({dhanSegment}:{securityId})", LogLevel.Warning, interactive, cancellationToken);
        var bars = new List<(CandleWithVolume Bar, long? OpenInterest)>();
        var oiFieldPresent = false;
        foreach (var part in parts)
        {
            using (part)
            {
                oiFieldPresent |= part.Root.TryGetProperty("open_interest", out _);
                bars.AddRange(ParseCandlesWithOpenInterest(part.Root));
            }
        }
        return (bars.OrderBy(b => b.Bar.Time).ToList(), oiFieldPresent, error);
    }

    private List<(CandleWithVolume Bar, long? OpenInterest)> ParseCandlesWithOpenInterest(JsonElement root)
    {
        var candles = new List<(CandleWithVolume, long?)>();
        if (!root.TryGetProperty("timestamp", out var timestamps) || timestamps.ValueKind != JsonValueKind.Array)
            return candles;

        var open = GetArray(root, "open");
        var high = GetArray(root, "high");
        var low = GetArray(root, "low");
        var close = GetArray(root, "close");
        var volume = GetArray(root, "volume");
        var openInterest = GetArray(root, "open_interest");

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

                if (!OptionPriceSanity.IsPlausibleBar(o, h, l, c))
                {
                    _logger.LogWarning("Skipped an implausible futures candle at index {Index} (O={Open} H={High} L={Low} C={Close}).", i, o, h, l, c);
                    continue;
                }

                var oi = i < openInterest.Count && openInterest[i] > 0 ? (long?)openInterest[i] : null;
                candles.Add((new CandleWithVolume(
                    Time: DateTimeOffset.FromUnixTimeSeconds(epochSeconds),
                    Open: o, High: h, Low: l, Close: c,
                    Volume: i < volume.Count ? (long)volume[i] : 0), oi));
            }
            catch (Exception ex) when (ex is FormatException or InvalidOperationException or OverflowException)
            {
                _logger.LogDebug(ex, "Skipped an unparsable futures candle at index {Index}", i);
            }
        }

        return candles;
    }

    private async Task<(IReadOnlyList<CandleWithVolume> Candles, string? Error)> GetIntradayDerivativeCandlesAsync(
        uint securityId, string dhanSegment, string instrumentType, DateOnly fromDay, DateOnly toDay, int intervalMinutes, CancellationToken cancellationToken, bool interactive)
    {
        var id = securityId.ToString(CultureInfo.InvariantCulture);
        var interval = intervalMinutes.ToString(CultureInfo.InvariantCulture);
        var key = new { securityId = id, exchangeSegment = dhanSegment, instrument = instrumentType, interval };
        object PayloadFor(DateOnly from, DateOnly to) => new
        {
            securityId = id,
            exchangeSegment = dhanSegment,
            instrument = instrumentType,
            interval,
            fromDate = $"{from:yyyy-MM-dd} 09:15:00",
            toDate = IntradayToDate(to, DateTimeOffset.UtcNow),
        };

        // A failure at Debug, not Warning - routine for a strike that simply didn't trade/exist for part of the lookback
        // window (added to the chain partway through, or never traded some days), which CdvHostedService.RecenterAsync
        // would otherwise log once per strike as noise.
        var (parts, error) = await IntradayPartsAsync(key, PayloadFor, fromDay, toDay, intervalMinutes, $"{instrumentType} intraday candles ({dhanSegment}:{securityId})", LogLevel.Debug, interactive, cancellationToken);
        var candles = new List<CandleWithVolume>();
        foreach (var part in parts) using (part) candles.AddRange(ParseCandlesWithVolume(part.Root));
        return (candles.OrderBy(c => c.Time).ToList(), error);
    }

    /// <summary>The answer as it is - /charts/intraday's arrays are its root.</summary>
    private static Action<Utf8JsonWriter> AsIs(Action<Utf8JsonWriter> day) => day;

    /// <summary>Dhan's candles for [fromDay, toDay] as parts of its answer: each closed day kept on disk read from there
    /// (one file per day - DhanDayWindow), the rest asked of Dhan in ONE call and each final day of it kept - so a window
    /// running into today (a chart backfill) still keeps its past days and any other window holding one of them reads it
    /// from disk. A day not kept yet is read from an older whole-window file of this very request where there is one (and
    /// kept). On a failed call: the
    /// days read from disk and Dhan's reason (the caller disposes the parts).</summary>
    private async Task<(List<DhanApiResponse> Parts, string? Error)> IntradayPartsAsync(
        object key, Func<DateOnly, DateOnly, object> payloadFor, DateOnly fromDay, DateOnly toDay, int intervalMinutes, string what,
        LogLevel failureLevel, bool interactive, CancellationToken cancellationToken)
    {
        var (parts, ask) = DhanDayWindow.Plan(_cache, IntradayPath, key, fromDay, toDay);
        if (ask is not { } span)
        {
            LoadProgress.FromDisk();
            LoadProgress.Info($"{what}: from disk");
            return (parts, null);
        }

        // A day not kept yet may be in an older whole-window file of this very request: read, and its days kept.
        var whole = _cache?.TryGet(IntradayPath, payloadFor(fromDay, toDay), toDay);
        if (whole is not null)
        {
            LoadProgress.FromDisk();
            LoadProgress.Info($"{what}: from disk");
            foreach (var part in parts) part.Dispose();
            var kept = FromCache(whole);
            DhanDayWindow.Keep(_cache, IntradayPath, key, fromDay, toDay, kept.Root, AsIs, intervalMinutes);
            return (new List<DhanApiResponse> { kept }, null);
        }
        if (!_api.HasSession)
        {
            _logger.LogWarning("Cannot fetch {What} - Dhan is not authenticated (check Dhan:ClientId/Dhan:AccessToken).", what);
            return (parts, "Dhan is not authenticated");
        }

        LoadProgress.DhanCall();
        LoadProgress.Info($"→ Dhan: {what}, {span.From:dd MMM}{(span.To != span.From ? $"..{span.To:dd MMM}" : "")}");
        var clock = System.Diagnostics.Stopwatch.StartNew();
        // DhanApiClient's pipeline takes the slot on Dhan's shared limit (in this call's lane), asks again after Dhan's "too
        // many requests" and gives up after its DataCallTimeout from when the call went - a failure comes back as one.
        var response = await _api.SendAsync(HttpMethod.Post, IntradayPath, payloadFor(span.From, span.To), $"{what}, {span.From:yyyy-MM-dd}..{span.To:yyyy-MM-dd}", cancellationToken, interactive);
        if (!response.Success)
        {
            LoadProgress.Error($"✗ Dhan: {what} - {response.ErrorMessage ?? $"HTTP {(int)response.StatusCode}"}");
            _logger.Log(failureLevel, "Request for {What} ({From}..{To}) failed - {Error}", what, span.From, span.To, response.ErrorMessage);
            var error = string.IsNullOrWhiteSpace(response.ErrorMessage) ? $"HTTP {(int)response.StatusCode}" : response.ErrorMessage;
            response.Dispose();
            return (parts, error);
        }
        DhanDayWindow.Keep(_cache, IntradayPath, key, span.From, span.To, response.Root, AsIs, intervalMinutes);
        LoadProgress.Ok($"✓ Dhan: {what} in {clock.Elapsed.TotalSeconds:0.0} s");
        parts.Add(response);
        return (parts, null);
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
                // see OptionPriceSanity's own doc comment for why this bound (100,000) is safe
                // against ever rejecting a real premium OR a real NIFTY/BANKNIFTY index level, both
                // of which sit comfortably under it.
                if (!OptionPriceSanity.IsPlausibleBar(o, h, l, c))
                {
                    _logger.LogWarning("Skipped an implausible candle at index {Index} (O={Open} H={High} L={Low} C={Close}) - looks like corrupt upstream data, not a real price.",
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

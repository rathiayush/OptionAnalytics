using System.Globalization;
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

    /// <summary>Bounds how long ANY single call to this endpoint may hang waiting for Dhan before
    /// giving up - deliberately much shorter than HttpClient's own default ~100s request timeout,
    /// which DhanApiClient's shared HttpClient does NOT override (that HttpClient is also used by
    /// live order placement - DhanOrderClient/DhanSuperOrderClient/DhanPositionsClient - so this
    /// stays scoped to a per-call CancellationTokenSource here instead of touching that shared
    /// Timeout, which would affect those too).
    ///
    /// Added after a real deployment showed a page that "never loads": a genuinely slow/unresponsive
    /// Dhan connection (network issue, or Dhan itself briefly unresponsive) let a single call hang
    /// the full ~100s default before failing - and OiReplayService's own bounded concurrency (10 in
    /// flight at once, across up to 44 calls for one day) meant a run of bad luck could stretch a
    /// single page load past EIGHT MINUTES before ever producing an error. A much shorter, explicit
    /// timeout per call turns that into "fails within about a minute with a clear message" instead.</summary>
    private static readonly TimeSpan CallTimeout = TimeSpan.FromSeconds(20);

    private readonly DhanApiClient _api;
    private readonly DhanDataApiRateLimiter _rateLimiter;
    private readonly ILogger<DhanHistoricalDataService> _logger;

    public DhanHistoricalDataService(DhanApiClient api, DhanDataApiRateLimiter rateLimiter, ILogger<DhanHistoricalDataService> logger)
    {
        _api = api;
        _rateLimiter = rateLimiter;
        _logger = logger;
    }

    /// <summary>Waits for a rate-limit permit, then sends the call under its own CallTimeout -
    /// returning a (null Response, timeout Error) pair rather than letting the timeout escape as an
    /// exception. This matters: DhanApiClient.SendOnceAsync's own catch clause deliberately excludes
    /// OperationCanceledException (so a CALLER's real cancellation propagates rather than being
    /// swallowed as a graceful "failed" result) - but HttpClient's OWN internal timeout ALSO throws
    /// a TaskCanceledException (a kind of OperationCanceledException), which is indistinguishable at
    /// that layer from a genuine cancellation. Left uncaught, that used to propagate all the way up
    /// through OiReplayService's Task.WhenAll and out of the ASP.NET Core action with no exception
    /// handler configured to catch it - exactly the silent, no-error hang this class exists to
    /// prevent now. Checking cancellationToken.IsCancellationRequested (the CALLER's own token, not
    /// the linked one this method creates) is what tells a genuine cancellation apart from this
    /// method's own timeout firing.</summary>
    private async Task<(DhanApiResponse? Response, string? Error)> SendDataApiCallAsync(
        string path, object payload, string context, bool interactive, CancellationToken cancellationToken)
    {
        // Dhan's rate limit (429 / DH-904) is waited out and tried again (2 s, 4 s, 8 s) - one busy moment used to fail
        // the whole call (a past day's spot / futures, so the day). Anything else returns at once.
        for (var attempt = 0; ; attempt++)
        {
            await _rateLimiter.WaitForPermitAsync(interactive, cancellationToken);

            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutCts.CancelAfter(CallTimeout);
            DhanApiResponse response;
            try
            {
                response = await _api.SendAsync(HttpMethod.Post, path, payload, context, timeoutCts.Token);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                _logger.LogWarning("Dhan call timed out after {Seconds}s with no response ({Context}).", CallTimeout.TotalSeconds, context);
                return (null, $"Dhan did not respond within {CallTimeout.TotalSeconds:0}s - it may be slow or unreachable right now.");
            }
            if (response.Success || attempt >= DhanDataApiRateLimiter.RateLimitRetries || !DhanDataApiRateLimiter.IsRateLimited((int)response.StatusCode, response.ErrorMessage))
                return (response, null);
            var delay = DhanDataApiRateLimiter.RateLimitBackoff(attempt);
            _logger.LogInformation("Rate-limited on {Context} (attempt {Attempt}/{Max}) - waiting {Delay} before retrying.", context, attempt + 1, DhanDataApiRateLimiter.RateLimitRetries, delay);
            response.Dispose();
            await Task.Delay(delay, cancellationToken);
        }
    }


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
    public async Task<(IReadOnlyList<CandleWithVolume> Candles, string? Error)> GetIntradayCandlesAsync(
        uint securityId, string dhanSegment, DateOnly fromDay, DateOnly toDay, int intervalMinutes, CancellationToken cancellationToken, bool interactive = true)
    {
        if (!_api.HasSession)
        {
            _logger.LogWarning("Cannot fetch intraday candles for {Segment}:{Id} - Dhan is not authenticated (check Dhan:ClientId/Dhan:AccessToken).", dhanSegment, securityId);
            return (Array.Empty<CandleWithVolume>(), "Dhan is not authenticated");
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

        var (response, timeoutError) = await SendDataApiCallAsync("/charts/intraday", payload,
            $"intraday candles ({dhanSegment}:{securityId}, {fromDay:yyyy-MM-dd}..{toDay:yyyy-MM-dd})", interactive, cancellationToken);
        if (response is null) return (Array.Empty<CandleWithVolume>(), timeoutError);
        using (response)
        {
            if (!response.Success)
            {
                _logger.LogWarning("Intraday candle request failed for {Segment}:{Id} ({From}..{To}) - {Error}", dhanSegment, securityId, fromDay, toDay, response.ErrorMessage);
                return (Array.Empty<CandleWithVolume>(), string.IsNullOrWhiteSpace(response.ErrorMessage) ? $"HTTP {(int)response.StatusCode}" : response.ErrorMessage);
            }

            return (ParseCandlesWithVolume(response.Root), null);
        }
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
    public async Task<(IReadOnlyList<(CandleWithVolume Bar, long? OpenInterest)> Bars, bool OiFieldPresent, string? Error)> GetIntradayFuturesCandlesAsync(
        uint securityId, string dhanSegment, DateOnly fromDay, DateOnly toDay, int intervalMinutes, CancellationToken cancellationToken, bool interactive = true)
    {
        if (!_api.HasSession)
        {
            _logger.LogWarning("Cannot fetch intraday futures candles for {Segment}:{Id} - Dhan is not authenticated.", dhanSegment, securityId);
            return (Array.Empty<(CandleWithVolume, long?)>(), false, "Dhan is not authenticated");
        }

        var payload = new
        {
            securityId = securityId.ToString(CultureInfo.InvariantCulture),
            exchangeSegment = dhanSegment,
            instrument = FuturesInstrument,
            interval = intervalMinutes.ToString(CultureInfo.InvariantCulture),
            fromDate = $"{fromDay:yyyy-MM-dd} 09:15:00",
            toDate = $"{toDay:yyyy-MM-dd} 15:30:00",
            oi = true,
        };

        var (response, timeoutError) = await SendDataApiCallAsync("/charts/intraday", payload,
            $"futures intraday candles ({dhanSegment}:{securityId}, {fromDay:yyyy-MM-dd}..{toDay:yyyy-MM-dd})", interactive, cancellationToken);
        if (response is null) return (Array.Empty<(CandleWithVolume, long?)>(), false, timeoutError);
        using (response)
        {
            if (!response.Success)
            {
                _logger.LogWarning("Futures intraday candle request failed for {Segment}:{Id} ({From}..{To}) - {Error}", dhanSegment, securityId, fromDay, toDay, response.ErrorMessage);
                return (Array.Empty<(CandleWithVolume, long?)>(), false, string.IsNullOrWhiteSpace(response.ErrorMessage) ? $"HTTP {(int)response.StatusCode}" : response.ErrorMessage);
            }

            var oiFieldPresent = response.Root.TryGetProperty("open_interest", out _);
            return (ParseCandlesWithOpenInterest(response.Root), oiFieldPresent, null);
        }
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

        var (response, timeoutError) = await SendDataApiCallAsync("/charts/intraday", payload,
            $"{instrumentType} intraday candles ({dhanSegment}:{securityId}, {fromDay:yyyy-MM-dd}..{toDay:yyyy-MM-dd})", interactive, cancellationToken);
        if (response is null) return (Array.Empty<CandleWithVolume>(), timeoutError);
        using (response)
        {
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

using System.Globalization;
using System.Text.Json;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;

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
///             "OPTIDX","expiryFlag":"WEEK"|"MONTH","expiryCode" (1,2,3... - NEVER 0, confirmed by
///             a real call: Dhan rejected expiryCode=0 outright as "expiryCode is required", the
///             same error a required-field check gives a value it treats as absent - see
///             ExpiredOptionBacktestService.ComputeExpiryCode for how this app derives it from an
///             actual calendar expiry date), "strike":"ATM"|"ATM+-1".."ATM+-10","drvOptionType":
///             "CALL"|"PUT","requiredData":[...],"fromDate","toDate"} (fromDate/toDate are plain
///             "yyyy-MM-dd", unlike /charts/intraday's date-TIME strings - this endpoint has no
///             intraday session concept, one bar's "day" is the calendar date its relative expiry
///             was resolved against). Capped by Dhan at 30 days per call.
///
///             toDate is explicitly documented as NON-INCLUSIVE ("End date of the desired range
///             (non-inclusive)") - the opposite of every other date range in this app - so this
///             method's own toDay parameter stays INCLUSIVE (consistent with
///             DhanHistoricalDataService.GetIntradayCandlesAsync and everything else here) and adds
///             a day when building each chunk's own outgoing "toDate" instead. Confirmed as a real
///             bug, not a theoretical one: without it, a caller's toDay (typically the target
///             expiry date itself) was silently missing from every response.
///
///             The "rolls across contracts" behavior above is likewise not just theoretical: a real
///             run's returned series showed large premium jumps landing exactly at day boundaries
///             (one day's last print to the next day's first), spaced roughly one expiry cycle
///             apart - the signature of an old, about-to-expire contract hitting a fresh one, not
///             one contract's own continuous decay. ExpiredOptionBacktestService trims each side's
///             series down to the segment after its own LAST such jump before handing it to a
///             strategy, so the backtest only ever sees the single contract nearest the requested
///             expiry, regardless of how wide a lookback was requested.
///   response: {"data":{"ce":{"open":[...],"high":[...],...,"timestamp":[...]},"pe":null-or-same}}
///             - requesting drvOptionType CALL fills "ce" and leaves "pe" null (and vice versa for
///             PUT), so getting both sides costs two calls, not one.
///
/// expiryCode's exact semantics are NOT fully spelled out in Dhan's docs beyond a single worked
/// example (expiryCode 1, querying August 2021 - a small positive number for a multi-year-old date,
/// which only makes sense if it counts forward from the query's OWN date range rather than from
/// today). Confirmed independently against a real cached Dhan scrip master: SEM_EXPIRY_CODE is "0"
/// for every single index-option row in it, an unrelated legacy futures column, not this parameter.
/// One thing IS now confirmed against a live call, not just inferred: expiryCode is 1-indexed, and
/// 0 is rejected outright (see above) rather than meaning "the nearest expiry" as this app first
/// assumed - still build defensively for anything beyond that, and let Dhan's own error message
/// surface immediately if some other assumption here turns out wrong too.
/// </summary>
public sealed class DhanRollingOptionDataService : IRollingOptionDataSource
{
    private const string OptionInstrument = "OPTIDX";

    /// <summary>NIFTY/BANKNIFTY's option chain trades on NSE ("NSE_FNO"); SENSEX's trades on BSE
    /// ("BSE_FNO") - the same per-underlying exchange split DhanOptionChainMaster/
    /// DhanFuturesInstrumentMaster already carry, applied here too now that OiReplayService supports
    /// SENSEX as an always-live underlying. UNCONFIRMED against a real Dhan call for THIS specific
    /// endpoint as of this change - Dhan's own /charts/rollingoption docs only ever show NSE_FNO in
    /// their one worked example, which is exactly why ExpiredOptionBacktestService's own
    /// StrikeStepByUnderlying deliberately left SENSEX out rather than guess. If Dhan rejects
    /// BSE_FNO here, the failure surfaces as a plain Dhan error string on the page (see
    /// SendWithRateLimitRetryAsync), not a crash - worth confirming with a real run.</summary>
    private static string ResolveFnoSegment(string underlying) =>
        string.Equals(underlying, "SENSEX", StringComparison.OrdinalIgnoreCase) ? "BSE_FNO" : "NSE_FNO";
    // "strike" asks Dhan to report the ACTUAL absolute strike it resolved "ATM+-K" to for every
    // bar - without this, this app has no way to check whether Dhan's own contract resolution
    // actually landed anywhere near what it asked for, which is exactly the kind of silent mismatch
    // an implausible entry price (a "near-ATM" option priced in the thousands) would otherwise be.
    // "spot" is the underlying spot price Dhan itself used to resolve "ATM+-K" for that SAME bar -
    // strictly better than this app's own nearest-earlier-match against a separately fetched spot
    // series (ExpiredOptionBacktestService's spotBars1m), since it is exactly what Dhan used, not an
    // approximation of it.
    // "oi"/"iv" - this endpoint's own documented open_interest/implied_volatility history (see
    // NiftyDataCollector's DhanRollingOptionClient doc comment, which first confirmed this endpoint
    // genuinely returns OI/IV history, unlike /optionchain or /charts/intraday) - added so an
    // OI/IV-aware strategy filter (e.g. OrbOrderBlockStrategy's own OI-wall/IV-spike options) has
    // real data to read on this side too, at no extra Dhan call cost (same response, same request).
    private static readonly string[] RequiredData = { "open", "high", "low", "close", "volume", "strike", "spot", "oi", "iv" };

    // Dhan's own stated cap (see the endpoint's docs) - chunked into successive calls so a caller
    // can still ask for a range wider than one call supports, rather than needing to paginate it.
    private const int MaxChunkDays = 30;

    // Spacing between successive chunk calls, and between a rate-limited chunk's own retries - a
    // multi-month lookback can need several chunks per side, and CallerService (see
    // ExpiredOptionBacktestService) fetches CE and PE back to back, so without any pacing at all a
    // single Run click can burst 4-6+ requests at Dhan in well under a second. Same idea as
    // BacktestService.OnDemandCallDelay, just a little more generous since a live-money order-flow
    // call is not competing for the same budget here.
    private static readonly TimeSpan ChunkDelay = TimeSpan.FromMilliseconds(350);
    private const int MaxRateLimitRetries = 3;
    private static readonly TimeSpan RateLimitRetryDelay = TimeSpan.FromSeconds(2);

    private readonly DhanApiClient _api;
    private readonly ILogger<DhanRollingOptionDataService> _logger;

    public DhanRollingOptionDataService(DhanApiClient api, ILogger<DhanRollingOptionDataService> logger)
    {
        _api = api;
        _logger = logger;
    }

    /// <summary>Every bar for [fromDay,toDay] inclusive, one relative contract
    /// (expiryFlag/expiryCode/strike/drvOptionType), chunked transparently across Dhan's 30-day
    /// per-call cap. Stops and returns whatever already succeeded plus Dhan's own error the moment
    /// one chunk fails, rather than silently discarding partial history.
    ///
    /// Each bar carries the ABSOLUTE strike Dhan itself resolved "ATM+-K" to for that specific bar
    /// (null only if Dhan's response omitted it) - the caller's own sanity check against what it
    /// expected that resolution to be, since nothing else here can otherwise tell a genuinely-priced
    /// but unexpected contract apart from a resolution that landed on the wrong one entirely. It also
    /// carries the underlying SPOT price Dhan itself used to resolve that same bar (null if Dhan's
    /// response omitted it) - lets a caller verify the resolved strike EXACTLY (against Dhan's own
    /// spot for that bar) instead of only approximately (against a separately fetched spot series
    /// matched to the nearest earlier bar).</summary>
    public async Task<(IReadOnlyList<(CandleWithVolume Bar, decimal? Strike, decimal? Spot, long? OpenInterest, decimal? ImpliedVolatility)> Bars, string? Error)> GetRollingOptionCandlesAsync(
        string underlying, uint underlyingSecurityId, string expiryFlag, int expiryCode, string strike, string drvOptionType,
        DateOnly fromDay, DateOnly toDay, int intervalMinutes, CancellationToken cancellationToken)
    {
        // `underlying` used to be unused here (this implementation identifies the CONTRACT by
        // underlyingSecurityId, not by name) - now also read once, just to pick the right exchange
        // segment below (see ResolveFnoSegment), since Dhan itself needs that distinguished by name.
        if (!_api.HasSession)
            return (Array.Empty<(CandleWithVolume, decimal?, decimal?, long?, decimal?)>(), "Dhan is not authenticated (check Dhan:ClientId/Dhan:AccessToken).");

        if (toDay < fromDay)
            return (Array.Empty<(CandleWithVolume, decimal?, decimal?, long?, decimal?)>(), "'to' date must not be before 'from' date.");

        var all = new List<(CandleWithVolume Bar, decimal? Strike, decimal? Spot, long? OpenInterest, decimal? ImpliedVolatility)>();
        var chunkStart = fromDay;
        var isFirstChunk = true;

        while (chunkStart <= toDay)
        {
            var chunkEnd = chunkStart.AddDays(MaxChunkDays - 1);
            if (chunkEnd > toDay) chunkEnd = toDay;

            // Paced, not back to back - see ChunkDelay's own doc comment. Skipped before the very
            // first chunk only; every chunk after that (including a retry below) waits first.
            if (!isFirstChunk) await Task.Delay(ChunkDelay, cancellationToken);
            isFirstChunk = false;

            var payload = new
            {
                exchangeSegment = ResolveFnoSegment(underlying),
                interval = intervalMinutes.ToString(CultureInfo.InvariantCulture),
                securityId = underlyingSecurityId,
                instrument = OptionInstrument,
                expiryFlag,
                expiryCode,
                strike,
                drvOptionType,
                requiredData = RequiredData,
                fromDate = chunkStart.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                // +1 day - Dhan's own docs state toDate is NON-INCLUSIVE ("End date of the desired
                // range (non-inclusive)"), unlike every other date range in this app (GetIntradayCa
                // ndlesAsync's toDay, this method's own toDay parameter, both inclusive). Sending
                // chunkEnd as-is would silently drop chunkEnd's own trading day entirely - most
                // often the exact day that matters, since a caller's toDay is typically the target
                // expiry date itself.
                toDate = chunkEnd.AddDays(1).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            };
            var context = $"rolling option candles ({underlyingSecurityId}, {expiryFlag}+{expiryCode}, {strike} {drvOptionType}, {chunkStart:yyyy-MM-dd}..{chunkEnd:yyyy-MM-dd})";

            var (response, error) = await SendWithRateLimitRetryAsync(payload, context, cancellationToken);
            if (response is null)
            {
                _logger.LogWarning("Rolling option candle request failed for {Id} ({ExpiryFlag}+{ExpiryCode}, {Strike} {Side}, {From}..{To}) - {Error}",
                    underlyingSecurityId, expiryFlag, expiryCode, strike, drvOptionType, chunkStart, chunkEnd, error);
                return (all, error);
            }

            // Disposed here, right after ParseSide is done reading it - a JsonElement is only valid
            // while the JsonDocument backing it is alive, so it cannot be read AFTER disposing (as
            // the response's own successful branch below does) or handed back across this method's
            // own return.
            using (response) { all.AddRange(ParseSide(response.Root, drvOptionType)); }

            chunkStart = chunkEnd.AddDays(1);
        }

        // Clip to exactly [fromDay,toDay] in OUR OWN code rather than trusting either
        // interpretation of Dhan's toDate boundary - see ClipToRange's own doc comment for why.
        return (ClipToRange(all, fromDay, toDay), null);
    }

    /// <summary>Keeps only bars whose own IST calendar date falls within [fromDay,toDay] - a
    /// belt-and-suspenders guarantee of this method's own contract regardless of whatever Dhan's
    /// toDate boundary actually does in practice. Their docs call toDate "non-inclusive" (which is
    /// why the payload above sends chunkEnd+1), but a real run still came back with a bar dated ONE
    /// DAY PAST an inclusive toDay even with that compensation applied - either the docs don't
    /// match Dhan's actual behavior here, or the rolling resolution treats the boundary some other
    /// way this app does not need to fully understand. What actually matters is that a caller
    /// asking for data "through toDay" never silently receives a bar from the day after - which,
    /// for a ROLLING series, can be the very first bar of the NEXT contract, exactly the kind of
    /// contamination DetectPossibleSplices exists to catch but this stops from happening at all.</summary>
    internal static List<(CandleWithVolume Bar, decimal? Strike, decimal? Spot, long? OpenInterest, decimal? ImpliedVolatility)> ClipToRange(
        List<(CandleWithVolume Bar, decimal? Strike, decimal? Spot, long? OpenInterest, decimal? ImpliedVolatility)> bars, DateOnly fromDay, DateOnly toDay)
    {
        bool InRange((CandleWithVolume Bar, decimal? Strike, decimal? Spot, long? OpenInterest, decimal? ImpliedVolatility) b)
        {
            var day = IstClock.IstDate(b.Bar.Time);
            return day >= fromDay && day <= toDay;
        }

        return bars.Where(InRange).ToList();
    }

    /// <summary>Sends one chunk, retrying with a backoff ONLY on Dhan's own rate-limit error - it
    /// explicitly says "Try throttling API calls" (a transient condition ChunkDelay's own pacing
    /// reduces but cannot fully rule out, since Dhan's limit is account-wide, not per-endpoint), so
    /// retrying that one specific failure is honoring Dhan's own instruction rather than giving up
    /// on a request that would very likely succeed a couple of seconds later. Any other failure -
    /// auth, a bad parameter, a genuine server error - returns immediately, unretried.
    ///
    /// Returns the live DhanApiResponse (caller disposes) on success rather than an already-read
    /// JsonElement, since a JsonElement stops being valid the instant its own JsonDocument is
    /// disposed - handing one back across this method's own return, after disposing here, would be
    /// use-after-dispose.</summary>
    private async Task<(DhanApiResponse? Response, string? Error)> SendWithRateLimitRetryAsync(
        object payload, string context, CancellationToken cancellationToken)
    {
        for (var attempt = 0; ; attempt++)
        {
            var response = await _api.SendAsync(HttpMethod.Post, "/charts/rollingoption", payload, context, cancellationToken);
            if (response.Success) return (response, null);

            var isRateLimited = response.ErrorMessage?.Contains("rate", StringComparison.OrdinalIgnoreCase) == true
                && response.ErrorMessage.Contains("limit", StringComparison.OrdinalIgnoreCase);
            var error = response.ErrorMessage;
            response.Dispose();

            if (!isRateLimited || attempt >= MaxRateLimitRetries) return (null, error);

            _logger.LogInformation("Rate-limited on {Context} (attempt {Attempt}/{Max}) - waiting {Delay} before retrying.",
                context, attempt + 1, MaxRateLimitRetries, RateLimitRetryDelay);
            await Task.Delay(RateLimitRetryDelay, cancellationToken);
        }
    }

    private List<(CandleWithVolume Bar, decimal? Strike, decimal? Spot, long? OpenInterest, decimal? ImpliedVolatility)> ParseSide(JsonElement root, string drvOptionType)
    {
        var bars = new List<(CandleWithVolume, decimal?, decimal?, long?, decimal?)>();

        if (!root.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
            return bars;

        var sideKey = string.Equals(drvOptionType, "PUT", StringComparison.OrdinalIgnoreCase) ? "pe" : "ce";
        if (!data.TryGetProperty(sideKey, out var side) || side.ValueKind != JsonValueKind.Object)
            return bars; // The requested side simply has no data for this window - not an error.

        if (!side.TryGetProperty("timestamp", out var timestamps) || timestamps.ValueKind != JsonValueKind.Array)
            return bars;

        var open = GetArray(side, "open");
        var high = GetArray(side, "high");
        var low = GetArray(side, "low");
        var close = GetArray(side, "close");
        var volume = GetArray(side, "volume");
        var strike = GetArray(side, "strike");
        var spot = GetArray(side, "spot");
        // oi/iv are genuinely optional - older Dhan responses (or a chunk Dhan happens to omit them
        // for) simply lack the property; GetArray already returns an empty list for that, which the
        // per-bar "i < list.Count" checks below treat as "no value at this index" (null), not zero.
        var oi = GetArray(side, "oi");
        var iv = GetArray(side, "iv");

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

                var resolvedStrike = i < strike.Count && strike[i] > 0 ? strike[i] : (decimal?)null;
                var resolvedSpot = i < spot.Count && spot[i] > 0 ? spot[i] : (decimal?)null;
                // OI/IV have no "must be positive" sanity rule the way strike/spot do - Dhan's own
                // documented "unavailable" sentinel for these is a literal 0 (see
                // NiftyDataCollector's DhanRollingOptionClient doc comment on the same distinction),
                // not something this parser can improve on without changing what a real 0 means -
                // kept as-is (0 stored as 0), only genuinely missing array entries become null.
                var openInterest = i < oi.Count ? (long?)(long)oi[i] : null;
                var impliedVolatility = i < iv.Count ? (decimal?)iv[i] : null;
                bars.Add((new CandleWithVolume(DateTimeOffset.FromUnixTimeSeconds(epochSeconds), o, h, l, c, i < volume.Count ? (long)volume[i] : 0), resolvedStrike, resolvedSpot, openInterest, impliedVolatility));
            }
            catch (Exception ex) when (ex is FormatException or InvalidOperationException or OverflowException)
            {
                _logger.LogDebug(ex, "Skipped an unparsable rolling-option candle at index {Index}", i);
            }
        }

        return bars;
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

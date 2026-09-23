namespace OptionAnalytics.Server.Models;

/// <summary>One stored 1-minute OI/IV/price reading for a single strike/side, from
/// OiReplayService - the raw ingredients the OI Replay page's frontend groups into per-strike rows
/// and looks up "as of the currently revealed candle's time" as the replay advances. Strike is never
/// null here (unlike OiIvPoint) - a point with no resolved strike is simply excluded before this is
/// built, since a row with no strike to key it by is useless to this page. Price is that bar's own
/// Close (the option's own last traded/theoretical premium at this minute) - shown alongside OI/IV
/// in the ladder so a level's own option cost is visible without a second lookup elsewhere.
/// Open/High/Low are the SAME minute bar's own OHLC (rolling_option_bars_1m genuinely stores all
/// four, not just a close) - null only for a live tick appended after this initial fetch (a live
/// tick is a genuine single point in time, not a bar, so it has no range of its own). The frontend's
/// Paper Trade panel uses these to check whether a stop-loss/target was actually TOUCHED at any
/// point within a historical minute, not merely whether the minute's own closing price crossed it -
/// falling back to Price (treating it as both High and Low) for a null-range live tick, which is the
/// most accurate check that genuinely single-point data supports.</summary>
public readonly record struct OiReplayPoint(DateTimeOffset Time, decimal Strike, long? OpenInterest, decimal? ImpliedVolatility, decimal Price, decimal? Open = null, decimal? High = null, decimal? Low = null);

/// <summary>One 1-minute futures bar - OHLC + volume + (when Dhan's response actually included it)
/// open interest. See OiReplayResult.FuturesOiAvailable/OiReplayService's own doc comment for why
/// this is ALWAYS a live Dhan call rather than ever reading NiftyDataCollector's database - no
/// futures data exists there at all.</summary>
public readonly record struct FuturesBar(DateTimeOffset Time, decimal Open, decimal High, decimal Low, decimal Close, long Volume, long? OpenInterest);

/// <summary>
/// Everything the OI Replay page needs for one full day, in one response - the whole day's worth of
/// spot candles (already aggregated to the requested timeframe) plus the whole day's own CE/PE
/// OI/IV history across the fetched strike band, primarily sourced from NiftyDataCollector's own
/// TimescaleDB (see OiReplayService's own doc comment on when it also falls back to a live Dhan
/// call - a genuinely past day still never needs one). The frontend then plays the day back candle
/// by candle client-side - no further server round trips per tick, just local array indexing into
/// what this one response already carries.
/// </summary>
public sealed record OiReplayResult(
    bool Success,
    string? Error,
    string Underlying,
    DateOnly Date,
    int TimeframeMinutes,
    int Step,
    string ExpiryFlag,
    int ExpiryCode,
    IReadOnlyList<Candle> SpotCandles,
    /// <summary>The SAME day's spot, at native 1-minute resolution - what the frontend now drives
    /// its whole replay clock from (OI/IV/ladder/every derived read), so those stay "continuously
    /// updated on 1-min" regardless of which timeframe SpotCandles itself is aggregated to for the
    /// chart display. The frontend re-aggregates a slice of this itself, client-side, as playback
    /// advances - SpotCandles above still exists for a caller that only wants the finished, whole-
    /// day aggregated series without doing that itself.</summary>
    IReadOnlyList<Candle> SpotCandlesOneMinute,
    IReadOnlyList<OiReplayPoint> CePoints,
    IReadOnlyList<OiReplayPoint> PePoints,
    /// <summary>The SAME day's nearest currently-listed futures contract, 1-minute bars - ALWAYS a
    /// live Dhan call (see OiReplayService's own doc comment: no futures data exists in
    /// NiftyDataCollector's database at all, unlike spot/options). Empty when nothing could be
    /// fetched - see FuturesError for why (the resolvable contract simply did not exist yet on this
    /// date, Dhan isn't authenticated, etc.) rather than assuming a call failure.</summary>
    IReadOnlyList<FuturesBar> FuturesBars,
    /// <summary>Which contract FuturesBars actually came from - null if none could even be
    /// resolved (e.g. the futures instrument master hasn't finished loading yet).</summary>
    DateOnly? FuturesExpiry,
    /// <summary>Whether Dhan's response for the futures call actually included an "open_interest"
    /// array at all - false means every FuturesBar's own OpenInterest is meaningless (always null)
    /// because Dhan didn't return the field, not that OI was genuinely zero all day. This endpoint's
    /// own "oi" flag has never been exercised by this app before (everywhere else that needs OI
    /// history uses /charts/rollingoption instead, which IS confirmed to return it) - surfaced so
    /// the frontend can say so plainly rather than silently showing blanks.</summary>
    bool FuturesOiAvailable,
    /// <summary>Set when the futures fetch itself did not succeed, or found nothing for this date -
    /// shown on the page instead of an empty chart with no explanation.</summary>
    string? FuturesError)
{
    public static OiReplayResult Failed(string underlying, DateOnly date, int timeframeMinutes, string error) =>
        new(false, error, underlying, date, timeframeMinutes, 0, "", 0, Array.Empty<Candle>(), Array.Empty<Candle>(), Array.Empty<OiReplayPoint>(), Array.Empty<OiReplayPoint>(),
            Array.Empty<FuturesBar>(), null, false, null);
}

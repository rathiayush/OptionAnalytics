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
/// <summary>Volume defaults to 0 - genuinely means "no volume traded this minute" for a live tick
/// (which carries no volume figure of its own, the same reasoning Open/High/Low's own null already
/// documents above), not "unknown"; the option premium chart's own VWAP overlay treats a 0-volume
/// minute as contributing nothing to the running total rather than skipping it, which is the
/// correct behavior for a genuinely illiquid minute.</summary>
public readonly record struct OiReplayPoint(DateTimeOffset Time, decimal Strike, long? OpenInterest, decimal? ImpliedVolatility, decimal Price, decimal? Open = null, decimal? High = null, decimal? Low = null, long Volume = 0);

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
/// <summary>The previous trading day's volume profile for one underlying - POC (Point of Control,
/// the single price that traded the most volume), VAH/VAL (Value Area High/Low, the price band
/// holding 70% of the day's total volume, centered on POC), and up to two each of HVN (High Volume
/// Nodes - local peaks in the volume-by-price distribution besides POC itself) and LVN (Low Volume
/// Nodes - local troughs, price levels the previous day traded through quickly rather than
/// consolidating at). All from OiReplayService.GetPreviousDayVolumeProfileAsync, which walks
/// backward from whatever date the frontend is currently viewing (live or a historical replay day
/// alike) to find the nearest PRIOR day with real spot volume data, skipping weekends and any day
/// that simply comes back empty (most commonly a market holiday).</summary>
public sealed record VolumeProfileResult(
    bool Success,
    string? Error,
    string Underlying,
    /// <summary>The actual calendar date this profile was computed from - the nearest prior trading
    /// day found, which for a Monday is Friday, and for a day right after a holiday skips back past
    /// it too. Null on failure.</summary>
    DateOnly? ProfileDate,
    decimal? Poc,
    decimal? Vah,
    decimal? Val,
    IReadOnlyList<decimal> Hvn,
    IReadOnlyList<decimal> Lvn)
{
    /// <summary>The histogram the levels come from - every bin's middle price and volume, low to high - so
    /// the client can find the thin run of bins around each LVN (the gap price tends to cross fast).</summary>
    public IReadOnlyList<VolumeProfileBin> Bins { get; init; } = Array.Empty<VolumeProfileBin>();

    /// <summary>That day's one-minute spot bars - the client builds the day's market profile (TPO) from
    /// them with the same code as the futures' (profiles.js tpoProfile).</summary>
    public IReadOnlyList<CandleWithVolume> Bars { get; init; } = Array.Empty<CandleWithVolume>();

    public static VolumeProfileResult Failed(string underlying, string error) =>
        new(false, error, underlying, null, null, null, null, Array.Empty<decimal>(), Array.Empty<decimal>());
}

/// <summary>One bin of the previous day's volume profile: its middle price and the volume traded in it.</summary>
public sealed record VolumeProfileBin(decimal Price, long Volume);

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
    /// <summary>The day's session VWAP off the spot's own index volume (VwapCalculator, one point per 1-minute bar
    /// from the first with volume) - so a past day shows VWAP like today does. Empty when the spot carried no volume
    /// (a day before Dhan sent index volume, or one read from the stored database).</summary>
    public IReadOnlyList<ObvPoint> SpotVwap { get; init; } = Array.Empty<ObvPoint>();

    public static OiReplayResult Failed(string underlying, DateOnly date, int timeframeMinutes, string error) =>
        new(false, error, underlying, date, timeframeMinutes, 0, "", 0, Array.Empty<Candle>(), Array.Empty<Candle>(), Array.Empty<OiReplayPoint>(), Array.Empty<OiReplayPoint>(),
            Array.Empty<FuturesBar>(), null, false, null);
}

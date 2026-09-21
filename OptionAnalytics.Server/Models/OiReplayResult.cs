namespace OptionAnalytics.Server.Models;

/// <summary>One stored 1-minute OI/IV/price reading for a single strike/side, from
/// OiReplayService - the raw ingredients the OI Replay page's frontend groups into per-strike rows
/// and looks up "as of the currently revealed candle's time" as the replay advances. Strike is never
/// null here (unlike OiIvPoint) - a point with no resolved strike is simply excluded before this is
/// built, since a row with no strike to key it by is useless to this page. Price is that bar's own
/// Close (the option's own last traded/theoretical premium at this minute) - shown alongside OI/IV
/// in the ladder so a level's own option cost is visible without a second lookup elsewhere.</summary>
public readonly record struct OiReplayPoint(DateTimeOffset Time, decimal Strike, long? OpenInterest, decimal? ImpliedVolatility, decimal Price);

/// <summary>
/// Everything the OI Replay page needs for one full day, in one response - the whole day's worth of
/// spot candles (already aggregated to the requested timeframe) plus the whole day's own CE/PE
/// OI/IV history across the fetched strike band, all sourced from NiftyDataCollector's own
/// TimescaleDB (see OiReplayService's own doc comment: this page makes NO live Dhan calls at all,
/// unlike Expired Backtest's useStoredData toggle which merely PREFERS stored data). The frontend
/// then plays the day back candle by candle client-side - no further server round trips per tick,
/// just local array indexing into what this one response already carries.
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
    IReadOnlyList<OiReplayPoint> CePoints,
    IReadOnlyList<OiReplayPoint> PePoints)
{
    public static OiReplayResult Failed(string underlying, DateOnly date, int timeframeMinutes, string error) =>
        new(false, error, underlying, date, timeframeMinutes, 0, "", 0, Array.Empty<Candle>(), Array.Empty<OiReplayPoint>(), Array.Empty<OiReplayPoint>());
}

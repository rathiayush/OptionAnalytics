namespace OptionAnalytics.Server.Models;

/// <summary>Latest state for one underlying's spot price - pushed over SignalR and served by
/// GET /api/spot/{underlying}/snapshot. RoundedPrice is LastPrice rounded to the nearest multiple
/// of Step (50 for NIFTY, 100 for BANKNIFTY) - the "round figure" line shown under the chart.
///
/// Vwap is the session VWAP's own CURRENT value (VwapCalculator.ComputeSeries's last point) - null
/// before the day's first traded volume, same "no point at all" rule that series itself documents.
/// Riding this existing per-tick push rather than a separate poll of GET .../vwap-series is what
/// lets the chart's VWAP line grow live, tick by tick, instead of only catching up once every poll
/// interval - the same "no artificial waiting" standard every other live series on this page already
/// holds to.
///
/// TimestampUtc is when this server RECEIVED the last tick; ExchangeTimeUtc is the time Dhan stamped
/// on it. A page compares both against its own clock, so it can tell a slow link to this server
/// apart from a slow feed into it.</summary>
public sealed record SpotSnapshot(
    string Underlying,
    int Step,
    decimal LastPrice,
    decimal RoundedPrice,
    DateTimeOffset TimestampUtc,
    Candle? CurrentBar,
    decimal? Vwap = null,
    DateTimeOffset? ExchangeTimeUtc = null);

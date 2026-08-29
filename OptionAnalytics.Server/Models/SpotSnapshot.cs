namespace OptionAnalytics.Server.Models;

/// <summary>Latest state for one underlying's spot price - pushed over SignalR and served by
/// GET /api/spot/{underlying}/snapshot. RoundedPrice is LastPrice rounded to the nearest multiple
/// of Step (50 for NIFTY, 100 for BANKNIFTY) - the "round figure" line shown under the chart.</summary>
public sealed record SpotSnapshot(
    string Underlying,
    int Step,
    decimal LastPrice,
    decimal RoundedPrice,
    DateTimeOffset TimestampUtc,
    Candle? CurrentBar);

namespace OptionAnalytics.Server.Models;

/// <summary>One 1-minute sample of the CE/PE cumulative delta volume series - the CDV chart's
/// equivalent of Candle for the spot chart, except CDV is a running total (a line, not an OHLC
/// bar) so this carries just the value at that minute.</summary>
public readonly record struct CdvBarPoint(DateTimeOffset Time, decimal CeCdv, decimal PeCdv);

/// <summary>Latest CDV state for one underlying's option chain - pushed over SignalR and served by
/// GET /api/cdv/{underlying}/snapshot.</summary>
public sealed record CdvSnapshot(
    string Underlying,
    int? AtmStrike,
    DateOnly? Expiry,
    decimal CeCdv,
    decimal PeCdv,
    DateTimeOffset TimestampUtc,
    CdvBarPoint? CurrentBar);

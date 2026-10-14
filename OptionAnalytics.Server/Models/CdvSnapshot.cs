namespace OptionAnalytics.Server.Models;

/// <summary>One 1-minute sample of the CE/PE cumulative delta volume series - the CDV chart's
/// equivalent of Candle for the spot chart, except CDV is a running total (a line, not an OHLC
/// bar) so this carries just the value at that minute.</summary>
public readonly record struct CdvBarPoint(DateTimeOffset Time, decimal CeCdv, decimal PeCdv);

/// <summary>Latest CDV state for one underlying's option chain - pushed over SignalR and served by
/// GET /api/cdv/{underlying}/snapshot. AtmCeCurrentBar/AtmPeCurrentBar are the live-forming premium
/// bar for whichever contract is currently ATM on each side - null until ATM has resolved.</summary>
public sealed record CdvSnapshot(
    string Underlying,
    int? AtmStrike,
    DateOnly? Expiry,
    decimal CeCdv,
    decimal PeCdv,
    DateTimeOffset TimestampUtc,
    CdvBarPoint? CurrentBar,
    Candle? AtmCeCurrentBar,
    Candle? AtmPeCurrentBar,
    IReadOnlyList<CdvStrikeBar>? StrikeBars = null);

/// <summary>One tracked strike's live-forming premium bar - lets a page charting a PINNED (non-ATM)
/// strike keep its current candle moving too, not just the ATM pair above.</summary>
public sealed record CdvStrikeBar(decimal Strike, bool IsCall, Candle Bar);

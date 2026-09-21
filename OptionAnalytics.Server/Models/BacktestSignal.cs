namespace OptionAnalytics.Server.Models;

/// <summary>One signal produced by replaying BacktestService's offline pass over whatever spot/ATM
/// CE/PE candle history the underlying's HostedServices currently hold in memory - same Kind/
/// Direction vocabulary as ConfluenceAlert (Kind: "Spot" | "AtmCe" | "AtmPe" | "Confluence") so the
/// frontend can reuse the same labels/colors, but this is a replay over history, not a live feed.</summary>
public sealed record BacktestSignal(
    string Underlying,
    DateTimeOffset TimeUtc,
    string Kind,
    string Direction,
    string Summary)
{
    /// <summary>Where the CE and PE OBV lines stood relative to each other at this signal - "Up"
    /// for the line that is on top, "Down" for the one underneath, so the two are always mirrors.
    /// CE above PE is the bullish arrangement (the Pine indicator's "Green crossed Red") and CE
    /// below PE the bearish one. Null when the strategy doesn't measure OBV at all, which is why
    /// these are init-only extras rather than part of the record's positional shape.</summary>
    public string? CeObvCross { get; init; }
    public string? PeObvCross { get; init; }

    /// <summary>The OI-wall/IV-spike diagnostics OrbOrderBlockStrategy's own optional filters read to
    /// accept or reject a signal (see its own doc comment) - attached whenever the corresponding
    /// filter parameter is ON, on BOTH an accepted Entry (so the frontend can show what supported it)
    /// and a Rejected-by-that-filter signal (so it can show what blocked it), null otherwise
    /// (filter off, or another strategy that doesn't compute these at all). Init-only extras, same
    /// pattern as CeObvCross/PeObvCross above, so adding these never touches every other strategy's
    /// own BacktestSignal construction.</summary>
    public decimal? OiWallStrike { get; init; }
    public long? OiWallOpenInterest { get; init; }
    public decimal? IvNow { get; init; }
    public decimal? IvPrior { get; init; }
    public int? IvLookbackBars { get; init; }
}

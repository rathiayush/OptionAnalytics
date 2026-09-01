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
    string Summary);

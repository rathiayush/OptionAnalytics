namespace OptionAnalytics.Server.Models;

/// <summary>One underlying's CURRENT EMA9/21 bias on each leg (spot, ATM CE, ATM PE) right now -
/// not an event, a live snapshot, continuously kept up to date on every bar close regardless of
/// whether that bar was an actual crossover (see EmaCrossoverDetector.CurrentDirection). Served by
/// GET /api/alerts/state. Null on a leg means not enough closed bars yet to know.</summary>
public sealed record CrossoverState(
    string Underlying,
    string? Spot,
    string? AtmCe,
    string? AtmPe,
    DateTimeOffset UpdatedUtc);

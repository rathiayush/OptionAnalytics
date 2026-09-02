namespace OptionAnalytics.Server.Models;

/// <summary>One underlying's CURRENT, close-CONFIRMED EMA9/21 bias on each leg (spot, ATM CE, ATM
/// PE) right now - not an event, a live snapshot, kept up to date on every bar close (see
/// EmaCrossoverDetector.ConfirmedDirection for what "confirmed" requires). Served by GET
/// /api/alerts/state. Null on a leg means not enough closed bars yet to know, or the bias hasn't
/// been confirmed by a close beyond both EMAs since the last leg that did.</summary>
public sealed record CrossoverState(
    string Underlying,
    string? Spot,
    string? AtmCe,
    string? AtmPe,
    DateTimeOffset UpdatedUtc);

namespace OptionAnalytics.Server.Models;

/// <summary>One notification from the alert engine - either a single leg's EMA9/21 bias changing
/// (Kind: "Spot" | "AtmCe" | "AtmPe") or all three confirming the same move at once (Kind:
/// "Confluence" - see ConfluenceAlertService's class doc comment for exactly what has to line up).
/// Served by GET /api/alerts (recent history, all kinds mixed together, newest first) and pushed
/// live over SpotHub's "confluenceAlert" event as each one happens.</summary>
public sealed record ConfluenceAlert(
    string Underlying,
    DateTimeOffset TimeUtc,
    string Kind,
    string Direction,
    decimal SpotPrice,
    int? AtmStrike,
    string Message);

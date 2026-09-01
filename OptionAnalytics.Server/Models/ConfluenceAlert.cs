namespace OptionAnalytics.Server.Models;

/// <summary>One confirmed spot+ATM-option EMA9/21 confluence signal - see
/// ConfluenceAlertService's class doc comment for exactly what has to line up for one of these to
/// fire. Served by GET /api/alerts (recent history) and pushed live over SpotHub's "confluenceAlert"
/// event.</summary>
public sealed record ConfluenceAlert(
    string Underlying,
    DateTimeOffset TimeUtc,
    string Direction,
    decimal SpotPrice,
    int? AtmStrike,
    string Message);

namespace OptionAnalytics.Server.Models;

/// <summary>The dashboard/Backtrack expiry picker payload - every listed expiry for this underlying,
/// and which one CDV is currently tracking (either a manual selection via POST
/// /api/cdv/{underlying}/expiry, or the auto-picked nearest expiry when no selection has been made).
/// See CdvHostedService.SelectExpiryAsync for what changing it actually does.</summary>
public sealed record ExpiryOptions(
    string Underlying,
    IReadOnlyList<DateOnly> Expiries,
    DateOnly? Selected,
    /// <summary>True when Selected came from an explicit user pick rather than the auto nearest-
    /// expiry default - lets the UI show "auto" vs. a pinned choice.</summary>
    bool IsManualSelection);

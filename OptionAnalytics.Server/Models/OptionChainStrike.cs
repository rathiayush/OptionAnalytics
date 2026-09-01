namespace OptionAnalytics.Server.Models;

/// <summary>One selectable strike on the dashboard's option-chart picker.
/// <paramref name="Tracked"/> means this app already holds that strike's premium history in memory
/// (it is inside, or was inside today, the CDV ATM+-8 window), so its chart is instant and updates
/// live; an untracked strike still charts, but its candles are fetched from Dhan's intraday history
/// on demand and only refresh when asked. The quote fields come from Dhan's Option Chain API and are
/// null whenever that call is unavailable (unauthenticated, rate-limited, or outside market hours) -
/// the picker works without them, they just make it possible to tell which strike is worth looking
/// at.</summary>
public sealed record OptionChainStrike(
    decimal Strike,
    bool Tracked,
    bool IsAtm,
    decimal? CeLastPrice,
    long? CeOpenInterest,
    decimal? PeLastPrice,
    long? PeOpenInterest);

/// <summary>The dashboard's option-chart picker payload - see CdvHostedService.GetChainAsync.</summary>
public sealed record OptionChainResponse(
    string Underlying,
    DateOnly? Expiry,
    decimal? AtmStrike,
    int Step,
    /// <summary>True when the Strikes carry live Dhan Option Chain quotes; false when the strike
    /// list is the scrip master's alone (which is all the chart itself needs).</summary>
    bool QuotesAvailable,
    IReadOnlyList<OptionChainStrike> Strikes);

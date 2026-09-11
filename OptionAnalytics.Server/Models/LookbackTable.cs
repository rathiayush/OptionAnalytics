namespace OptionAnalytics.Server.Models;

/// <summary>One lookback window's % change - EMA(SmoothLen)-smoothed CDV now vs SmoothLen bars ago
/// (see CdvUnderlyingState.GetLookbackTable), mirroring LiveSpreadCalculator's own
/// "Multi-Lookback" table for the same Pine indicator. Current/Previous are null until enough bars
/// exist for the EMA to have a value that far back; PercentChange is additionally null whenever
/// Previous is exactly zero (division by zero) OR Current and Previous sit on opposite sides of
/// zero (or either is exactly zero while the other isn't) - a reading that crossed zero within the
/// window has no meaningful "percent change" relative to its old level, however small that old
/// level was: dividing by a level that was merely near zero, rather than exactly zero, is what
/// produced the wildly misleading swings (e.g. -900%+) this guard exists to suppress. Current/
/// Previous themselves are still reported in that case, so the raw levels remain visible even
/// though the percentage is withheld.</summary>
public readonly record struct LookbackChange(int Bars, decimal? Current, decimal? Previous, decimal? PercentChange);

/// <summary>CE and PE lookback tables together, as served by GET /api/cdv/{underlying}/lookback.
/// </summary>
public sealed record LookbackTable(string Underlying, IReadOnlyList<LookbackChange> Ce, IReadOnlyList<LookbackChange> Pe);

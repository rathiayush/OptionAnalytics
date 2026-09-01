namespace OptionAnalytics.Server.Models;

/// <summary>One lookback window's % change - EMA(SmoothLen)-smoothed CDV now vs SmoothLen bars ago
/// (see CdvUnderlyingState.GetLookbackTable), mirroring LiveSpreadCalculator's own
/// "Multi-Lookback" table for the same Pine indicator. Current/Previous are null until enough bars
/// exist for the EMA to have a value that far back; PercentChange is additionally null if Previous
/// is exactly zero (division by zero has no meaningful percentage).</summary>
public readonly record struct LookbackChange(int Bars, decimal? Current, decimal? Previous, decimal? PercentChange);

/// <summary>CE and PE lookback tables together, as served by GET /api/cdv/{underlying}/lookback.
/// </summary>
public sealed record LookbackTable(string Underlying, IReadOnlyList<LookbackChange> Ce, IReadOnlyList<LookbackChange> Pe);

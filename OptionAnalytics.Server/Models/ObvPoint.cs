namespace OptionAnalytics.Server.Models;

/// <summary>One bar's On-Balance-Volume value for one option contract (ATM CE or ATM PE) - see
/// CdvUnderlyingState.GetObvSeries.</summary>
public readonly record struct ObvPoint(DateTimeOffset Time, decimal Obv);

/// <summary>CE and PE OBV series together, as served by GET /api/cdv/{underlying}/obv-series -
/// two independent lines (each contract's own bars), not a synchronized pair like CdvBarPoint.</summary>
public sealed record ObvSeriesResponse(IReadOnlyList<ObvPoint> Ce, IReadOnlyList<ObvPoint> Pe);

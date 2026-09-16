namespace OptionAnalytics.Server.Models;

/// <summary>Pushed over SignalR ("cdvBarClosed") the instant the aggregate CE/PE total's own
/// 1-minute bar closes for an underlying's currently SELECTED expiry - see
/// CdvUnderlyingState.AggregateBarClosed. Carries the just-closed bar's already EMA-smoothed CDV
/// value for both legs (CdvUnderlyingState.GetSmoothedCdvSeries's own tail), the same value the
/// lookback %-change table is computed from, so a subscriber can append it to a client-held series
/// and compute that table itself instead of re-fetching GET .../lookback on every bar close.</summary>
public sealed record CdvBarClosedPush(string Underlying, DateTimeOffset Time, decimal CdvCe, decimal CdvPe);

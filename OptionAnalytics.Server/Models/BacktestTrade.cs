namespace OptionAnalytics.Server.Models;

/// <summary>One simulated trade from BacktestService.SimulateTrades: on a past Confluence signal,
/// buy the CE (Bullish) or PE (Bearish) that was <c>otmSteps</c> strikes OTM from ATM at the
/// signal's own time, entered at the next bar's open (no look-ahead), then walked forward against
/// a percentage stop-loss/take-profit until one hits or the trading day ends. Entry/Exit fields are
/// null when ExitReason is "NoData" (that exact OTM strike was never tracked, so there is no
/// premium history to simulate against).</summary>
public sealed record BacktestTrade(
    string Underlying,
    DateTimeOffset SignalTimeUtc,
    string Direction,
    string OptionType,
    decimal Strike,
    DateTimeOffset? EntryTimeUtc,
    decimal? EntryPrice,
    DateTimeOffset? ExitTimeUtc,
    decimal? ExitPrice,
    string ExitReason,
    decimal? PnlPercent,
    decimal? PnlPoints)
{
    public static BacktestTrade NoData(string underlying, DateTimeOffset signalTimeUtc, string direction, string optionType, decimal strike) =>
        new(underlying, signalTimeUtc, direction, optionType, strike, null, null, null, null, "NoData", null, null);
}

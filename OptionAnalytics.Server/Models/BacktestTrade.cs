namespace OptionAnalytics.Server.Models;

/// <summary>One simulated trade from a strategy run: on a past Confluence signal, take a position
/// in the CE or PE that was <c>otmSteps</c> strikes from ATM at the signal's own time, entered at
/// the next bar's open (no look-ahead), then walked forward against a stop-loss/take-profit given
/// in absolute premium points until one hits or the trading day ends.
///
/// <paramref name="Side"/> is "Buy" or "Sell". It decides both which leg the trade is in (a bullish
/// view is a bought CE but a SOLD PE - see OtmConfluenceStrategy) and which way P&amp;L runs: a
/// buyer's PnlPoints is exit - entry, a seller's is entry - exit, since a seller collects the
/// premium up front and profits as it decays.
///
/// <paramref name="SpotPrice"/> is the underlying's own price at the moment of the signal - the
/// price the ATM (and therefore Strike) was derived from, so a row shows what the market was doing
/// when the trade was taken, not just what the option premium did.
///
/// Entry/Exit fields are null when ExitReason is "NoData" (that exact strike was never tracked, so
/// there is no premium history to simulate against).</summary>
public sealed record BacktestTrade(
    string Underlying,
    DateTimeOffset SignalTimeUtc,
    string Direction,
    string Side,
    string OptionType,
    decimal Strike,
    decimal? SpotPrice,
    DateTimeOffset? EntryTimeUtc,
    decimal? EntryPrice,
    DateTimeOffset? ExitTimeUtc,
    decimal? ExitPrice,
    string ExitReason,
    decimal? PnlPoints)
{
    public static BacktestTrade NoData(string underlying, DateTimeOffset signalTimeUtc, string direction, string side, string optionType, decimal strike, decimal? spotPrice) =>
        new(underlying, signalTimeUtc, direction, side, optionType, strike, spotPrice, null, null, null, null, "NoData", null);
}

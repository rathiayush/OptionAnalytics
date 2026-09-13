namespace OptionAnalytics.Server.Models;

/// <summary>The single largest disagreement found between an Expired Backtest run's own fetched
/// premium series and CdvHostedService's live-tracked candles for the same real contract/strike -
/// only ever computable when the target expiry is one this app also happens to be tracking live
/// right now (a not-yet-expired contract - see ExpiredOptionBacktestService.RunAsync's own toDay
/// clamping). Confirmed by a real run: the exact same signal (same spot, same entry price) showed a
/// Stop Loss on this page and a Take Profit on Backtrack for the identical contract, because the two
/// pages source premium from two independently-built series - Dhan's historical rolling-option
/// reconstruction here, real folded WebSocket ticks on Backtrack - that are not guaranteed to agree
/// bar-for-bar even for a genuinely healthy contract.</summary>
public sealed record LiveDataMismatch(DateTimeOffset Time, decimal FetchedPrice, decimal LivePrice);

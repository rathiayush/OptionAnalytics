namespace OptionAnalytics.Server.Dhan;

/// <summary>One update for one subscribed instrument, merged the same way LiveSpreadCalculator's
/// DhanMarketFeedClient.Merge folds packets: a field only updates when the new packet actually
/// carries it, so an OHLC-less Ticker packet never blanks the OHLC an earlier Full packet set.
/// Volume is Dhan's CUMULATIVE volume for the day, not a per-tick amount - CdvUnderlyingState
/// diffs consecutive values itself to get each tick's incremental traded quantity.</summary>
public sealed record SpotTick(
    uint SecurityId,
    decimal LastPrice,
    decimal Open,
    decimal High,
    decimal Low,
    decimal Close,
    long Volume,
    DateTimeOffset ExchangeTimestamp);

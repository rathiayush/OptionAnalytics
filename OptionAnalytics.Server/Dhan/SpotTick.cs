namespace OptionAnalytics.Server.Dhan;

/// <summary>One update for one subscribed instrument, merged the same way LiveSpreadCalculator's
/// DhanMarketFeedClient.Merge folds packets: a field only updates when the new packet actually
/// carries it, so an OHLC-less Ticker packet never blanks the OHLC an earlier Full packet set.</summary>
public sealed record SpotTick(
    uint SecurityId,
    decimal LastPrice,
    decimal Open,
    decimal High,
    decimal Low,
    decimal Close,
    DateTimeOffset ExchangeTimestamp);

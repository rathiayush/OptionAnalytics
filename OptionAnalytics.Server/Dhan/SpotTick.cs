namespace OptionAnalytics.Server.Dhan;

/// <summary>One update for one subscribed instrument, merged the same way LiveSpreadCalculator's
/// DhanMarketFeedClient.Merge folds packets: a field only updates when the new packet actually
/// carries it, so an OHLC-less Ticker packet never blanks the OHLC an earlier Full packet set.
/// Volume is Dhan's CUMULATIVE volume for the day, not a per-tick amount - CdvUnderlyingState
/// diffs consecutive values itself to get each tick's incremental traded quantity.
///
/// BestBidPrice/BestAskPrice are 0 unless this instrument is subscribed in Full mode (option
/// strikes - see DhanMarketFeedClient/CdvHostedService; the spot/index token stays Quote-only,
/// since an index has no order book) AND at least one Full packet has arrived for it - a caller
/// pricing off these must treat 0 as "no live depth yet" and fall back to the last traded price,
/// same as StrategyTriggerHostedService does re-pricing an order retry. OpenInterest is likewise
/// only ever populated for a Full-mode instrument (an index has no OI either) - see
/// OiReplayLiveFeedService, the first live consumer of this field.</summary>
public sealed record SpotTick(
    uint SecurityId,
    decimal LastPrice,
    decimal Open,
    decimal High,
    decimal Low,
    decimal Close,
    long Volume,
    decimal BestBidPrice,
    decimal BestAskPrice,
    long OpenInterest,
    DateTimeOffset ExchangeTimestamp);

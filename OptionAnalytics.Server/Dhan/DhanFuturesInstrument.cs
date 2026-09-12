namespace OptionAnalytics.Server.Dhan;

/// <summary>One index futures contract from the Dhan scrip master's FUTIDX rows.
///
/// Tracked for exactly one reason: VOLUME. An index itself has none - Dhan's IDX_I feed carries no
/// volume field at all - so any volume-weighted measure on NIFTY/BANKNIFTY/SENSEX has to borrow its
/// weights from something that really trades. The front-month future is the standard choice: it
/// tracks the index within a small basis, it is the most liquid single instrument on the underlying,
/// and it is what a TradingView user is actually looking at when they put a volume indicator on an
/// "index" chart.</summary>
public sealed record DhanFuturesInstrument(
    uint SecurityId,
    string TradingSymbol,
    string Underlying,
    DateOnly Expiry,
    /// <summary>"NSE_FNO" for a NIFTY/BANKNIFTY future, "BSE_FNO" for a SENSEX one - read
    /// per-contract from the scrip master's exchange column, same as DhanOptionInstrument.</summary>
    string DhanSegment,
    int LotSize,
    decimal TickSize);

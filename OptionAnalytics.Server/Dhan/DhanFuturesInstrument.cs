namespace OptionAnalytics.Server.Dhan;

/// <summary>One index futures contract (FUTIDX) from the Dhan scrip master - the futures
/// counterpart to DhanOptionInstrument, just with no strike/side (a future has exactly one
/// contract per underlying per expiry, not a whole strike chain).</summary>
public sealed record DhanFuturesInstrument(
    uint SecurityId,
    string TradingSymbol,
    string Underlying,
    DateOnly Expiry,
    /// <summary>Dhan's WS/REST segment string - "NSE_FNO" for NIFTY/BANKNIFTY, "BSE_FNO" for
    /// SENSEX (a different exchange, not just another symbol - same distinction
    /// DhanOptionInstrument.DhanSegment already makes for options).</summary>
    string DhanSegment,
    int LotSize,
    decimal TickSize);

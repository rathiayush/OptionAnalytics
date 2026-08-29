namespace OptionAnalytics.Server.Dhan;

/// <summary>One cash/index row from the Dhan scrip master - only what this app needs to subscribe
/// to a spot price on the WebSocket feed.</summary>
public sealed record DhanSpotInstrument(
    uint SecurityId,
    string TradingSymbol,
    string Name,
    /// <summary>Dhan's WS subscription segment string, e.g. "IDX_I" or "NSE_EQ".</summary>
    string DhanSegment);

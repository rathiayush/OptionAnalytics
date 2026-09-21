namespace NiftyDataCollector.Dhan;

/// <summary>NIFTY's own cash/index row - what identifies it to Dhan's option-chain, expiry-list,
/// and historical-data endpoints (as UnderlyingScrip/securityId + UnderlyingSeg/exchangeSegment).</summary>
public sealed record DhanSpotInstrument(uint SecurityId, string TradingSymbol, string Name, string DhanSegment);

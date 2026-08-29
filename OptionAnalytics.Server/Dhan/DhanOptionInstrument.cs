namespace OptionAnalytics.Server.Dhan;

/// <summary>One CE/PE contract from the Dhan scrip master's OPTIDX rows.</summary>
public sealed record DhanOptionInstrument(
    uint SecurityId,
    string TradingSymbol,
    string Underlying,
    DateOnly Expiry,
    decimal Strike,
    bool IsCall,
    /// <summary>Dhan's WS subscription segment string - "NSE_FNO" for every index option.</summary>
    string DhanSegment);

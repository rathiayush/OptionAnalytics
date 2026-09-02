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
    string DhanSegment,
    /// <summary>Shares per lot (SEM_LOT_UNITS) - an order's quantity must be a whole multiple of
    /// this. SEBI revises index option lot sizes periodically, so this is read fresh from the
    /// scrip master rather than hardcoded (e.g. NIFTY 65, BANKNIFTY 30 as of this build - already
    /// different from the historically-cited 75/15, which is exactly why this isn't a constant).</summary>
    int LotSize,
    /// <summary>Minimum price increment (SEM_TICK_SIZE) - an order's price must be a whole
    /// multiple of this or Dhan rejects it outright.</summary>
    decimal TickSize);

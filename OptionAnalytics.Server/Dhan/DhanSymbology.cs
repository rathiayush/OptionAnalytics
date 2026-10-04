namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// The small slice of Dhan's segment/error-code vocabulary this app actually needs. Ported from
/// LiveSpreadCalculator's DhanSymbology, trimmed to drop everything about orders/products/futures
/// that a spot-only price feed has no use for.
/// </summary>
public static class DhanSymbology
{
    /// <summary>A contract's tick size in RUPEES from the scrip master's SEM_TICK_SIZE, which Dhan gives
    /// in paise: 5 = Rs 0.05 (index options), 10 = Rs 0.10 (NIFTY futures), 20 = Rs 0.20 (BANKNIFTY
    /// futures), 1 = Rs 0.01. Zero or negative stays as it is (the callers drop such rows).</summary>
    public static decimal TickSizeFromScripMaster(decimal paise) => paise > 0 ? paise / 100m : paise;

    /// <summary>Dhan's numeric exchange-segment codes, as they appear in the byte at offset 3 of
    /// every binary market-data packet.</summary>
    private static readonly Dictionary<byte, string> FeedSegmentToCanonical = new()
    {
        [0] = "IDX",  // IDX_I - index
        [1] = "NSE",  // NSE_EQ
        [2] = "NFO",  // NSE_FNO
        [3] = "CDS",  // NSE_CURRENCY
        [4] = "BSE",  // BSE_EQ
        [5] = "MCX",  // MCX_COMM
        [7] = "BCD",  // BSE_CURRENCY
        [8] = "BFO",  // BSE_FNO
    };

    public static string? FeedSegmentToExchange(byte feedSegment) =>
        FeedSegmentToCanonical.TryGetValue(feedSegment, out var exchange) ? exchange : null;

    /// <summary>Dhan's Data API error codes carried by a market-feed disconnect packet (response
    /// code 50). Transcribed from Dhan's published annexure.</summary>
    public static string DescribeFeedErrorCode(int code) => code switch
    {
        800 => "internal server error at Dhan",
        804 => "the subscription requested more instruments than the connection allows",
        805 => "too many requests or connections for this account - further ones may be blocked",
        806 => "the account is not subscribed to Dhan's Data APIs",
        807 => "the access token has expired",
        808 => "authentication failed - the credentials were not accepted",
        809 => "the access token is invalid",
        810 => "the client id is invalid",
        811 => "invalid expiry date",
        812 => "invalid date format",
        813 => "invalid security id",
        814 => "invalid request",
        _ => "unspecified reason",
    };

    /// <summary>True for disconnect codes that mean this session's credentials will never work
    /// again - the only useful response is telling the operator to refresh the token, not to keep
    /// reconnecting.</summary>
    public static bool IsSessionInvalidCode(int code) => code is 807 or 808 or 809 or 810;
}

namespace OptionAnalytics.Server.TrueData;

/// <summary>
/// TrueData (truedata.in) market-data history, used through their official .NET SDK (TrueData-DotNet).
/// OFF by default: with Enabled false nothing TrueData is registered, created or called - the app runs
/// exactly as without it.
///
/// With it on, an Order Flow day the server did not record live is REBUILT from TrueData's tick history
/// (every tick with the best bid / ask at that moment - GET history.truedata.in/getticks?bidask=1) through
/// the same OrderFlowEngine the live feed uses, instead of being estimated from 1-minute candles. TrueData
/// keeps tick history for the last few trading days only (TickHistoryDays); older days stay estimated.
///
/// What it cannot do: TrueData's API (and its SDK) has NO market depth for NSE - Level 1 (best bid / ask)
/// only; no 5- or 20-level book (Level 2 / 3) and no tick-by-tick order feed. A rebuilt day therefore has
/// a footprint, delta and tape but no heatmap or DOM - depth stays Dhan's (20 / 200 levels, live only).
///
/// Credentials go in appsettings.Local.json (git-ignored) or environment variables
/// (TrueData__UserId / TrueData__Password) - never in a committed file.
/// </summary>
public sealed class TrueDataOptions
{
    public const string SectionName = "TrueData";

    public bool Enabled { get; set; }
    public string UserId { get; set; } = "";
    public string Password { get; set; } = "";
    public string AuthUrl { get; set; } = "https://auth.truedata.in";
    public string HistoryUrl { get; set; } = "https://history.truedata.in";

    /// <summary>How many calendar days back TrueData is asked for a day's ticks (it keeps the last ~5
    /// trading days - a week of calendar days covers them).</summary>
    public int TickHistoryDays { get; set; } = 7;

    /// <summary>A futures contract's TrueData symbol: {0} the underlying (NIFTY / BANKNIFTY / SENSEX),
    /// {1} the expiry - e.g. NIFTY25OCTFUT. The continuous "{0}-I" is tried when the contract symbol
    /// has no data and the contract is the front month on that day.</summary>
    public string FuturesSymbolFormat { get; set; } = "{0}{1:yy}{1:MMM}FUT";

    /// <summary>Rebuilt days kept in memory (they are re-fetched after a restart, never written to disk).</summary>
    public int MaxCachedDays { get; set; } = 6;

    public bool IsConfigured => Enabled && !string.IsNullOrWhiteSpace(UserId) && !string.IsNullOrWhiteSpace(Password);
}

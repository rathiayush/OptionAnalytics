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

    /// <summary>The LIVE tick-by-tick feed (TrueData's WebSocket, the "Tick Flow" page) - separate from the history
    /// source above, and OFF by default: with Live.Enabled false no socket is opened.</summary>
    public TrueDataLiveOptions Live { get; set; } = new();

    public bool IsConfigured => Enabled && !string.IsNullOrWhiteSpace(UserId) && !string.IsNullOrWhiteSpace(Password);
}

/// <summary>TrueData:Live - the real-time WebSocket (wss://push.truedata.in:{Port}?user=&amp;password=). Sandbox = 8086,
/// production = 8084. The user / password are TrueData:UserId / Password (environment variables or the git-ignored
/// appsettings.Local.json - never a committed file).</summary>
public sealed class TrueDataLiveOptions
{
    public bool Enabled { get; set; }
    public string Host { get; set; } = "push.truedata.in";
    public int Port { get; set; } = 8086;

    /// <summary>"websocket" (the default - JSON messages, wss://{Host}:{Port}) or "tcp" (TrueData's TCP API v2.3: binary TR / BA packets
    /// with the last tick's volume and a sequence number, {TcpHost}:{TcpPort}). One connection per account either way.</summary>
    public string Transport { get; set; } = "websocket";
    public string TcpHost { get; set; } = "tcp.truedata.in";
    public int TcpPort { get; set; } = 7070;

    /// <summary>The folder the page's source choice (WebSocket / TCP) is kept in; filled from Storage:ScannerRunnerPath when empty.</summary>
    public string StatePath { get; set; } = "";

    /// <summary>The index whose OPTIONS (ATM +- OptionStrikes, calls and puts) are streamed for the Tick Flow page's big option orders
    /// ("NIFTY" / "BANKNIFTY", empty = none) - the page's choice (kept in a file) beats this first default. TrueData's trial allows
    /// MaxSymbols (50) symbols at once: the two futures and 2 x (2 x 10 + 1) = 42 options of one index fit, both indices' (84) do not - so it is
    /// ONE index, NIFTY by default (asked for - "if it does not fit under 50, only consider NIFTY").</summary>
    public string OptionsUnderlying { get; set; } = "NIFTY";

    /// <summary>FEATURE FLAG for the option tick processing (asked for - "also add a feature flag for true tick data handling"; environment variable
    /// TrueData__Live__OptionTicks): ON by default. OFF = the option stream is never subscribed, no option tick is read or watched, the big option orders
    /// (live and the replay's tick-history build) answer "off", and the futures' footprint is untouched.</summary>
    public bool OptionTicks { get; set; } = true;
    public int OptionStrikes { get; set; } = 10;
    public int MaxSymbols { get; set; } = 50;

    /// <summary>What is streamed - the continuous near futures by default (TrueData's "NIFTY-I" / "BANKNIFTY-I").
    /// LotSize / TickSize are the contract's (NSE changes them; set them here when they change).</summary>
    public List<TrueDataLiveInstrument> Instruments { get; set; } = new()
    {
        new() { Underlying = "NIFTY", Symbol = "NIFTY-I", LotSize = 65, TickSize = 0.05m },
        new() { Underlying = "BANKNIFTY", Symbol = "BANKNIFTY-I", LotSize = 30, TickSize = 0.20m },
    };
}

public sealed class TrueDataLiveInstrument
{
    public string Underlying { get; set; } = "";
    public string Symbol { get; set; } = "";
    public int LotSize { get; set; } = 1;
    public decimal TickSize { get; set; } = 0.05m;
}

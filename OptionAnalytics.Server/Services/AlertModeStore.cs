namespace OptionAnalytics.Server.Services;

/// <summary>Whether EmaCrossoverAlertService/ConfluenceAlertService additionally check the STILL-
/// FORMING candle on a short interval ("Live") or only ever react once a candle actually closes
/// ("ClosedConfirmed" - the default, and the only behavior that existed before this store did).
/// Live mode is ADDITIVE, never a replacement: the closed-and-confirmed check keeps running in
/// BOTH modes as the reliable baseline (see both services' own ExecuteAsync doc comments) -
/// switching to Live just adds an earlier, revisable heads-up off the live candle, using the same
/// close-beyond-both-EMAs confirmation rule (EmaCrossoverDetector.ConfirmedDirection), just against
/// whatever the still-forming candle's close is RIGHT NOW instead of waiting for it to finish.
///
/// One shared, app-wide setting - not per-underlying, not per-browser. Both underlyings' alerts go
/// to the one shared Telegram chat regardless of who is looking at the dashboard, so this has to be
/// a single source of truth every viewer's toggle reads and writes, not a local preference each
/// tab could disagree about. Set via POST /api/alerts/mode, read via GET /api/alerts/mode.</summary>
public sealed class AlertModeStore
{
    public const string Live = "Live";
    public const string ClosedConfirmed = "ClosedConfirmed";

    private volatile string _mode = ClosedConfirmed;

    public string Mode => _mode;
    public bool IsLive => _mode == Live;

    /// <summary>Returns false (leaving the mode unchanged) for anything other than the two known
    /// values - a typo'd or stale client request should never silently coerce into a default.</summary>
    public bool TrySet(string? mode)
    {
        if (mode != Live && mode != ClosedConfirmed) return false;
        _mode = mode;
        return true;
    }
}

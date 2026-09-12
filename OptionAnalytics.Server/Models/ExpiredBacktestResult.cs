namespace OptionAnalytics.Server.Models;

/// <summary>What ExpiredOptionBacktestService.RunAsync hands back - the trades/signals a strategy
/// produced, plus enough of how the request was actually resolved (ExpiryCode, the two relative
/// strike tokens, each side's own Dhan error) that the page can show WHY a run came back empty
/// rather than just an empty table. See ExpiredOptionBacktestService's own doc comment for why
/// ExpiryCode is a derived guess rather than something the caller states directly.
///
/// CeSpliceTimes/PeSpliceTimes (see ExpiredOptionBacktestService.DetectPossibleSplices) are the
/// timestamps of any suspiciously large premium jump found in that side's own series - first-hand
/// evidence the fetched window may have crossed from one real contract onto another, since Dhan's
/// docs never state whether a wide date range stays on one single contract or rolls across several
/// as it crosses their individual expiries. Empty does not prove the window stayed on one contract,
/// only that nothing this check can see contradicts it.</summary>
public sealed record ExpiredBacktestResult(
    bool Success,
    string? Error,
    IReadOnlyList<BacktestTrade> Trades,
    IReadOnlyList<BacktestSignal> Signals,
    int ExpiryCode,
    string CeStrike,
    string PeStrike,
    string? CeError,
    string? PeError,
    int SpotBarCount,
    int CeBarCount,
    int PeBarCount,
    IReadOnlyList<DateTimeOffset> CeSpliceTimes,
    IReadOnlyList<DateTimeOffset> PeSpliceTimes)
{
    public static ExpiredBacktestResult Failed(string error) =>
        new(false, error, Array.Empty<BacktestTrade>(), Array.Empty<BacktestSignal>(), 0, "", "", null, null, 0, 0, 0,
            Array.Empty<DateTimeOffset>(), Array.Empty<DateTimeOffset>());
}

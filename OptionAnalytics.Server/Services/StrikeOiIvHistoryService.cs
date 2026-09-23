using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Reconstructs one ABSOLUTE strike's own OI/IV history for the Strike Data page - the page's own
/// candle table (CdvHostedService.GetStrikeCandlesAsync) is plain OHLC with no OI/IV at all, since
/// neither the live tick feed's per-strike bar builder nor Dhan's historical candle REST endpoint
/// carries either field per candle.
///
/// The ONLY place OI/IV exists per-minute at all is NiftyDataCollector's own rolling-option storage
/// (the same one OiReplayService reads) - but that storage is keyed by strike_offset ("ATM+3" etc,
/// see ExpiredOptionBacktestService.StrikeToken), a token relative to whatever ATM was AT THAT
/// MOMENT, re-centered continuously through the day - NOT by absolute strike. There is no single
/// token that means "24200" for the whole history the way this page needs; ATM drift means 24200
/// might have been ATM+3 last Tuesday and ATM-1 today. Each stored row DOES carry its own resolved
/// absolute Strike value alongside its token, though (see StoredRollingOptionDataService's own
/// query) - so the correct reconstruction is to fetch EVERY token's own full history for the
/// requested range and keep only the rows whose own Strike matches the one actually asked for,
/// rather than trying to guess which token corresponds to it on any given day.
///
/// STORED DATA ONLY, NO LIVE DHAN FALLBACK - unlike OiReplayService, this deliberately does not
/// attempt to top up today's own possibly-stale tail with a live call: that would need resolving
/// today's live ATM to know which token to ask Dhan for, doubling this service's own complexity for
/// a gap the OI Replay page already covers with a full live view. Today's OI/IV here may simply lag
/// behind NiftyDataCollector's own poll interval - a real, known limitation, not a bug.
///
/// SENSEX has no stored source AT ALL (see OiReplayService's own "SENSEX IS LIVE-ONLY TOO" doc
/// comment) and this service makes no live call either, so it always returns empty with an
/// explanatory error for SENSEX - never attempts anything.
///
/// ALSO ONLY EVER WORKS WHERE NiftyDataCollectorTimescale IS CONFIGURED - per
/// StoredRollingOptionDataService's own doc comment, that connection string is deliberately blank
/// in every checked-in/production configuration (NiftyDataCollector is a separate, local-only
/// project). This feature is therefore local-development-only by design, same as the "stored data"
/// half of every other page that reads it - a production deployment simply has nothing to show here.
/// </summary>
public sealed class StrikeOiIvHistoryService
{
    /// <summary>Same ATM+-10 band width as OiReplayService/ExpiredOptionBacktestService's own
    /// StrikeBandSteps - every token a real request could plausibly resolve to.</summary>
    private const int StrikeBandSteps = 10;

    private const int NearestExpiryCode = 1;

    private static readonly HashSet<string> UnsupportedUnderlyings = new(StringComparer.OrdinalIgnoreCase) { "SENSEX" };

    private readonly StoredRollingOptionDataService _storedRollingOption;

    public StrikeOiIvHistoryService(StoredRollingOptionDataService storedRollingOption)
    {
        _storedRollingOption = storedRollingOption;
    }

    public async Task<(IReadOnlyList<StrikeOiIvPoint> Points, string? Error)> GetHistoryAsync(
        string underlying, decimal strike, bool isCall, DateOnly expiry,
        DateOnly fromDay, DateOnly toDay, CancellationToken cancellationToken)
    {
        if (UnsupportedUnderlyings.Contains(underlying))
            return (Array.Empty<StrikeOiIvPoint>(), $"OI/IV history isn't available for {underlying} - it has no stored source, and this page doesn't make a live Dhan call for it.");

        if (!_storedRollingOption.IsConfigured)
            return (Array.Empty<StrikeOiIvPoint>(), "Stored data is not configured on this server (no NiftyDataCollector database connection) - OI/IV history is only available where that's set up.");

        // NiftyDataCollector's own rolling storage is keyed by expiry_flag (WEEK/MONTH) + expiry_code
        // (1 = nearest), a ROLLING reference re-centered as contracts expire - the SAME "moving frame,
        // not an absolute key" problem the strike-offset band above solves for strikes. This service
        // only queries the ONE flag the requested absolute date theoretically classifies as (the last
        // Tuesday-equivalent of its own calendar month is "MONTH", every other Tuesday is "WEEK" -
        // ExpiryCalendar's own theoretical rule, not the live scrip master, since a past/expired date
        // the live master no longer lists still needs classifying here), and only at code=1 (nearest).
        // This is correct for exactly the period this contract genuinely WAS the nearest one of that
        // classification - a request spanning further back than that (a far-dated contract inspected
        // long before it became "nearest") simply returns no OI/IV for that earlier stretch rather
        // than guessing at a 2nd/3rd-nearest cycle number, which would risk silently blending in a
        // DIFFERENT contract that happens to share the same strike.
        var expiryFlag = ExpiryCalendar.MonthlyExpiries(expiry, expiry).Count > 0 ? "MONTH" : "WEEK";
        var drvOptionType = isCall ? "CALL" : "PUT";
        var points = new List<StrikeOiIvPoint>();

        for (var steps = -StrikeBandSteps; steps <= StrikeBandSteps; steps++)
        {
            var token = ExpiredOptionBacktestService.StrikeToken(steps);
            var (bars, _) = await _storedRollingOption.GetRollingOptionCandlesAsync(
                underlying, 0, expiryFlag, NearestExpiryCode, token, drvOptionType, fromDay, toDay, 1, cancellationToken);

            foreach (var bar in bars)
                if (bar.Strike == strike)
                    points.Add(new StrikeOiIvPoint(bar.Bar.Time, bar.OpenInterest, bar.ImpliedVolatility));
        }

        points.Sort((a, b) => a.Time.CompareTo(b.Time));
        return (points, null);
    }
}

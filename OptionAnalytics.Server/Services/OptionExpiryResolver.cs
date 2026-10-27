using System.Collections.Concurrent;
using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Services;

/// <summary>The expiry date of the options an OI Replay day shows (the nearest weekly / monthly one on or after the day) -
/// what the GEX card's time to expiry is worked out from.
///  - An expiry from today on is Dhan's own: the expiries the scrip master lists (DhanOptionChainMaster), holiday moves
///    included.
///  - A past one (Dhan lists only live contracts) is the weekday rule (ExpiryCalendar.NearestOptionExpiry: NIFTY / BANKNIFTY
///    Tuesday, SENSEX Thursday), checked against Dhan: a rule day with no spot candles was a holiday, so the expiry was the
///    trading day before (asked of Dhan in turn, never before the replayed day itself, which traded). Kept in memory once
///    found.</summary>
public sealed class OptionExpiryResolver
{
    /// <summary>Where the date came from: Dhan's list, the weekday rule, or the rule moved back for a holiday.</summary>
    public const string FromDhan = "dhan";
    public const string FromCalendar = "calendar";
    public const string FromCalendarHoliday = "calendar-holiday";

    private const int MaxHolidaySteps = 4;

    private readonly Func<string, CancellationToken, Task<IReadOnlyList<DateOnly>>> _listed;
    private readonly Func<string, DateOnly, CancellationToken, Task<bool?>> _tradedOn;
    private readonly Func<DateOnly> _today;
    private readonly ConcurrentDictionary<(string, DateOnly, string), (DateOnly Date, string Source)> _past = new();

    public OptionExpiryResolver(DhanOptionChainMaster chainMaster, DhanSpotInstrumentMaster spotInstruments, DhanHistoricalDataService historical)
        : this(
            async (underlying, ct) =>
            {
                await chainMaster.EnsureLoadedAsync(ct);
                return chainMaster.GetExpiries(underlying);
            },
            async (underlying, day, ct) =>
            {
                await spotInstruments.EnsureLoadedAsync(ct);
                var spot = spotInstruments.FindSpot(underlying);
                if (spot is null) return null;
                var (candles, error) = await historical.GetIntradayCandlesAsync(spot.SecurityId, spot.DhanSegment, day, day, 1, ct);
                return candles.Count > 0 ? true : error is null ? false : null;
            },
            IstClock.Today)
    {
    }

    /// <param name="listed">Dhan's listed expiries of an underlying.</param>
    /// <param name="tradedOn">Whether the index traded that day: true / false, null when Dhan could not say.</param>
    internal OptionExpiryResolver(
        Func<string, CancellationToken, Task<IReadOnlyList<DateOnly>>> listed, Func<string, DateOnly, CancellationToken, Task<bool?>> tradedOn, Func<DateOnly> today)
    {
        _listed = listed;
        _tradedOn = tradedOn;
        _today = today;
    }

    public async Task<(DateOnly Date, string Source)?> ResolveAsync(string underlying, DateOnly date, string expiryFlag, CancellationToken cancellationToken)
    {
        var u = underlying.ToUpperInvariant();
        var flag = expiryFlag.ToUpperInvariant();
        if (ExpiryCalendar.NearestOptionExpiry(u, date, flag) is not { } rule) return null;
        var today = _today();
        if (rule >= today)
        {
            try
            {
                var listed = (await _listed(u, cancellationToken)).Where(e => e >= date).OrderBy(e => e).ToList();
                if (OiReplayLiveFeedService.ResolveNearestExpiryCore(listed, flag) is { } dhan) return (dhan, FromDhan);
            }
            catch (Exception) when (!cancellationToken.IsCancellationRequested)
            {
                // The scrip master not loading is no reason to fail the day - the rule's date stands.
            }
            return (rule, FromCalendar);
        }
        if (_past.TryGetValue((u, date, flag), out var known)) return known;

        // A past rule day: it traded = the expiry; no candles = a holiday, the expiry was the trading day before.
        var day = rule;
        for (var step = 0; step <= MaxHolidaySteps && day > date; step++)
        {
            var traded = await _tradedOn(u, day, cancellationToken);
            if (traded is null) return (rule, FromCalendar); // Dhan could not say: the rule's date, not kept
            if (traded == true) return _past[(u, date, flag)] = (day, day == rule ? FromCalendar : FromCalendarHoliday);
            do day = day.AddDays(-1); while (day.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday);
        }
        // Stepped back to the replayed day itself - it traded, so the expiry was that day.
        return _past[(u, date, flag)] = (day > date ? rule : date, day == rule ? FromCalendar : FromCalendarHoliday);
    }
}

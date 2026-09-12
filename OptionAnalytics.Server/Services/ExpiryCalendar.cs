namespace OptionAnalytics.Server.Services;

/// <summary>
/// Computes candidate real expiry dates for NIFTY/BANKNIFTY index options - Dhan's own live scrip
/// master only lists CURRENTLY listed contracts, so an already-expired one's exact date can't be
/// looked up there at all. This instead generates the dates NSE's own weekly/monthly expiry
/// convention would produce, so ExpiredOptionBacktestService can restrict "give me an expiry date"
/// to dates that are actually real - the root cause of a real bug this app hit: a typed date that
/// was NOT a genuine listed expiry broke the anchoring logic that assumes fromDate sits just inside
/// the target contract's own life, letting the fetch window reach across a REAL contract boundary
/// and splice two different contracts together.
///
/// Current convention (since SEBI's November 2024 single-weekly-expiry-per-exchange rule): every
/// NSE index option expires on TUESDAY - weekly on every Tuesday, monthly on the LAST Tuesday of
/// the month (BANKNIFTY's own weekly options were separately discontinued entirely - see
/// ExpiredOptionBacktestService's own BANKNIFTY+WEEK rejection).
///
/// Two things this deliberately does NOT do, and why that is an acceptable, documented limitation
/// rather than a silent gap:
///   - It does not consult NSE's own trading-holiday calendar (this app has no such calendar to
///     read), so an individual expiry that NSE actually shifted to the previous trading day (a
///     holiday landing on what would otherwise be the expiry Tuesday) is not accounted for - the
///     date this produces can be off by a day in that case. ExpiredOptionBacktestService's existing
///     splice-detection safety net is the backstop for exactly that residual, much smaller error.
///   - It assumes the CURRENT Tuesday convention held for the ENTIRE queried range. An expiry from
///     before the Nov 2024 rule (Thursday, historically, among other prior conventions) would not
///     be generated correctly. Callers are expected to bound how far back they ask this for to a
///     window where the current convention is known to have applied (see
///     ExpiredOptionBacktestService's own bounding of this).
/// </summary>
public static class ExpiryCalendar
{
    private const DayOfWeek ExpiryWeekday = DayOfWeek.Tuesday;

    /// <summary>Every expiry Tuesday in [rangeStart,rangeEnd] inclusive, ascending.</summary>
    public static List<DateOnly> WeeklyExpiries(DateOnly rangeStart, DateOnly rangeEnd)
    {
        var result = new List<DateOnly>();
        if (rangeEnd < rangeStart) return result;

        var day = FirstOnOrAfter(rangeStart, ExpiryWeekday);
        while (day <= rangeEnd)
        {
            result.Add(day);
            day = day.AddDays(7);
        }

        return result;
    }

    /// <summary>The LAST Tuesday of every calendar month touching [rangeStart,rangeEnd], ascending,
    /// restricted to those landing inside the range itself (a month whose own last Tuesday falls
    /// just outside the requested window is not included).</summary>
    public static List<DateOnly> MonthlyExpiries(DateOnly rangeStart, DateOnly rangeEnd)
    {
        var result = new List<DateOnly>();
        if (rangeEnd < rangeStart) return result;

        var monthCursor = new DateOnly(rangeStart.Year, rangeStart.Month, 1);
        var endMonth = new DateOnly(rangeEnd.Year, rangeEnd.Month, 1);
        while (monthCursor <= endMonth)
        {
            var lastDayOfMonth = monthCursor.AddMonths(1).AddDays(-1);
            var lastExpiryWeekday = LastOnOrBefore(lastDayOfMonth, ExpiryWeekday);
            if (lastExpiryWeekday >= rangeStart && lastExpiryWeekday <= rangeEnd) result.Add(lastExpiryWeekday);
            monthCursor = monthCursor.AddMonths(1);
        }

        return result;
    }

    private static DateOnly FirstOnOrAfter(DateOnly date, DayOfWeek weekday)
    {
        var diff = ((int)weekday - (int)date.DayOfWeek + 7) % 7;
        return date.AddDays(diff);
    }

    private static DateOnly LastOnOrBefore(DateOnly date, DayOfWeek weekday)
    {
        var diff = ((int)date.DayOfWeek - (int)weekday + 7) % 7;
        return date.AddDays(-diff);
    }
}

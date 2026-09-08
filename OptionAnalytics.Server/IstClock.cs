namespace OptionAnalytics.Server;

/// <summary>India Standard Time is a fixed UTC+5:30 offset with no daylight saving, so this never
/// needs a timezone database lookup - just the one constant. Defined once here instead of every
/// caller across the Dhan and Services layers (and Services.Backtesting) independently repeating
/// TimeSpan.FromHours(5.5), or re-deriving the same "which IST calendar date does this instant fall
/// on" conversion.
///
/// Pure consolidation, not a behavior change: every caller migrated to this computed the identical
/// value the identical way beforehand - this only removes the duplication, so a value that changes
/// here (it never will; the offset is fixed) changes consistently everywhere instead of needing to
/// be found and fixed in six places one at a time.</summary>
public static class IstClock
{
    public static readonly TimeSpan Offset = TimeSpan.FromHours(5.5);

    /// <summary>The IST calendar date <paramref name="time"/> falls on.</summary>
    public static DateOnly IstDate(DateTimeOffset time) => DateOnly.FromDateTime(time.ToOffset(Offset).DateTime);

    /// <summary>Today's date in IST, right now.</summary>
    public static DateOnly Today() => IstDate(DateTimeOffset.UtcNow);

    /// <summary>The instant <paramref name="minutesOfDay"/> minutes past midnight IST falls on,
    /// for the given IST calendar date - e.g. AtIstTime(date, 915) is that day's 15:15 IST. Used
    /// for a daily square-off cutoff (OptionTradeSimulator.SquareOffTimeParameter): a plain
    /// minutes-of-day number is what the whole parameter pipeline already carries (query string,
    /// controller parsing, IBacktestStrategy.Simulate's decimal dictionary), so the actual
    /// DateTimeOffset only gets built here, once, from that number and the day being walked.</summary>
    public static DateTimeOffset AtIstTime(DateOnly date, int minutesOfDay) =>
        new(date.Year, date.Month, date.Day, minutesOfDay / 60, minutesOfDay % 60, 0, Offset);

    /// <summary>AtIstTime's own inverse for the TIME half - minutes past midnight IST that
    /// <paramref name="time"/> falls at on its own IST calendar day, e.g. an instant at 09:07 IST
    /// returns 547. Used for OptionTradeSimulator.SignalStartTimeParameter: NSE's pre-open session
    /// (roughly 09:00-09:15) is a call auction, not continuous trading, so a bar timestamped inside
    /// it is not a real signal to act on regardless of what its own price momentarily prints.</summary>
    public static int MinutesOfDay(DateTimeOffset time)
    {
        var ist = time.ToOffset(Offset);
        return ist.Hour * 60 + ist.Minute;
    }

    /// <summary>"HH:mm" for a minutes-since-midnight value (AtIstTime/MinutesOfDay's own unit) -
    /// shared formatting so a square-off or signal-start cutoff reads identically everywhere it is
    /// echoed back to a person (a Rejected signal's own summary, a Telegram square-off message).</summary>
    public static string FormatMinutesOfDay(int minutesOfDay) => $"{minutesOfDay / 60:00}:{minutesOfDay % 60:00}";
}

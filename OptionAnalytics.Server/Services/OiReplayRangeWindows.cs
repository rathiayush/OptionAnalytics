namespace OptionAnalytics.Server.Services;

/// <summary>
/// The date maths behind OiReplayService.RunRangeAsync: which Dhan calls one "give me every past
/// day between A and B" request turns into, and how one call's multi-day answer is cut back up into
/// per-day pieces.
///
/// WHY A RANGE AT ALL: the per-day path (OiReplayService.RunAsync) spends 42 Dhan calls on one day
/// (21 strikes ATM-10..ATM+10 x CE/PE), so the strategy tuning job's own 120-day scan spends ~5,000
/// of them - at Dhan's documented 5 Data-API requests/second (https://dhanhq.co/docs/v2/) that is
/// over 20 minutes of nothing but fetching. Dhan's expired-options endpoint
/// (https://dhanhq.co/docs/v2/expired-options-data/ - POST /charts/rollingoption, the SAME endpoint
/// the per-day path already uses) serves "upto 30 days of data in a single API call" and its
/// response carries a per-candle timestamp, so ONE call per relative strike token can cover a whole
/// expiry cycle of days. 42 calls per cycle instead of 42 per day.
///
/// WHY ONE WINDOW PER EXPIRY CYCLE, NEVER WIDER: Dhan resolves WHICH contract a rolling-option call
/// is about from fromDate + expiryCode ("the Nth expiry from fromDate"), not from anything in the
/// request that names a contract. A window that crosses a real expiry therefore rolls onto the NEXT
/// contract partway through - the splicing ExpiredOptionBacktestService's own doc comment describes
/// at length. So a requested range is cut at every real expiry of the requested cadence, and each
/// piece is anchored with ExpiredOptionBacktestService.BuildFetchSegments - the same, proven
/// anchoring the Expired Backtest already uses ("start just after the PREVIOUS expiry of the same
/// cadence, send expiryCode 1, so the 1st expiry from fromDate can only be the one intended"),
/// rather than a second copy of that reasoning written out again here.
///
/// A window is also ALWAYS inside one cadence cycle, which is at most 7 days (weekly) or roughly 28
/// to 35 days (monthly), and MaxRangeDays caps a single request at 31 calendar days - so a window
/// can need at most two of DhanRollingOptionDataService's own 30-day chunks, and both of those still
/// start inside the same cycle (any date after the previous expiry and on/before this one anchors to
/// the same contract), so chunking cannot change which contract a window resolves to either.
/// </summary>
internal static class OiReplayRangeWindows
{
    /// <summary>The widest range one request may ask for. Dhan serves at most 30 days of
    /// expired-option data per call, so a wider range buys nothing in calls saved (it would just be
    /// chunked anyway) while making one request's own failure far more expensive to retry - the
    /// caller asks for the next 31 days instead. 31 (not 30) so a whole calendar month can be asked
    /// for in one go.</summary>
    internal const int MaxRangeDays = 31;

    /// <summary>One Dhan call's own window: [From,To] (inclusive, IST calendar dates), the real
    /// expiry Expiry that every day in it belongs to, and the ExpiryCode to send with it (always 1 -
    /// see this class's own doc comment; carried explicitly rather than assumed so it comes from
    /// BuildFetchSegments, the one place that decides it).</summary>
    internal readonly record struct Window(DateOnly From, DateOnly To, DateOnly Expiry, int ExpiryCode);

    /// <summary>Splits [from,to] into one window per expiry cycle it touches, oldest first, each
    /// anchored so Dhan can only resolve it to that cycle's own contract, and each clamped to
    /// <paramref name="today"/> (a future day has no data to fetch - the same clamp
    /// ExpiredOptionBacktestService.ClampSegmentsToToday applies, reused rather than repeated).
    ///
    /// A cycle's own EXPIRY DAY is deliberately left out of every window (a window ends the day
    /// BEFORE its expiry), so a day in the requested range that is itself an expiry day is covered
    /// by no window at all and the caller fetches it the ordinary per-day way. Two reasons, both
    /// about not guessing:
    ///   - Dhan's "the 1st expiry from fromDate" is not documented for the boundary itself - whether
    ///     a fromDate ON an expiry day counts that expiry or the next one. The per-day path has been
    ///     sending exactly that request for every expiry day the app has ever replayed, so whatever
    ///     Dhan does there is this app's established, proven-in-production behavior; a window
    ///     spanning the boundary could quietly answer differently, and "the same data as the per-day
    ///     path" matters more than saving one day's calls.
    ///   - ExpiryCalendar's own doc comment admits its dates can be a day off when NSE shifts an
    ///     expiry off a holiday. Ending a window the day before keeps the only day that ambiguity
    ///     could bite on the proven path.
    /// So a window can be empty for a cycle whose only requested day IS its expiry - that is not an
    /// error, just a cycle with nothing to fetch in bulk.
    ///
    /// Returns an Error instead when the request itself is not servable: an inverted range, one
    /// wider than MaxRangeDays, or one entirely in the future.</summary>
    internal static (List<Window> Windows, string? Error) Build(string expiryFlag, DateOnly from, DateOnly to, DateOnly today)
    {
        var none = new List<Window>();
        if (to < from) return (none, "'to' date must not be before 'from' date.");

        var span = to.DayNumber - from.DayNumber + 1;
        if (span > MaxRangeDays)
            return (none, $"{span} days is too wide for one request - ask for at most {MaxRangeDays} calendar days at a time " +
                          "(Dhan serves at most 30 days of expired-option data per call), then ask again for the next stretch.");

        if (from > today) return (none, $"{from:dd MMM yyyy} is in the future - there is nothing to fetch yet.");

        var windows = new List<Window>();
        var cursor = from;
        while (cursor <= to)
        {
            var expiry = NextExpiryOnOrAfter(expiryFlag, cursor);

            // The proven anchoring, not a new copy of it: segment 1 is "just after the previous
            // same-cadence expiry .. targetExpiry, expiryCode 1". cursor is always already past that
            // previous expiry (expiry is the FIRST expiry at or after cursor), so this can only ever
            // come back as one segment starting exactly at cursor - Last() is just belt and braces
            // against ever getting the older, code-2 segment that a reach further back would add.
            var segment = ExpiredOptionBacktestService.BuildFetchSegments(expiryFlag, expiry, cursor)[^1];

            // Never past the caller's own `to` (nothing asked for beyond it) and never past the day
            // BEFORE the cycle's expiry (segment.To is that expiry; see this method's own doc
            // comment on why the expiry day itself is left to the per-day path) - so a window can
            // only ever hold days belonging to this one contract, and never the one day whose
            // contract resolution this app cannot establish with certainty.
            var cycleLastFetchableDay = segment.To.AddDays(-1);
            var windowTo = cycleLastFetchableDay < to ? cycleLastFetchableDay : to;
            if (windowTo >= segment.From)
                foreach (var clamped in ExpiredOptionBacktestService.ClampSegmentsToToday(new[] { segment with { To = windowTo } }, today))
                    windows.Add(new Window(clamped.From, clamped.To, expiry, clamped.ExpiryCode));

            cursor = expiry.AddDays(1);
        }

        // Legitimately empty when every requested day is an expiry day (or a weekend/holiday around
        // one) - the caller then simply fetches those days the per-day way.
        return (windows, null);
    }

    /// <summary>ONE window for the whole span [spanFrom, spanTo] (at most MaxRangeDays), straight across
    /// any expiries inside it - one Dhan call per strike covers every day of it ("upto 30 days of data in a
    /// single API call"). Each call is sent exactly as a per-day call for spanFrom would be (fromDate =
    /// spanFrom, expiryCode 1); every later day then rests on Dhan rolling its "nearest expiry" series onto
    /// the next contract at each expiry, the way the per-day path's fromDate = that day would resolve it.
    /// That is NOT documented by Dhan, so it is only ever used once OiReplayService.CheckSpanAsync has
    /// shown it on this server (a day before an expiry, the expiry day and a day after it, each identical
    /// to the per-day fetch) - the strategy tuning job asks for it only then.
    ///
    /// SkipDays: the expiry days inside the span, when <paramref name="includeExpiryDays"/> is false - the
    /// one day the roll could land on either contract. Those days are left to the per-day path, exactly as
    /// the per-cycle windows (Build) always leave them.</summary>
    internal static (Window? Window, HashSet<DateOnly> SkipDays, string? Error) BuildSpanning(
        string expiryFlag, DateOnly spanFrom, DateOnly spanTo, DateOnly today, bool includeExpiryDays)
    {
        var skip = new HashSet<DateOnly>();
        if (spanTo < spanFrom) return (null, skip, "'to' date must not be before 'from' date.");
        var span = spanTo.DayNumber - spanFrom.DayNumber + 1;
        if (span > MaxRangeDays)
            return (null, skip, $"{span} days is too wide for one request - ask for at most {MaxRangeDays} calendar days at a time " +
                                "(Dhan serves at most 30 days of expired-option data per call), then ask again for the next stretch.");
        if (spanFrom > today) return (null, skip, $"{spanFrom:dd MMM yyyy} is in the future - there is nothing to fetch yet.");
        var to = spanTo > today ? today : spanTo;
        if (!includeExpiryDays)
            for (var expiry = NextExpiryOnOrAfter(expiryFlag, spanFrom); expiry <= to; expiry = NextExpiryOnOrAfter(expiryFlag, expiry.AddDays(1)))
                skip.Add(expiry);
        return (new Window(spanFrom, to, NextExpiryOnOrAfter(expiryFlag, spanFrom), 1), skip, null);
    }

    /// <summary>The first real expiry of this cadence at or after <paramref name="day"/> - the
    /// contract every option bar stamped that day belongs to, by the same "nearest expiry" rule the
    /// OI Replay page itself reads OI from (OiReplayService's own doc comment). From
    /// ExpiryCalendar, so weekly/monthly conventions live in exactly one place.</summary>
    internal static DateOnly NextExpiryOnOrAfter(string expiryFlag, DateOnly day) =>
        string.Equals(expiryFlag, "MONTH", StringComparison.OrdinalIgnoreCase)
            // Two months is always enough to contain the next monthly expiry (the last Tuesday of
            // this month, or of the next one when this month's has already passed).
            ? ExpiryCalendar.MonthlyExpiries(day, day.AddMonths(2)).First(e => e >= day)
            : ExpiryCalendar.WeeklyExpiries(day, day.AddDays(14))[0];

    /// <summary>The weekdays in [from,to] that could be trading days at all, ascending - Saturdays
    /// and Sundays are never fetched or reported (no market, no data, and a caller scanning days does
    /// not want to be handed one), and neither is a day past <paramref name="today"/>. A real holiday
    /// cannot be told apart from a weekday without data, so it stays in the list and simply comes
    /// back with nothing - the same answer the per-day path gives for one.</summary>
    internal static List<DateOnly> TradingDayCandidates(DateOnly from, DateOnly to, DateOnly today)
    {
        var days = new List<DateOnly>();
        var last = to > today ? today : to;
        for (var day = from; day <= last; day = day.AddDays(1))
            if (day.DayOfWeek is not (DayOfWeek.Saturday or DayOfWeek.Sunday)) days.Add(day);
        return days;
    }

    /// <summary>Cuts one multi-day fetch back up per day: every requested day gets its own list, in
    /// the order the days were given, holding the items whose own IST calendar date is that day -
    /// EMPTY (never missing) for a day the fetch returned nothing for, so a caller iterating days
    /// cannot silently skip one. Anything dated outside the requested days is dropped (Dhan has been
    /// seen returning a bar one day past an inclusive end date - see
    /// DhanRollingOptionDataService.ClipToRange's own doc comment).</summary>
    internal static Dictionary<DateOnly, List<T>> ByDay<T>(IEnumerable<T> items, Func<T, DateTimeOffset> timeOf, IEnumerable<DateOnly> days)
    {
        var byDay = new Dictionary<DateOnly, List<T>>();
        foreach (var day in days) byDay[day] = new List<T>();
        foreach (var item in items)
            if (byDay.TryGetValue(IstClock.IstDate(timeOf(item)), out var list)) list.Add(item);
        return byDay;
    }
}

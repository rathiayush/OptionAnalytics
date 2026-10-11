namespace OptionAnalytics.Server.Models;

/// <summary>One Dhan window the range fetch actually used, reported back so a caller can SEE how its
/// request was split and check the split itself rather than trust it: From..To (inclusive, IST dates),
/// the real Expiry every day in it belongs to and the ExpiryCode sent with it (see
/// OiReplayRangeWindows' own doc comment - a window never crosses an expiry, which is what guarantees
/// one contract per call). Strikes is how many strike/side series were fetched for it (42 for a full
/// ATM+-10 band), Error whatever Dhan said when the window itself failed - a window that failed is a
/// window whose days fell back to the per-day path, never one quietly returned with holes.</summary>
public sealed record OiReplayRangeWindow(
    DateOnly From, DateOnly To, DateOnly Expiry, int ExpiryCode, int Strikes, string? Error);

/// <summary>
/// Every trading day in one requested date range, each in the EXACT shape the per-day endpoint
/// (OiReplayService.RunAsync / GET /api/oi-replay/{u}/run) returns - so a caller builds its OI
/// context from a day here with the same code, unchanged, as from a day fetched one at a time.
///
/// The point of this endpoint is call count, not shape: the days come from one Dhan call per strike
/// per EXPIRY CYCLE instead of 42 calls per day (see OiReplayRangeWindows). Windows/FallbackDays/
/// OptionSeriesCalls are the self-check: they say how the range was split, which days could not be
/// served from a window and were fetched the old way instead, and how many Dhan option-series calls
/// the whole request actually cost.
/// </summary>
public sealed record OiReplayRangeResult(
    bool Success,
    string? Error,
    string Underlying,
    DateOnly From,
    DateOnly To,
    int TimeframeMinutes,
    string ExpiryFlag,
    /// <summary>One entry per candidate trading day in the range, ascending. A day the market was
    /// closed on (a holiday) is still here, as an unsuccessful day carrying its own reason - empty,
    /// never missing, so a caller walking the range cannot silently skip a day it asked for.</summary>
    IReadOnlyList<OiReplayResult> Days,
    IReadOnlyList<OiReplayRangeWindow> Windows)
{
    /// <summary>The days that did NOT come from a window fetch - a window error, or a day a window
    /// returned no option data for at all - and were fetched through the ordinary per-day path
    /// instead (see OiReplayService.RunRangeAsync). Each such day costs the old 42 calls, so a long
    /// list here means the range path is not earning its keep and is worth looking into; the data
    /// itself is as good as the per-day endpoint's, because it IS the per-day endpoint's.</summary>
    public IReadOnlyList<DateOnly> FallbackDays { get; init; } = Array.Empty<DateOnly>();

    /// <summary>True when the days came from ONE window straight across the expiries (spanExpiries - see
    /// OiReplayRangeWindows.BuildSpanning) rather than one window per expiry cycle.</summary>
    public bool SpanExpiries { get; init; }

    /// <summary>With SpanExpiries: the expiry days in the requested range the spanning window left to the
    /// per-day path (includeExpiryDays was not asked for).</summary>
    public IReadOnlyList<DateOnly> ExpiryDaysLeftOut { get; init; } = Array.Empty<DateOnly>();

    /// <summary>How many Dhan option-series (/charts/rollingoption) calls this request made, window
    /// calls and per-day fallback calls together - what a caller comparing "the range way" against
    /// "the per-day way" for the same stretch of days actually wants to compare. Counts calls this
    /// app made, not chunks Dhan internally split a window into.</summary>
    public int OptionSeriesCalls { get; init; }

    /// <summary>Of OptionSeriesCalls, the ones spent on WINDOW fetches (a whole expiry cycle of days
    /// per call - the point of this endpoint).</summary>
    public int WindowOptionSeriesCalls { get; init; }

    /// <summary>Of OptionSeriesCalls, the ones spent falling back to the per-day path INSIDE this
    /// request (42 per day). Always 0 when PerDayFallback is false. Reported separately because a
    /// window's own calls being spent AND its days' per-day calls being spent on top is exactly the
    /// doubling a caller counting Dhan calls needs to be able to see.</summary>
    public int FallbackOptionSeriesCalls { get; init; }

    /// <summary>Whether this request was allowed to fetch a day the per-day way itself (the default,
    /// and what every existing caller gets). False: a day no window could answer for is returned as
    /// an unsuccessful day carrying that reason and named in UnservedDays, with NO Dhan call spent on
    /// it - the caller fetches it through the per-day endpoint itself, once, through its own cache
    /// and at its own pace. The strategy tuning job asks for that, so one range request's own
    /// timeout can never throw away per-day calls it had already made inside it.</summary>
    public bool PerDayFallback { get; init; } = true;

    /// <summary>With PerDayFallback false: the days a window did not answer for and that this request
    /// therefore did NOT fetch at all. Always empty when PerDayFallback is true (those days are in
    /// FallbackDays instead, fetched).</summary>
    public IReadOnlyList<DateOnly> UnservedDays { get; init; } = Array.Empty<DateOnly>();

    /// <summary>Why NO window was used at all and every day came from the ordinary per-day path -
    /// the server setting StrategyTuning:FastOiRange being off, or an underlying whose expiry cadence
    /// this app's own expiry calendar cannot establish (SENSEX). Null when the fast path was in use.
    /// The days are still here and still correct either way; only the call count differs.</summary>
    public string? FastPathDisabled { get; init; }

    public static OiReplayRangeResult Failed(string underlying, DateOnly from, DateOnly to, int timeframeMinutes, string expiryFlag, string error) =>
        new(false, error, underlying, from, to, timeframeMinutes, expiryFlag, Array.Empty<OiReplayResult>(), Array.Empty<OiReplayRangeWindow>());
}

/// <summary>OiReplayService.CheckSpanAsync's answer: whether one window straight across an expiry gives the
/// same days as the per-day path (AcrossMatch - a day before and a day after the expiry), and whether the expiry
/// day itself does too (ExpiryDayMatch). Error says why nothing could be compared - never a pass.</summary>
public sealed record OiReplaySpanCheck(
    bool AcrossMatch, bool ExpiryDayMatch, DateOnly? Expiry, DateOnly WindowFrom, DateOnly WindowTo,
    IReadOnlyList<OiReplaySpanCheckDay> Days, string? Error, int OptionSeriesCalls);

/// <summary>One day of a span check: Role "before" / "expiry" / "after", whether it matched, and the first
/// differences when it did not.</summary>
public sealed record OiReplaySpanCheckDay(DateOnly Date, string Role, bool Match, IReadOnlyList<string> Differences);

namespace NiftyDataCollector.Collection;

/// <summary>Bound from the "RollingOption" section of appsettings.json - see
/// RollingOptionBackfillHostedService and DhanRollingOptionClient's own doc comments for what this
/// controls and why it defaults to off.</summary>
public sealed class RollingOptionOptions
{
    public const string SectionName = "RollingOption";

    /// <summary>Off by default - a full backfill from StartDate can mean thousands of Dhan API
    /// calls (see DhanRateLimiter's own daily-budget guard). Turn on once you've reviewed the
    /// README section on this feature and are ready for that.</summary>
    public bool Enabled { get; set; } = false;

    /// <summary>How far back to backfill. Defaults to just the last 30 days, per the user's own
    /// "first fetch for 30 days" plan - a small, quick window to confirm the resolved
    /// strike/spot/OI/IV values look right before committing to the full range they actually want
    /// ("2023 march till date"). Once verified, widen this to an earlier date (e.g. "2023-03-01")
    /// in appsettings.Local.json and restart - each series' own checkpoint picks the new, earlier
    /// window up as a BACKWARD extension on the very next pass without re-fetching or disturbing
    /// what this initial 30-day run already saved (see Schema.sql's own doc comment on
    /// backfill_progress). "Till date" itself needs no separate setting - every pass always tops
    /// up through today automatically, same as every other backfill in this project.</summary>
    public DateOnly StartDate { get; set; } = DateOnly.FromDateTime(DateTime.UtcNow.AddDays(-30));

    /// <summary>"WEEK" or "MONTH" - which expiry cycle to roll across. NIFTY trades weekly, so
    /// WEEK is the default; switch to MONTH for an underlying that only has monthly expiries.</summary>
    public string ExpiryFlag { get; set; } = "WEEK";

    /// <summary>Which "cycles out" to backfill - CONFIRMED 1-indexed against a real account: 1 is
    /// the currently-rolling nearest cycle, 2 the one after that. (0 is NOT valid - Dhan's API
    /// rejects it outright with "Input_Exception: expiryCode is required", i.e. it's treated as
    /// equivalent to omitting the field entirely, not as "cycle zero".) Defaults to the nearest 2
    /// expiries ([1, 2]) per the user's own spec.</summary>
    public List<int> ExpiryCodes { get; set; } = new() { 1, 2 };

    /// <summary>How often to re-run the whole underlying x offset x leg x expiryCode sweep once the
    /// initial catch-up finishes - each series' own checkpoint means a re-run only ever asks for
    /// "yesterday..today" once caught up, not the whole range again.</summary>
    public int PollIntervalMinutes { get; set; } = 60;
}

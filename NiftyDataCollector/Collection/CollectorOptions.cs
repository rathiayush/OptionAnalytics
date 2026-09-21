namespace NiftyDataCollector.Collection;

/// <summary>One index this collector tracks - its own strike spacing, since NIFTY (50) and
/// BANKNIFTY (100) don't share one (SEBI can revise either independently - same caveat
/// OptionAnalytics.Server's own DhanOptionInstrument.LotSize doc comment gives for lot sizes).
/// Name must be a key DhanSpotInstrumentMaster's own IndexAliases recognizes.</summary>
public sealed class TrackedUnderlying
{
    public string Name { get; set; } = "NIFTY";
    public int StrikeStep { get; set; } = 50;

    /// <summary>"WEEK" or "MONTH" - which expiry cycle RollingOptionBackfillHostedService rolls
    /// across for THIS underlying specifically. Per-underlying (not a single shared setting)
    /// because NIFTY and BANKNIFTY genuinely don't share one: NSE discontinued BANKNIFTY's own
    /// weekly options entirely, so requesting "WEEK" for it returns nothing to backfill at all -
    /// confirmed in practice (zero rows ever saved for BANKNIFTY under WEEK). CollectorHostedService
    /// itself doesn't use this field - it discovers real expiries from the live option chain
    /// directly, which needs no cadence hint.</summary>
    public string ExpiryFlag { get; set; } = "WEEK";
}

/// <summary>Bound from the "Collector" section of appsettings.json.</summary>
public sealed class CollectorOptions
{
    public const string SectionName = "Collector";

    /// <summary>Which indices to track - each gets its own full cycle (spot bars, live option
    /// chain, per-strike OHLC backfill) every poll. Defaults to NIFTY only, per the user's own
    /// request to run NIFTY's backfill first and add BANKNIFTY in a later run - just add
    /// { "Name": "BANKNIFTY", "StrikeStep": 100 } to Collector:Underlyings in appsettings.json (or
    /// appsettings.Local.json) whenever ready; each security's own checkpoint means the two never
    /// interfere with each other regardless of when each is started.</summary>
    public List<TrackedUnderlying> Underlyings { get; set; } = new()
    {
        new TrackedUnderlying { Name = "NIFTY", StrikeStep = 50 },
    };

    /// <summary>ATM +/- this many strikes each side, per the user's own spec.</summary>
    public int StrikesEachSide { get; set; } = 10;

    /// <summary>How many of the nearest listed expiries to track at once.</summary>
    public int TrackedExpiryCount { get; set; } = 1;

    /// <summary>How many calendar days back a NEW contract's (or spot's) historical OHLC backfill
    /// reaches - OHLC/volume history is real and Dhan will actually serve it; OI/IV are NOT
    /// affected by this (they only ever come from the live option-chain poll below, which starts
    /// accumulating from whenever this collector first runs, not retroactively - see this project's
    /// README for why). Defaults to 500 per the user's own spec. Dhan's intraday endpoint caps a
    /// single call at ~90 days, so DhanHistoricalDataClient splits a range this long into multiple
    /// chunked calls automatically - see its own doc comment, and RefreshSpotBarsAsync /
    /// RefreshOptionBarsAsync below for why each chunk is saved (and only counted "done") on its
    /// own, rather than the whole 500-day range succeeding or failing as one unit.</summary>
    public int BackfillDays { get; set; } = 500;

    /// <summary>An explicit "backfill from THIS calendar date" override, per the user's own request
    /// for one shared date they can set once and have EVERY table (spot_bars_1m, option_bars_1m,
    /// AND rolling_option_bars_1m) backfill from - not just rolling-option data, which already had
    /// its own absolute RollingOption:StartDate. Null (the default) leaves every table on its own
    /// existing independent default (BackfillDays here, RollingOption:StartDate there). Set this to
    /// override BOTH: CollectorHostedService uses it in place of BackfillDays'
    /// today-minus-N-days computation, and RollingOptionBackfillHostedService uses it in place of
    /// RollingOption:StartDate (see RefreshSeriesAsync's own read of it). Same rules as any other
    /// backfill-range change in this project apply once set - see Schema.sql's own doc comment on
    /// backfill_progress: an earlier date than what's already covered is picked up automatically as
    /// a checkpointed BACKWARD extension on the next cycle, never disturbing what's already saved.
    /// Takes effect on restart (bound once at startup, not hot-reloaded mid-run).</summary>
    public DateOnly? BackfillFromDate { get; set; } = null;

    /// <summary>How often to poll the live option chain (OI/IV/greeks/volume) per tracked expiry -
    /// bounded below by DhanRateLimiter's own 3.5s-per-call floor regardless of how low this is
    /// set.</summary>
    public int SnapshotPollIntervalSeconds { get; set; } = 60;

    /// <summary>How often to re-check whether each tracked contract's OWN historical OHLC bars
    /// need refreshing (today's own session keeps growing new bars as the day progresses).</summary>
    public int HistoricalRefreshIntervalMinutes { get; set; } = 5;
}

namespace NiftyDataCollector.Collection;

/// <summary>Bound from the "Collector" section of appsettings.json.</summary>
public sealed class CollectorOptions
{
    public const string SectionName = "Collector";

    /// <summary>NIFTY's own strike spacing - 50 as of this build (SEBI can revise it, same caveat
    /// OptionAnalytics.Server's own DhanOptionInstrument.LotSize doc comment gives for lot sizes).</summary>
    public int StrikeStep { get; set; } = 50;

    /// <summary>ATM +/- this many strikes each side, per the user's own spec.</summary>
    public int StrikesEachSide { get; set; } = 10;

    /// <summary>How many of the nearest listed expiries to track at once.</summary>
    public int TrackedExpiryCount { get; set; } = 1;

    /// <summary>How many calendar days back a NEW contract's (or spot's) historical OHLC backfill
    /// reaches - OHLC/volume history is real and Dhan will actually serve it; OI/IV are NOT
    /// affected by this (they only ever come from the live option-chain poll below, which starts
    /// accumulating from whenever this collector first runs, not retroactively - see this project's
    /// README for why).</summary>
    public int BackfillDays { get; set; } = 5;

    /// <summary>How often to poll the live option chain (OI/IV/greeks/volume) per tracked expiry -
    /// bounded below by DhanRateLimiter's own 3.5s-per-call floor regardless of how low this is
    /// set.</summary>
    public int SnapshotPollIntervalSeconds { get; set; } = 60;

    /// <summary>How often to re-check whether each tracked contract's OWN historical OHLC bars
    /// need refreshing (today's own session keeps growing new bars as the day progresses).</summary>
    public int HistoricalRefreshIntervalMinutes { get; set; } = 5;
}

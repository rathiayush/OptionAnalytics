namespace OptionAnalytics.Server.Services;

/// <summary>Bound from the "StrategyTuning" section of appsettings.json (or StrategyTuning__*
/// environment variables) - the knobs the strategy tuning job's own server side needs, separate from
/// the job script's own settings, which the job itself carries.</summary>
public sealed class StrategyTuningOptions
{
    public const string SectionName = "StrategyTuning";

    /// <summary>Whether GET /api/oi-replay/{u}/range may fetch a whole expiry cycle of days per Dhan
    /// call (see OiReplayService.RunRangeAsync / OiReplayRangeWindows) - the fast path a 120-day
    /// tuning job exists for.
    ///
    /// Turn it OFF to go straight back to the behavior this app has always had, with no code change
    /// and no redeploy: the range endpoint keeps working and keeps returning the same shape, but
    /// every day in it is fetched the ordinary per-day way (OiReplayService.RunAsync, 42 Dhan calls
    /// per day), exactly as if the endpoint did not exist. That is the switch to reach for if a
    /// replayed day ever looks wrong - this data prices real trades, so "slow but proven" must always
    /// be one setting away.
    ///
    /// Default true. It changes NOTHING about the per-day endpoint itself either way: GET
    /// /api/oi-replay/{u}/run never consults this.</summary>
    public bool FastOiRange { get; set; } = true;
}

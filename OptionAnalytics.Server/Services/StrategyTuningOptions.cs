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

    // The three settings below are READ WITH IConfiguration, not through this class (StrategyTuningService
    // and the job script need them as plain environment values), and are listed here so the whole
    // "StrategyTuning" section is documented in one place:
    //
    //   JobBudgetMinutes (default 90, 1 .. 1440) - the whole job's time. Past it the job stops scanning and
    //     stops starting new strategies, writes its result and history with the days it got to, and says how
    //     many that was. Passed to the job as TUNE_JOB_BUDGET_MS; a job is never started without one.
    //   MaxFetchesPerDay (default 3, 1 .. 10) - how many times one day's data of one kind may be fetched in a
    //     whole job. One day's option chain is 42 Dhan calls, and the busy-retry rounds used to multiply that
    //     by up to eight for a day that stayed broken. Passed as TUNE_MAX_FETCHES_PER_DAY.
    //   MaxResumes (default 2, 0 .. 10) - how many times a job interrupted by a server stop may be started
    //     again (StrategyTuningService.ResumeInterrupted / current-job.json) before it is given up on with a
    //     reason, instead of being restarted after every restart for ever.
}

namespace OptionAnalytics.Server.Models;

/// <summary>One saved "watch this strategy and tell me when it fires" rule. It is the exact same
/// inputs the Backtrack page runs a backtest with - underlying, strategy, timeframe and that
/// strategy's own parameters - which is the point: whatever you tuned there can be armed here
/// unchanged, and the live alerts then come from the same code path the backtest measured.</summary>
public sealed record StrategyTrigger(
    string Id,
    string Name,
    string Underlying,
    string StrategyKey,
    int TimeframeMinutes,
    IReadOnlyDictionary<string, decimal> Parameters,
    bool Enabled,
    DateTimeOffset CreatedUtc)
{
    /// <summary>The last entry signal this trigger has already alerted on. A newly-armed trigger is
    /// primed with whatever the latest signal is at that moment WITHOUT alerting, so arming it
    /// doesn't immediately dump every historical signal into Telegram; only genuinely new ones
    /// after that point notify.</summary>
    public DateTimeOffset? LastSignalUtc { get; init; }

    /// <summary>When this trigger last actually sent a notification, and what it said - so the page
    /// can show that a trigger is alive and working rather than just "enabled".</summary>
    public DateTimeOffset? LastFiredUtc { get; init; }
    public string? LastFiredSummary { get; init; }
}

/// <summary>What the triggers page POSTs to create one - the server assigns Id/CreatedUtc.</summary>
public sealed record StrategyTriggerRequest(
    string Name,
    string Underlying,
    string StrategyKey,
    int TimeframeMinutes,
    IReadOnlyDictionary<string, decimal> Parameters,
    bool Enabled);

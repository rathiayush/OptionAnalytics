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
    /// <summary>Whether a fired trade also gets a real Dhan Super Order PLACED - see
    /// StrategyTriggerHostedService's own doc comment for why this is a SEPARATE opt-in from
    /// Enabled, defaulting to false even for triggers created before this existed: Enabled only
    /// ever meant "watch and alert", and a config load must never silently upgrade an existing
    /// trigger into one that also places real orders.</summary>
    public bool LiveTradingEnabled { get; init; }

    /// <summary>Lots per order - Dhan's quantity is raw units, so this gets multiplied by the
    /// contract's own lot size (DhanOptionInstrument.LotSize, read from the scrip master since
    /// SEBI revises it periodically) when an order is actually built. Only meaningful when
    /// LiveTradingEnabled.</summary>
    public int QuantityLots { get; init; } = 1;

    /// <summary>Points added to (a buy) or subtracted from (a sell) the entry price to form a
    /// marketable LIMIT order - Dhan's Super Order does not support orderType MARKET for this
    /// instrument type, so every entry (and every re-priced retry - see MaxDeviationPercent) is a
    /// LIMIT order priced to fill immediately in practice. Only meaningful when LiveTradingEnabled.</summary>
    public decimal SlippagePoints { get; init; } = 1;

    /// <summary>How far (in percent) the live premium may drift from the price the alert actually
    /// reported (BacktestTrade.EntryPrice - the SAME fixed reference every retry checks against,
    /// never the previous retry's own price, so a string of small steps can never add up to
    /// accepting a wildly different fill) before StrategyTriggerHostedService gives up re-pricing
    /// an unfilled LIMIT order and cancels it instead. Options can move very fast in the couple of
    /// minutes an order sits unfilled - this is what stops the retry loop from chasing a price that
    /// has moved for a real reason (a spike, not just a quiet resting order not being hit) into a
    /// fill nobody would actually want. Only meaningful when LiveTradingEnabled.</summary>
    public decimal MaxDeviationPercent { get; init; } = 10;

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
    bool Enabled,
    bool LiveTradingEnabled,
    int QuantityLots,
    decimal SlippagePoints,
    decimal MaxDeviationPercent);

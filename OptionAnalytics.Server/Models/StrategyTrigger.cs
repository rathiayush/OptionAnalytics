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

    /// <summary>Price the order off the strike's LIVE tick right now, instead of the signal bar's
    /// own already-closed close (OptionTradeSimulator's own entry price - see its doc comment).
    ///
    /// Off (the default, and the one that matches what Backtrack itself shows for the same signal):
    /// the entry is that signal bar's Close, which is already a real, fixed, past price the instant
    /// the signal exists - no further bar has to close first, and the same code path Backtrack runs
    /// resolves it, so the live fill and the backtested one price identically.
    ///
    /// On: the entry reference is instead whatever the strike is trading at RIGHT NOW
    /// (CdvUnderlyingState's latest bar, still-forming one included) rather than the signal bar's
    /// fixed Close - a different, later-in-time price that a backtest has no tick history to
    /// reproduce, so the live fill will not match what Backtrack modelled for the same signal. Only
    /// useful for a strategy that wants to react to price movement AFTER the signal bar closed
    /// rather than trade the print that confirmed the signal; not a "faster" mode any more, since
    /// the default path no longer waits on anything either.
    ///
    /// Defaults to false, including for every trigger created before this existed - the price a
    /// live order is built from must never change underneath an already-armed trigger.</summary>
    public bool UseLivePremiumEntry { get; init; }

    /// <summary>The expiry the ORDER is placed in, when it should not simply follow whatever expiry
    /// the app is currently tracking.
    ///
    /// Null (the default, and what every trigger created before this existed keeps) means "use the
    /// tracked expiry" - CdvUnderlyingState.Expiry, whatever the dashboard/Backtrack selector has
    /// this underlying on right now, which is the behaviour this had all along.
    ///
    /// Set, it pins the order to that expiry regardless of what is being tracked - a next-month
    /// contract, say, while the signals keep coming off the near expiry's chart. Two consequences
    /// that follow from that and are handled in StrategyTriggerHostedService.BuildOrderPlan rather
    /// than left to surprise anyone:
    ///
    ///   - The simulator's own entry price belongs to a DIFFERENT contract, so it cannot price this
    ///     order. A pinned expiry that isn't the tracked one is always priced off that contract's
    ///     own live quote, whatever UseLivePremiumEntry says.
    ///   - That quote comes from Dhan's Option Chain API rather than the live websocket feed (only
    ///     the tracked expiry's contracts are subscribed), so it is a snapshot a few seconds old
    ///     and rate-limited. Fine for pricing an order; it is not a tick feed.
    ///
    /// The strategy's slPoints/tpPoints are still applied as ABSOLUTE POINTS off that entry. A far
    /// expiry trades at a different premium and a different vol, so a stop that was tuned on the
    /// near month is not the same risk there - re-tune it rather than assuming it carries over.</summary>
    public DateOnly? OrderExpiry { get; init; }

    /// <summary>Feature flag: what to do when a fresh signal fires for this trigger while its
    /// earlier position is still open at Dhan (see StrategyTriggerHostedService.BuildOrderPlan's
    /// DhanPositionsClient check).
    ///
    /// Off (the default, and what every trigger created before this existed keeps): the new
    /// signal is skipped outright and reported as [NO ORDER PLACED] - the original behaviour,
    /// never silently changed under an already-armed trigger.
    ///
    /// On: instead of skipping, the existing Super Order's STOP_LOSS_LEG is MODIFIED to the new
    /// signal's own entry price +/- slPoints (the same formula a fresh entry would use, re-based
    /// off the latest confirmation rather than the original one) - a Telegram [STOP LOSS UPDATED]
    /// message reports the move. No second order is ever placed either way; this only changes
    /// what happens to the FIRST one's protective stop.</summary>
    public bool AdjustStopLossOnOpenPosition { get; init; }

    /// <summary>How many strike-steps further OTM than the SOLD leg's own strike a PROTECTIVE
    /// hedge leg is bought at, automatically, whenever this trigger's fired trade sells an option
    /// (Side = Sell) with LiveTradingEnabled on - the classic "sell a closer premium, buy a
    /// cheaper far one" credit spread a real option seller uses to cap tail risk (and often for
    /// margin benefit) instead of going naked. Distance from the SOLD strike, not from ATM - same
    /// idea as otmSteps, just walked further out from wherever this trade's own strike already
    /// landed rather than from ATM again.
    ///
    /// 0 (the default, and what every trigger created before this existed keeps) means no hedge -
    /// a naked sell, exactly the behavior this had all along. Never read on the Buy side: a bought
    /// option's own downside is already capped at the premium paid, so there is nothing to hedge.
    ///
    /// Live trading only - see BuildOrderPlanAsync. The backtest keeps modeling the naked leg
    /// exactly as it always did; OptionTradeSimulator has no concept of a second leg.
    ///
    /// If the hedge leg cannot be resolved or priced, the WHOLE order is aborted rather than
    /// placing the sell naked - see BuildOrderPlanAsync's own doc comment for why "asked for a
    /// spread, got a naked sell instead" is never an acceptable silent substitution with real
    /// money on the line.</summary>
    public int HedgeOtmSteps { get; init; }

    /// <summary>How liquid a strike has to be before this trigger will BUY it as the protective
    /// hedge leg (see HedgeOtmSteps), as a percentage of the SOLD strike's own open interest.
    ///
    /// The problem this solves: HedgeOtmSteps is a distance, and far-OTM strikes thin out fast. The
    /// strike that distance lands on can be listed and still carry a last-traded price from hours
    /// ago while having essentially no book behind it - so buying it means crossing a wide spread at
    /// a price nobody is really quoting, and then owning something that may be hard to sell back
    /// when CloseHedgeIfOpenAsync comes to close it.
    ///
    /// Measured RELATIVE to the sold strike rather than as an absolute contract count on purpose.
    /// The sold leg is near ATM and liquid by construction (it is what the strategy just picked), so
    /// it is a live, per-underlying, per-expiry yardstick - one that stays meaningful across
    /// NIFTY/BANKNIFTY/SENSEX, across SEBI's periodic lot-size revisions, and whatever unit Dhan
    /// happens to report OI in. An absolute threshold would have to be re-tuned for each of those
    /// and would be silently wrong in between.
    ///
    /// A strike that fails this does NOT abort the order on its own: HedgeStrikeWalkedInward walks
    /// INWARD toward the sold strike - the only safe direction, since closer to ATM is both more
    /// liquid and more protective - and takes the first strike that passes, down to a floor of half
    /// the requested distance. Only when nothing in that band qualifies is the whole order abandoned,
    /// for the same reason every other hedge failure abandons it: a sell this trigger was configured
    /// to hedge must never go out naked instead.
    ///
    /// null (what every trigger created before this existed deserializes to) means the default,
    /// HedgeDefaultMinOpenInterestPercent - the guard is ON by default, since an unhedgeable strike
    /// is exactly what someone enabling a hedge is trying to avoid. An explicit 0 disables the check
    /// and takes whatever strike the distance lands on, liquid or not.</summary>
    public int? HedgeMinOpenInterestPercent { get; init; }

    /// <summary>The Dhan plain-order id for this trigger's currently-open PROTECTIVE hedge leg
    /// (see HedgeOtmSteps) - LastOrderId's own counterpart, for the identical reason: a background
    /// sweep needs to know which order/position it is watching across restarts. Cleared once the
    /// hedge position is confirmed closed (CloseHedgeIfOpenAsync), same lifecycle LastOrderId has.
    /// Always null for a trigger with HedgeOtmSteps == 0, or for a fired trade on the Buy side.</summary>
    public string? LastHedgeOrderId { get; init; }

    /// <summary>The Dhan Super Order id from this trigger's most recent successful placement -
    /// set the instant PlaceOrderAsync gets an order id back, regardless of whether it has filled
    /// yet. SquareOffIfDueAsync is the one reader: it is how a square-off sweep, running on its
    /// own on a timer rather than off a fresh signal, finds which order (and so which contract and
    /// live position) THIS trigger is responsible for, since Dhan's own position book carries no
    /// per-trigger tag of its own. Cleared back to null once that order/position is confirmed no
    /// longer open (whichever closed it - its own bracket, or a square-off), so a sweep does no
    /// work for a trigger with nothing open. Survives a restart (persisted like LastSignalUtc)
    /// since a position can still be open when the app comes back up.</summary>
    public string? LastOrderId { get; init; }

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
    decimal MaxDeviationPercent,
    bool UseLivePremiumEntry,
    DateOnly? OrderExpiry = null,
    bool AdjustStopLossOnOpenPosition = false,
    int HedgeOtmSteps = 0,
    int? HedgeMinOpenInterestPercent = null);

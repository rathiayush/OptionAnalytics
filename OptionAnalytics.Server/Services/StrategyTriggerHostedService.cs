using Microsoft.AspNetCore.SignalR;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Hubs;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Telegram;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Watches every enabled StrategyTrigger and sends a Telegram message when its strategy would have
/// opened a NEW trade.
///
/// It re-runs the very same BacktestService.RunStrategy the Backtrack page's trade table uses, on
/// an interval, and compares the newest trade's signal time against the one the trigger last saw.
/// RunStrategy - not the raw EntrySignals a strategy also exposes - is the deliberate choice: it
/// goes through OptionTradeSimulator, whose one-position-at-a-time rule (a signal arriving while an
/// earlier trade is still open is skipped) is exactly what "alert only on a confirmed, tradable
/// signal" means. A trending session can have a strategy's raw signal source re-qualify many times
/// in the same direction (the 5 EMA setup's rolling alert candle is the clearest case: each pullback
/// candle that clears the EMA and then breaks becomes its own signal) - alerting on every one of
/// those would page the user for what is, from a one-position book's point of view, the same trade
/// opportunity restated. RunStrategy already collapses that, so reusing it is what makes "tuned on
/// Backtrack, fires live off identical code" true of the ALERT CADENCE too, not just the entry rule.
///
/// A trade only carries a real EntryTimeUtc/EntryPrice once the option's NEXT bar has fully CLOSED
/// (BacktestStrategyContext.GetOptionBars is closed-bars-only, same as everywhere else in this
/// app's replay) - so a signal that fired only moments ago routinely comes back as
/// BacktestTrade.NoData for a cycle or two, not because its strike was never tracked but because
/// the fill it needs isn't known yet. THE WATERMARK MUST NOT ADVANCE PAST SUCH A SIGNAL: it needs
/// to be re-examined on a later cycle once the entry bar has closed, at which point the SAME
/// signal - same SignalTimeUtc - resolves into a real, alertable trade. Advancing past it early
/// would never be alerted at all once it did resolve, which is why the watermark below only ever
/// moves to the newest signal that was ACTUALLY alerted, never to the newest signal RunStrategy
/// merely returned. A strike that truly never gets tracked just stays NoData forever and parks the
/// watermark harmlessly behind it - later, unrelated signals are unaffected, since they are still
/// newer than that stuck point.
///
/// Arming a trigger never floods: the first evaluation only records where the strategy currently
/// stands, without alerting. Only trades opening after that notify. The same priming happens if a
/// trigger has been disabled for a while and is switched back on, so a re-enabled trigger doesn't
/// replay everything it missed.
///
/// LiveTradingEnabled triggers ALSO get a real Dhan Super Order PLACED from the fired trade - see
/// BuildOrderPlan for exactly how the strategy's points-based SL/TP and this trigger's own
/// quantity/slippage become the absolute prices and lot-multiplied quantity Dhan's API wants. This
/// is a SEPARATE opt-in from Enabled (which only ever means "watch and alert over Telegram") and
/// defaults to off - including for every trigger that existed before this capability did, since a
/// config load must never silently upgrade a watch-only trigger into one placing real orders. A
/// placement failure (a rejected order, Dhan unreachable, IP not whitelisted) is reported in both
/// the server log and the Telegram message, never swallowed silently - the Telegram/dashboard
/// alert for the underlying signal still goes out regardless of whether the order succeeded.
/// </summary>
public sealed class StrategyTriggerHostedService : BackgroundService
{
    /// <summary>How often to re-evaluate. Signals only change when a bar closes (a minute at the
    /// finest timeframe), so polling faster than this would just repeat identical work.</summary>
    private static readonly TimeSpan EvaluationInterval = TimeSpan.FromSeconds(30);

    /// <summary>Let the feeds backfill and the first bars close before the first evaluation -
    /// evaluating against a half-loaded history would prime triggers at the wrong point.</summary>
    private static readonly TimeSpan StartupDelay = TimeSpan.FromMinutes(1);

    /// <summary>Every option order this app ever places is intraday - matches OptionTradeSimulator's
    /// own "positions never carry overnight" rule, so a live order can never end up in a state the
    /// backtest that validated the strategy never modeled.</summary>
    private const string ProductType = "INTRADAY";

    /// <summary>Dhan's Super Order does not support orderType MARKET for this instrument type -
    /// every entry is a LIMIT order priced with StrategyTrigger.SlippagePoints of headroom so it
    /// fills immediately in practice (see BuildOrderPlan).</summary>
    private const string OrderType = "LIMIT";

    /// <summary>Total price attempts for an unfilled entry leg - the initial placement plus up to
    /// this many minus one re-priced retries (so 4 total = 1 placement + 3 retries). Each retry
    /// waits FillCheckInterval, then either finds the entry TRADED (done) or re-prices off the
    /// latest live premium and MODIFYs the same order - see MonitorFillAsync.</summary>
    private const int MaxFillAttempts = 4;

    /// <summary>How long to let a placed or just-repriced LIMIT order rest before checking whether
    /// it filled. Short on purpose - StrategyTrigger.MaxDeviationPercent's own doc comment explains
    /// why this whole loop exists: an option's premium can move fast enough in a couple of minutes
    /// that a slow poll would burn through the deviation budget before ever re-pricing.</summary>
    private static readonly TimeSpan FillCheckInterval = TimeSpan.FromSeconds(5);

    private readonly StrategyTriggerStore _store;
    private readonly BacktestService _backtest;
    private readonly TelegramAlertService _telegram;
    private readonly CdvHostedService _cdv;
    private readonly DhanOptionChainMaster _optionChainMaster;
    private readonly DhanSuperOrderClient _superOrders;
    private readonly IHubContext<SpotHub> _hub;
    private readonly ILogger<StrategyTriggerHostedService> _logger;

    public StrategyTriggerHostedService(
        StrategyTriggerStore store, BacktestService backtest, TelegramAlertService telegram,
        CdvHostedService cdv, DhanOptionChainMaster optionChainMaster, DhanSuperOrderClient superOrders,
        IHubContext<SpotHub> hub, ILogger<StrategyTriggerHostedService> logger)
    {
        _store = store;
        _backtest = backtest;
        _telegram = telegram;
        _cdv = cdv;
        _optionChainMaster = optionChainMaster;
        _superOrders = superOrders;
        _hub = hub;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(StartupDelay, stoppingToken);

            while (!stoppingToken.IsCancellationRequested)
            {
                foreach (var trigger in _store.GetAll().Where(t => t.Enabled))
                {
                    if (stoppingToken.IsCancellationRequested) break;
                    try
                    {
                        await EvaluateAsync(trigger, stoppingToken);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        // One bad trigger (a strategy key that no longer exists, say) must not stop
                        // the others from being watched.
                        _logger.LogError(ex, "Trigger {Name} ({Id}) failed to evaluate.", trigger.Name, trigger.Id);
                    }
                }

                await Task.Delay(EvaluationInterval, stoppingToken);
            }
        }
        catch (OperationCanceledException)
        {
            // Shutting down.
        }
    }

    private async Task EvaluateAsync(StrategyTrigger trigger, CancellationToken cancellationToken)
    {
        var trades = _backtest.RunStrategy(trigger.Underlying, trigger.StrategyKey, trigger.TimeframeMinutes, trigger.Parameters)
            .OrderBy(t => t.SignalTimeUtc)
            .ToList();

        if (trades.Count == 0) return;

        if (trigger.LastSignalUtc is not { } lastSeen)
        {
            // First look at this trigger - remember where things stand, alert on nothing. Priming
            // off the newest signal overall (even a still-pending/NoData one) is fine here: nothing
            // before "now" should ever alert regardless of how it eventually resolves.
            var latest = trades[^1];
            _store.MarkEvaluated(trigger.Id, latest.SignalTimeUtc, firedSummary: null);
            _logger.LogInformation("Trigger {Name} armed at {Time:u} - future trades will notify.", trigger.Name, latest.SignalTimeUtc);
            return;
        }

        // Only trades whose entry bar has actually closed - see this class's own doc comment for
        // why the watermark must never advance past one that hasn't (EntryTimeUtc null) yet.
        var tradable = trades.Where(t => t.SignalTimeUtc > lastSeen && t.EntryTimeUtc is not null).ToList();
        if (tradable.Count == 0) return;

        // The strategy's own EntrySignals carries the human-readable WHY ("Spot crossed down +
        // ATM PE confirmed + ...") that BacktestTrade doesn't - matched back by time+direction so
        // the alert explains the reasoning, not just the fill RunStrategy decided on.
        var reasons = _backtest.ReplayForStrategy(trigger.Underlying, trigger.StrategyKey, trigger.TimeframeMinutes, trigger.Parameters)
            .Where(s => s.Kind is "Entry" or "Confluence")
            .ToDictionary(s => (s.TimeUtc, s.Direction), s => s.Summary);

        foreach (var trade in tradable)
        {
            reasons.TryGetValue((trade.SignalTimeUtc, trade.Direction), out var reason);
            await NotifyAsync(trigger, trade, reason, cancellationToken);
        }

        _store.MarkEvaluated(trigger.Id, tradable[^1].SignalTimeUtc, firedSummary: Describe(tradable[^1]));
    }

    private static string Describe(BacktestTrade trade) =>
        $"{trade.Side} {trade.OptionType} {trade.Strike:0.##} @ {trade.EntryPrice:0.##}";

    private async Task NotifyAsync(StrategyTrigger trigger, BacktestTrade trade, string? reason, CancellationToken cancellationToken)
    {
        var arrow = trade.Direction == "Bullish" ? "▲" : "▼";
        var reasonLine = reason is null ? "" : $"\n{reason}";
        var ist = TimeSpan.FromHours(5.5);

        var orderLine = "";
        if (trigger.LiveTradingEnabled)
        {
            var plan = BuildOrderPlan(trigger, trade);
            orderLine = plan is null ? "" : $"\n\n{await PlaceOrderAsync(trigger, trade, plan, cancellationToken)}";
        }

        // Entry time/price here are exactly BacktestTrade.EntryTimeUtc/EntryPrice - the same fields
        // the Backtrack trade table's own "Entry" column renders - not the signal bar. The signal
        // is WHEN the strategy decided to act; the entry is WHAT you would actually have punched
        // into the order, at the next bar's open, which is what this alert is for.
        //
        // [Trigger] up front for the same reason EmaCrossoverAlertService/ConfluenceAlertService
        // tag their own messages - this is the confirmed, strategy-driven alert, distinct from the
        // raw always-on EMA/Confluence feed that shares the same Telegram chat.
        var message =
            $"[Trigger] <b>{arrow} {trigger.Name}</b>\n" +
            $"<b>{trade.Underlying}</b> · {trigger.TimeframeMinutes}m · {trigger.StrategyKey}\n" +
            $"<b>{trade.Direction}</b> — {trade.Side} {trade.OptionType} {trade.Strike:0.##}{reasonLine}\n" +
            $"Entry: {trade.EntryTimeUtc!.Value.ToOffset(ist):HH:mm} IST @ {trade.EntryPrice:0.##}\n" +
            $"Signal bar: {trade.SignalTimeUtc.ToOffset(ist):yyyy-MM-dd HH:mm} IST" +
            orderLine;

        _logger.LogInformation("Trigger {Name} fired: {Direction} {Side} {OptionType} {Strike}", trigger.Name, trade.Direction, trade.Side, trade.OptionType, trade.Strike);

        await _telegram.SendAsync(message, cancellationToken);

        // Also push it to any open dashboard, reusing the alert feed the page already renders.
        try
        {
            var alert = new ConfluenceAlert(trade.Underlying, DateTimeOffset.UtcNow, "Confluence", trade.Direction, 0, null, message);
            await _hub.Clients.All.SendAsync("confluenceAlert", alert, cancellationToken);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Could not broadcast trigger {Name} to the dashboard.", trigger.Name);
        }
    }

    /// <summary>Turns a fired trade into the exact Dhan Super Order it should place. Null when the
    /// contract can't be resolved (no expiry currently tracked for this underlying, or that exact
    /// strike/side isn't in the scrip master), which is logged and simply skips placement rather
    /// than failing the whole notification - the Telegram/dashboard alert for the signal itself
    /// still goes out either way.
    ///
    /// The conversions from what OptionTradeSimulator already computed to what Dhan's API wants:
    ///   - Contract: resolved from CdvHostedService's CURRENTLY tracked expiry for this underlying
    ///     (CdvUnderlyingState.Expiry - whatever the dashboard/Backtrack expiry selector has it on
    ///     right now) plus the trade's own strike/side - not the expiry that happened to be nearest
    ///     when some earlier signal fired, since a live order has to name a real, currently-listed
    ///     contract.
    ///   - Quantity: StrategyTrigger.QuantityLots x DhanOptionInstrument.LotSize (raw units Dhan's
    ///     API wants, not lots).
    ///   - Price: a LIMIT order (Dhan's Super Order has no MARKET support for this instrument type)
    ///     priced StrategyTrigger.SlippagePoints beyond BacktestTrade.EntryPrice in the direction
    ///     that keeps it marketable - above entry for a buy, below for a sell - so it fills
    ///     immediately in practice without actually being an unprotected market order.
    ///   - Target/stop-loss: entryPrice +/- the strategy's own tpPoints/slPoints parameters,
    ///     mirroring OptionTradeSimulator.Run's exact formula so the live order's exits match what
    ///     Backtrack measured for this same strategy.
    ///   - Every price is rounded to the contract's own tick size (DhanOptionInstrument.TickSize) -
    ///     Dhan rejects a price that isn't a whole multiple of it.
    /// </summary>
    private SuperOrderPlan? BuildOrderPlan(StrategyTrigger trigger, BacktestTrade trade)
    {
        if (trade.EntryPrice is not { } entryPrice) return null; // shouldn't happen - EvaluateAsync only calls this for trades with a resolved entry

        var expiry = _cdv.States.TryGetValue(trade.Underlying, out var cdvState) ? cdvState.Expiry : null;
        if (expiry is null)
        {
            _logger.LogWarning("Trigger {Name}: no currently-tracked expiry for {Underlying} - cannot place order.", trigger.Name, trade.Underlying);
            return null;
        }

        var isCall = trade.OptionType == "CE";
        var contract = _optionChainMaster.Find(trade.Underlying, expiry.Value, trade.Strike, isCall);
        if (contract is null)
        {
            _logger.LogWarning("Trigger {Name}: {Underlying} {Strike}{Type} not found on expiry {Expiry} - cannot place order.",
                trigger.Name, trade.Underlying, trade.Strike, trade.OptionType, expiry.Value);
            return null;
        }

        var isSell = trade.Side == "Sell";
        var slPoints = trigger.Parameters.GetValueOrDefault("slPoints", 10);
        var tpPoints = trigger.Parameters.GetValueOrDefault("tpPoints", 20);

        // Same mirror-for-a-seller formula as OptionTradeSimulator.Run.
        var rawStopLoss = isSell ? entryPrice + slPoints : Math.Max(0, entryPrice - slPoints);
        var rawTarget = isSell ? Math.Max(0, entryPrice - tpPoints) : entryPrice + tpPoints;
        var rawLimit = Math.Max(0, isSell ? entryPrice - trigger.SlippagePoints : entryPrice + trigger.SlippagePoints);

        var tick = contract.TickSize;
        var limitPrice = RoundToTick(rawLimit, tick);
        var targetPrice = RoundToTick(rawTarget, tick);
        var stopLossPrice = RoundToTick(rawStopLoss, tick);

        var quantity = trigger.QuantityLots * contract.LotSize;
        var transactionType = isSell ? "SELL" : "BUY";
        var correlationId = $"{trigger.Id}-{trade.SignalTimeUtc:yyyyMMddHHmm}";

        var summary = $"{transactionType} {contract.TradingSymbol} x{quantity} (SecurityId {contract.SecurityId})\n" +
            $"LIMIT {limitPrice:0.##} · Target {targetPrice:0.##} · SL {stopLossPrice:0.##}";

        return new SuperOrderPlan(transactionType, contract.SecurityId.ToString(), quantity, limitPrice, targetPrice, stopLossPrice, tick, correlationId, summary);
    }

    /// <summary>Places the order and, on success, hands the fill-monitoring off to MonitorFillAsync
    /// as a background task rather than awaiting it here - a resting LIMIT order can take up to
    /// MaxFillAttempts x FillCheckInterval to resolve, and blocking on that would stall every OTHER
    /// trigger's evaluation behind this one order (EvaluateAsync/ExecuteAsync call this once per
    /// fired trade, in a loop over all enabled triggers). Returns only the line for the IMMEDIATE
    /// Telegram message - [ORDER PLACED] with Dhan's own order id/status on success (fill/cancel
    /// outcome follows later as its own message via NotifyFollowUpAsync), or [ORDER FAILED] with
    /// the reason on failure. Never throws: PlaceAsync already logs and returns null on any error
    /// (network, rejection, missing IP whitelisting), so a failed placement never stops the
    /// underlying signal alert from going out.</summary>
    private async Task<string> PlaceOrderAsync(StrategyTrigger trigger, BacktestTrade trade, SuperOrderPlan plan, CancellationToken cancellationToken)
    {
        var result = await _superOrders.PlaceAsync(
            plan.TransactionType, "NSE_FNO", ProductType, OrderType,
            plan.SecurityId, plan.Quantity, plan.Price, plan.TargetPrice, plan.StopLossPrice,
            plan.CorrelationId, trailingJump: 0, cancellationToken);

        if (result is null)
        {
            _logger.LogError("Trigger {Name}: Super Order placement FAILED for {Summary}", trigger.Name, plan.Summary);
            return $"[ORDER FAILED]\n{plan.Summary}\nCheck server logs - a common cause is the account's static IP whitelisting not covering this server.";
        }

        _logger.LogInformation("Trigger {Name}: Super Order placed - orderId={OrderId} status={Status} for {Summary}",
            trigger.Name, result.OrderId, result.OrderStatus, plan.Summary);

        // Fire-and-forget: runs against the hosted service's own stoppingToken (so it stops
        // cleanly on shutdown) rather than any per-evaluation token, and its own try/catch is just
        // a backstop - MonitorFillAsync already handles its expected failure modes internally, this
        // only stops an unexpected bug there from going unlogged.
        _ = Task.Run(async () =>
        {
            try { await MonitorFillAsync(trigger, trade, plan, result.OrderId, cancellationToken); }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "Trigger {Name}: fill-monitoring crashed for order {OrderId}.", trigger.Name, result.OrderId);
            }
        }, CancellationToken.None);

        return $"[ORDER PLACED] Dhan order {result.OrderId} ({result.OrderStatus})\n{plan.Summary}\nMonitoring fill (up to {MaxFillAttempts} attempts)...";
    }

    /// <summary>The retry loop: waits FillCheckInterval, checks whether the entry leg has filled,
    /// and if not either re-prices it off the LATEST live premium and MODIFYs the same order, or -
    /// once the live premium has drifted too far from the ORIGINAL signal price, or attempts run
    /// out - CANCELs it instead of leaving a stale LIMIT order resting unmonitored.
    ///
    /// The deviation check ALWAYS compares against <paramref name="trade"/>.EntryPrice, the fixed
    /// price the alert actually reported - never the previous retry's own price. That is the whole
    /// point of MaxDeviationPercent (see its own doc comment): a string of small re-prices could
    /// otherwise walk an order arbitrarily far from what the signal actually called for, each step
    /// individually small, without ever tripping a limit that only ever looks one step back. An
    /// option that has genuinely spiked (the 100 -> 80 example) must abort on the very FIRST retry,
    /// not be chased down.
    ///
    /// Runs entirely off DhanSuperOrderClient.ListAsync/ModifyAsync/CancelAsync, none of which
    /// throw on failure (they log and return null/empty) - an inconclusive read (a transient list
    /// failure, or the order not yet visible) just costs one of the MaxFillAttempts checks rather
    /// than aborting monitoring outright, so a flaky poll can never leave an order both unfilled and
    /// unwatched.</summary>
    private async Task MonitorFillAsync(StrategyTrigger trigger, BacktestTrade trade, SuperOrderPlan plan, string orderId, CancellationToken cancellationToken)
    {
        var isCall = trade.OptionType == "CE";
        var isSell = trade.Side == "Sell";
        var referencePrice = trade.EntryPrice!.Value; // fixed for every attempt - see this method's own doc comment
        var currentPrice = plan.Price;

        for (var attempt = 1; attempt <= MaxFillAttempts; attempt++)
        {
            try
            {
                await Task.Delay(FillCheckInterval, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                return; // shutting down - leave the order exactly as it is, nothing more to do
            }

            var orders = await _superOrders.ListAsync(cancellationToken);
            var order = orders.FirstOrDefault(o => o.OrderId == orderId);
            if (order is null)
            {
                _logger.LogWarning("Trigger {Name}: order {OrderId} not visible on attempt {Attempt}/{Max} - will check again.",
                    trigger.Name, orderId, attempt, MaxFillAttempts);
                continue;
            }

            var entryLeg = order.LegDetails.FirstOrDefault(l => l.LegName == "ENTRY_LEG");
            var entryStatus = entryLeg?.OrderStatus ?? order.OrderStatus;

            if (string.Equals(entryStatus, "TRADED", StringComparison.OrdinalIgnoreCase))
            {
                _logger.LogInformation("Trigger {Name}: order {OrderId} filled on attempt {Attempt}/{Max}.", trigger.Name, orderId, attempt, MaxFillAttempts);
                await NotifyFollowUpAsync(trigger, $"[ORDER FILLED] {plan.Summary}\nFilled on attempt {attempt}/{MaxFillAttempts} at ~{currentPrice:0.##}.", cancellationToken);
                return;
            }

            if (entryStatus is "CANCELLED" or "REJECTED" or "CLOSED")
            {
                // Already off the book by some other means (manual cancel, Dhan-side rejection
                // discovered late) - nothing for this loop to do, and nothing to cancel.
                _logger.LogWarning("Trigger {Name}: order {OrderId} is {Status} - stopping fill monitoring.", trigger.Name, orderId, entryStatus);
                await NotifyFollowUpAsync(trigger, $"[ORDER {entryStatus}] {plan.Summary}", cancellationToken);
                return;
            }

            if (entryStatus == "PART_TRADED")
            {
                // Partially filled - re-pricing or cancelling the remainder risks the filled portion
                // ending up without its own SL/target tracking correctly, so this stops chasing it
                // and leaves the resting remainder for the user to handle manually rather than
                // guessing.
                _logger.LogWarning("Trigger {Name}: order {OrderId} is PART_TRADED - stopping automatic retries, leaving remainder as-is.", trigger.Name, orderId);
                await NotifyFollowUpAsync(trigger, $"[ORDER PARTIALLY FILLED] {plan.Summary}\nPart of the quantity filled - the rest is left resting; check Dhan directly.", cancellationToken);
                return;
            }

            // Still PENDING/TRANSIT - this was the last allowed check, so no more re-pricing: fall
            // through to the cancel below instead of placing yet another attempt.
            if (attempt == MaxFillAttempts) break;

            var latestPrice = GetLatestPremium(trade.Underlying, trade.Strike, isCall);
            if (latestPrice is null)
            {
                _logger.LogWarning("Trigger {Name}: no live premium available for {Strike}{Type} - cannot re-price order {OrderId} on attempt {Attempt}/{Max}.",
                    trigger.Name, trade.Strike, trade.OptionType, orderId, attempt, MaxFillAttempts);
                continue;
            }

            var deviationPercent = referencePrice == 0 ? 0 : Math.Abs(latestPrice.Value - referencePrice) / referencePrice * 100;
            if (deviationPercent > trigger.MaxDeviationPercent)
            {
                _logger.LogWarning(
                    "Trigger {Name}: live premium {Latest:0.##} has moved {Deviation:0.#}% from the signal price {Reference:0.##} (limit {Limit:0.#}%) - cancelling order {OrderId} instead of chasing it.",
                    trigger.Name, latestPrice, deviationPercent, referencePrice, trigger.MaxDeviationPercent, orderId);
                await CancelOrderAsync(trigger, orderId, plan,
                    $"price moved {deviationPercent:0.#}% from the signal price ({referencePrice:0.##} -> {latestPrice:0.##}), past the {trigger.MaxDeviationPercent:0.#}% limit",
                    cancellationToken);
                return;
            }

            var rawPrice = Math.Max(0, isSell ? latestPrice.Value - trigger.SlippagePoints : latestPrice.Value + trigger.SlippagePoints);
            var newPrice = RoundToTick(rawPrice, plan.TickSize);

            var modifyResult = await _superOrders.ModifyAsync(orderId, "ENTRY_LEG", orderType: null, quantity: null,
                price: newPrice, targetPrice: null, stopLossPrice: null, trailingJump: null, cancellationToken);
            if (modifyResult is null)
            {
                _logger.LogWarning("Trigger {Name}: re-price MODIFY failed for order {OrderId} on attempt {Attempt}/{Max} - will check again.",
                    trigger.Name, orderId, attempt, MaxFillAttempts);
                continue;
            }

            currentPrice = newPrice;
            _logger.LogInformation("Trigger {Name}: re-priced order {OrderId} to {Price:0.##} (attempt {Attempt}/{Max}, live premium {Live:0.##}).",
                trigger.Name, orderId, newPrice, attempt + 1, MaxFillAttempts, latestPrice);
        }

        _logger.LogWarning("Trigger {Name}: order {OrderId} still unfilled after {Max} attempts - cancelling.", trigger.Name, orderId, MaxFillAttempts);
        await CancelOrderAsync(trigger, orderId, plan, $"did not fill after {MaxFillAttempts} attempts", cancellationToken);
    }

    /// <summary>The latest known premium for one strike, INCLUDING the still-forming bar
    /// (CdvUnderlyingState.GetStrikeCandles, not the closed-only view) - a retry re-pricing off a
    /// stale closed-bar price could lag the live market by up to a full bar. Null if the underlying
    /// isn't tracked at all or the strike has no candles yet.</summary>
    private decimal? GetLatestPremium(string underlying, decimal strike, bool isCall)
    {
        if (!_cdv.States.TryGetValue(underlying, out var state)) return null;
        var candles = state.GetStrikeCandles(strike, isCall);
        return candles is { Count: > 0 } ? candles[^1].Close : null;
    }

    private async Task CancelOrderAsync(StrategyTrigger trigger, string orderId, SuperOrderPlan plan, string reason, CancellationToken cancellationToken)
    {
        var result = await _superOrders.CancelAsync(orderId, "ENTRY_LEG", cancellationToken);
        if (result is null)
        {
            _logger.LogError("Trigger {Name}: failed to cancel unfilled order {OrderId} ({Reason}) - it may still be resting live, check Dhan directly.",
                trigger.Name, orderId, reason);
            await NotifyFollowUpAsync(trigger,
                $"[ORDER CANCEL FAILED] {plan.Summary}\nReason: {reason}\nCould not confirm the cancel with Dhan - check the account directly, the order may still be live.",
                cancellationToken);
            return;
        }

        _logger.LogInformation("Trigger {Name}: cancelled unfilled order {OrderId} - {Reason}.", trigger.Name, orderId, reason);
        await NotifyFollowUpAsync(trigger, $"[ORDER CANCELLED] {plan.Summary}\nReason: {reason}", cancellationToken);
    }

    /// <summary>Sends a standalone Telegram message for something MonitorFillAsync/CancelOrderAsync
    /// discovered well after the trigger's own initial alert already went out - a fill, a cancel, or
    /// a give-up - so the outcome doesn't wait on (or get lost inside) that earlier message.</summary>
    private async Task NotifyFollowUpAsync(StrategyTrigger trigger, string body, CancellationToken cancellationToken)
    {
        try
        {
            await _telegram.SendAsync($"[Trigger] <b>{trigger.Name}</b>\n{body}", cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "Trigger {Name}: could not send follow-up Telegram message.", trigger.Name);
        }
    }

    private static decimal RoundToTick(decimal price, decimal tick) =>
        tick > 0 ? Math.Round(price / tick, MidpointRounding.AwayFromZero) * tick : price;

    private sealed record SuperOrderPlan(
        string TransactionType, string SecurityId, int Quantity,
        decimal Price, decimal TargetPrice, decimal StopLossPrice, decimal TickSize,
        string CorrelationId, string Summary);
}

using System.Collections.Concurrent;
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
/// A trade carries a real EntryTimeUtc/EntryPrice as soon as the SIGNAL bar itself has closed -
/// entry is that same bar's own Close (see OptionTradeSimulator's own doc comment for why that is
/// not look-ahead), so there is no further bar to wait on. The one remaining way a fresh signal
/// still comes back as BacktestTrade.NoData for a cycle is a genuine data gap: this exact strike's
/// own tick coverage for that bucket has not landed yet (feed lag of a few seconds, not a whole bar)
/// or it was never tracked at all. THE WATERMARK MUST NOT ADVANCE PAST SUCH A SIGNAL: it needs to be
/// re-examined on a later cycle once that data lands, at which point the SAME signal - same
/// SignalTimeUtc - resolves into a real, alertable trade. Advancing past it early would never be
/// alerted at all once it did resolve, which is why the watermark below only ever moves to the
/// newest signal that was ACTUALLY alerted, never to the newest signal RunStrategy merely returned.
/// A strike that truly never gets tracked just stays NoData forever and parks the watermark
/// harmlessly behind it - later, unrelated signals are unaffected, since they are still newer than
/// that stuck point.
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
    /// <summary>A slow BACKSTOP sweep, not the trigger mechanism. Evaluation is driven by
    /// SpotUnderlyingState.BarClosed (see ExecuteAsync/OnBarClosed) so a signal is acted on the
    /// instant the bar that creates it closes, rather than up to a poll-interval later. This sweep
    /// only covers the cases no bar close will: a trigger armed while the market is shut still gets
    /// primed, and a missed event (a feed reconnect straddling a bar boundary) cannot strand a
    /// trigger until the next close. It normally finds nothing, because BarClosed already did.</summary>
    private static readonly TimeSpan BackstopInterval = TimeSpan.FromMinutes(1);

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

    /// <summary>How much wider than the trigger's own SlippagePoints a retry for a FULLY unfilled
    /// entry (no quantity traded at all yet - as opposed to a PART_TRADED one, which already
    /// escalates round over round on its own, see the re-price step in MonitorFillAsync) is allowed
    /// to price through, e.g. SlippagePoints=1 retries an unfilled entry at 3 points of slippage.
    /// The original price already failed to clear once; repeating that same price attempt after
    /// attempt would just fail the same way again, so every retry re-prices at this SAME wider band
    /// (not progressively wider each round) until it fills, MaxDeviationPercent trips, or attempts
    /// run out - same fixed-multiplier pattern LiveSpreadCalculator's own
    /// EngineOptions.RetryUnfilledLegSlippageMultiplier uses for its unfilled-leg retries.</summary>
    private const decimal UnfilledRetrySlippageMultiplier = 3m;

    /// <summary>How long to let a placed or just-repriced LIMIT order rest before checking whether
    /// it filled. Short on purpose - StrategyTrigger.MaxDeviationPercent's own doc comment explains
    /// why this whole loop exists: an option's premium can move fast enough in a couple of minutes
    /// that a slow poll would burn through the deviation budget before ever re-pricing.</summary>
    /// <summary>How stale an Option Chain snapshot may be when it is pricing an order in an expiry
    /// this app does not track (see StrategyTrigger.OrderExpiry). Shorter than that API's own 30s
    /// cache because a fill-retry re-prices every FillCheckInterval and a stale number would make
    /// both the re-price and the deviation guard meaningless; still well outside Dhan's one-call-
    /// every-3-seconds limit, which DhanOptionChainQuotes enforces separately either way.</summary>
    private static readonly TimeSpan ForeignExpiryQuoteMaxAge = TimeSpan.FromSeconds(4);

    private static readonly TimeSpan FillCheckInterval = TimeSpan.FromSeconds(5);

    private readonly StrategyTriggerStore _store;
    private readonly BacktestService _backtest;
    private readonly TelegramAlertService _telegram;
    private readonly SpotFeedHostedService _spotFeed;
    private readonly CdvHostedService _cdv;
    private readonly DhanOptionChainMaster _optionChainMaster;
    private readonly DhanSuperOrderClient _superOrders;
    private readonly DhanPositionsClient _positions;
    private readonly DhanOrderClient _orders;
    private readonly DhanMarketFeedClient _feedClient;
    private readonly TriggerOrderHistoryStore _orderHistory;
    private readonly IHubContext<SpotHub> _hub;
    private readonly ILogger<StrategyTriggerHostedService> _logger;

    /// <summary>Underlyings with an evaluation already in flight. A bar close arriving while the
    /// previous evaluation is still running is COALESCED rather than queued: the running one reads
    /// whatever bars have closed by the time it gets there, so queueing a second would only repeat
    /// identical work - and on a single-core box a backlog of them would keep falling further
    /// behind exactly when the market is busiest.</summary>
    private readonly ConcurrentDictionary<string, byte> _inFlight = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>The BarClosed handlers this service attached, kept so StopAsync can detach them -
    /// SpotUnderlyingState outlives this service (it belongs to SpotFeedHostedService), so a
    /// handler left attached would keep firing into a stopped service.</summary>
    private readonly List<(SpotUnderlyingState State, Action<Candle> Handler)> _barClosedHandlers = new();

    public StrategyTriggerHostedService(
        StrategyTriggerStore store, BacktestService backtest, TelegramAlertService telegram,
        SpotFeedHostedService spotFeed, CdvHostedService cdv, DhanOptionChainMaster optionChainMaster,
        DhanSuperOrderClient superOrders, DhanPositionsClient positions, DhanOrderClient orders,
        DhanMarketFeedClient feedClient, TriggerOrderHistoryStore orderHistory,
        IHubContext<SpotHub> hub, ILogger<StrategyTriggerHostedService> logger)
    {
        _store = store;
        _backtest = backtest;
        _telegram = telegram;
        _spotFeed = spotFeed;
        _cdv = cdv;
        _optionChainMaster = optionChainMaster;
        _superOrders = superOrders;
        _positions = positions;
        _orders = orders;
        _feedClient = feedClient;
        _orderHistory = orderHistory;
        _hub = hub;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(StartupDelay, stoppingToken);

            // Evaluate the moment a bar CLOSES, not on a timer. Every strategy's entry condition is
            // defined on closed bars (see this class's doc comment), so a bar close is precisely the
            // event that can change the answer - and between two closes there is nothing new to
            // read, however often you look. Reacting to the event instead of polling removes the
            // dead time a poll leaves between the bar closing and anyone noticing.
            //
            // Same event ConfluenceAlertService already reacts to, for the same reason.
            foreach (var (underlying, spotState) in _spotFeed.States)
            {
                var capturedUnderlying = underlying;
                void Handler(Candle _) => OnBarClosed(capturedUnderlying, stoppingToken);

                spotState.BarClosed += Handler;
                _barClosedHandlers.Add((spotState, Handler));
            }

            while (!stoppingToken.IsCancellationRequested)
            {
                await Task.Delay(BackstopInterval, stoppingToken);

                // See BackstopInterval: this is the safety net, not the mechanism.
                foreach (var underlying in _spotFeed.States.Keys)
                {
                    if (stoppingToken.IsCancellationRequested) break;
                    OnBarClosed(underlying, stoppingToken);
                }

                // Square-off is time-driven, not signal-driven - a position can need closing at
                // 15:10 with no fresh bar/signal anywhere near that instant, so it rides on this
                // same once-a-minute timer rather than OnBarClosed.
                await SquareOffAllDueAsync(stoppingToken);
            }
        }
        catch (OperationCanceledException)
        {
            // Shutting down.
        }
    }

    public override Task StopAsync(CancellationToken cancellationToken)
    {
        foreach (var (state, handler) in _barClosedHandlers) state.BarClosed -= handler;
        _barClosedHandlers.Clear();
        return base.StopAsync(cancellationToken);
    }

    /// <summary>Dispatches an evaluation for one underlying. Deliberately NOT awaited on the calling
    /// thread: BarClosed is raised from the WebSocket tick path (SpotUnderlyingState.ApplyTick), and
    /// an evaluation is a full strategy replay taking a hundred milliseconds or more - doing that
    /// inline would stall tick processing for EVERY instrument on the feed, which is a far worse
    /// problem than the latency it was trying to remove.</summary>
    private void OnBarClosed(string underlying, CancellationToken stoppingToken)
    {
        if (stoppingToken.IsCancellationRequested) return;
        if (!_inFlight.TryAdd(underlying, 0)) return; // already evaluating this underlying - see _inFlight

        _ = Task.Run(async () =>
        {
            try
            {
                await EvaluateUnderlyingAsync(underlying, stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "Trigger evaluation for {Underlying} failed.", underlying);
            }
            finally
            {
                _inFlight.TryRemove(underlying, out _);
            }
        }, CancellationToken.None);
    }

    /// <summary>Every enabled trigger watching this one underlying. Scoped per-underlying because
    /// that is what a bar close is about - a NIFTY bar closing tells you nothing new about a
    /// BANKNIFTY trigger, and re-running it would be wasted work on every close.</summary>
    private async Task EvaluateUnderlyingAsync(string underlying, CancellationToken cancellationToken)
    {
        var triggers = _store.GetAll()
            .Where(t => t.Enabled && string.Equals(t.Underlying, underlying, StringComparison.OrdinalIgnoreCase));

        foreach (var trigger in triggers)
        {
            if (cancellationToken.IsCancellationRequested) break;
            try
            {
                await EvaluateAsync(trigger, cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // One bad trigger (a strategy key that no longer exists, say) must not stop the
                // others from being watched.
                _logger.LogError(ex, "Trigger {Name} ({Id}) failed to evaluate.", trigger.Name, trigger.Id);
            }
        }
    }

    private async Task EvaluateAsync(StrategyTrigger trigger, CancellationToken cancellationToken)
    {
        // Which expiry's premium data this trigger reasons about: its OWN pinned one, so an armed
        // trigger is unaffected by whatever expiry any page happens to be looking at. Each trigger
        // runs independently - its own strategy, its own timeframe, its own expiry.
        //
        // The fallback matters as much as the pin. A pinned expiry that is NOT tracked (it rolled
        // off the tracked set, or was pinned before this app tracked several at once) would resolve
        // to no state at all, and the trigger would quietly stop producing signals - the exact
        // silent-failure this whole change exists to remove. It falls back to the default expiry's
        // data instead: this strategy's signals come from SPOT, which is the same whatever expiry is
        // traded, and the ORDER is still built and priced on the pinned contract (see
        // BuildOrderPlanAsync). Degrading to that is what the trigger did before it could pin data
        // at all, and it says so once per evaluation rather than going dark.
        var dataExpiry = trigger.OrderExpiry;
        if (dataExpiry is { } pinned && _cdv.StateFor(trigger.Underlying, pinned) is null)
        {
            _logger.LogWarning(
                "Trigger {Name}: expiry {Expiry} is not tracked - reading signals from the default expiry's data. The order is still placed on {Expiry}.",
                trigger.Name, pinned, pinned);
            dataExpiry = null;
        }

        var trades = _backtest.RunStrategy(trigger.Underlying, trigger.StrategyKey, trigger.TimeframeMinutes, trigger.Parameters, dataExpiry)
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

        // Normally: only trades whose entry bar has actually closed - see this class's own doc
        // comment for why the watermark must never advance past one that hasn't (EntryTimeUtc null)
        // yet.
        //
        // With StrategyTrigger.UseLivePremiumEntry the wait is the very thing being removed: the
        // signal is actionable the instant the SIGNAL bar closes, priced off the live premium (see
        // BuildOrderPlan, which has its own GetOrderPremiumAsync fallback to a live Option Chain
        // quote for exactly a strike with no tracked candle history) - so a trade with no resolved
        // entry bar still counts, AS LONG AS the signal itself resolved a real strike (t.Strike > 0
        // - the only case that stays excluded, since that means the signal's own spot bar was
        // missing and there is no contract to price at all).
        //
        // This used to read "t.ExitReason != "NoData"" instead of "t.Strike > 0", which was dead
        // code: OptionTradeSimulator only ever leaves EntryTimeUtc null on a NoData trade (the two
        // are set together), so whenever the first half of this OR was false, ExitReason was ALWAYS
        // "NoData" too - the second half could never be true, and UseLivePremiumEntry silently made
        // no difference to this filter at all. That is exactly why a signal on a strike whose next
        // option bar hadn't closed yet (or had never been tracked) sat here forever with no alert
        // and no order, even on a trigger explicitly configured to skip that wait - the live-quote
        // fallback in BuildOrderPlanAsync was reachable in theory but never reached in practice.
        var tradable = trades
            .Where(t => t.SignalTimeUtc > lastSeen
                && (t.EntryTimeUtc is not null || (trigger.UseLivePremiumEntry && t.Strike > 0)))
            .ToList();
        if (tradable.Count == 0) return;

        // The strategy's own EntrySignals carries the human-readable WHY ("Spot crossed down +
        // ATM PE confirmed + ...") that BacktestTrade doesn't - matched back by time+direction so
        // the alert explains the reasoning, not just the fill RunStrategy decided on.
        var reasons = _backtest.ReplayForStrategy(trigger.Underlying, trigger.StrategyKey, trigger.TimeframeMinutes, trigger.Parameters, dataExpiry)
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

    /// <summary>The correlationId prefix a square-off order carries - distinguishes it from an
    /// entry order's own "{trigger.Id}-{signal time}" scheme (see PlaceOrderAsync) so
    /// SquareOffIfDueAsync can tell "is a square-off already working for this trigger" apart from
    /// "is a fresh entry working".</summary>
    private static string SquareOffCorrelationPrefix(string triggerId) => $"{triggerId}-squareoff-";

    /// <summary>One sweep across every live-trading trigger with a configured square-off time -
    /// see SquareOffIfDueAsync for what each one actually does. Runs off ExecuteAsync's own
    /// once-a-minute backstop timer (square-off is time-driven, not signal-driven, so there is no
    /// bar-close event to react to instead) and, like EvaluateUnderlyingAsync, never lets one bad
    /// trigger stop the rest from being checked.</summary>
    private async Task SquareOffAllDueAsync(CancellationToken cancellationToken)
    {
        // Deliberately NOT filtered to Enabled/LiveTradingEnabled - a real open position at Dhan
        // does not stop mattering just because someone toggled the trigger off afterward. Anything
        // with a LastOrderId placed an order at some point and needs watching until it is
        // confirmed flat, whatever the trigger's current settings say.
        var triggers = _store.GetAll().Where(t => t.LastOrderId is not null);

        foreach (var trigger in triggers)
        {
            if (cancellationToken.IsCancellationRequested) break;
            try
            {
                await SquareOffIfDueAsync(trigger, cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "Trigger {Name} ({Id}): open-position check crashed.", trigger.Name, trigger.Id);
            }
        }
    }

    /// <summary>The per-trigger check SquareOffAllDueAsync's sweep runs every minute for as long as
    /// StrategyTrigger.LastOrderId is set: first, has the position this trigger opened actually
    /// closed since the last sweep - via its own stop-loss, its own target, or anything else - and
    /// if so, is that something worth telling a person about (see NotifyPositionClosedIfKnownAsync)
    /// rather than just going quiet? Only once that's settled, and only while the position is STILL
    /// open, does a configured square-off time (StrategyTrigger.Parameters["squareOffMinutes"] -
    /// OptionTradeSimulator's same shared parameter, applied here to the real position rather than
    /// a simulated one) get a chance to actually close it out early.
    ///
    /// Ground truth throughout, exactly like BuildOrderPlanAsync's own open-position check:
    /// LastOrderId only says which Super Order this trigger is watching, never assumed still open -
    /// GET /super/orders and GET /positions are asked fresh every sweep. That is what makes this
    /// self-healing across restarts and across a square-off that only partially fills: LastOrderId
    /// is cleared the moment Dhan's own position book shows nothing open for that contract, from
    /// WHATEVER closed it - and if a square-off order is still resting from the previous sweep,
    /// this returns without placing a second one rather than risk closing the same position twice.
    ///
    /// Dhan's Super Order has no "flatten now" order type (only entry+target+stop-loss brackets),
    /// so closing early means: cancel the resting TARGET_LEG/STOP_LOSS_LEG (best-effort - they may
    /// already be gone) so they cannot race the close, then place a brand new plain LIMIT order
    /// (DhanOrderClient, not DhanSuperOrderClient) for the opposite side and the position's own
    /// live quantity, handed off to MonitorSquareOffFillAsync for the same retry-until-filled
    /// treatment a fresh entry gets.</summary>
    private async Task SquareOffIfDueAsync(StrategyTrigger trigger, CancellationToken cancellationToken)
    {
        if (trigger.LastOrderId is not { } orderId) return;

        var entryOrder = (await _superOrders.ListAsync(cancellationToken)).FirstOrDefault(o => o.OrderId == orderId);
        if (entryOrder is null)
        {
            // No longer visible at all (a very old order Dhan has rolled off) - nothing left to
            // track for this trigger.
            _store.SetLastOrderId(trigger.Id, null);
            return;
        }

        if (!uint.TryParse(entryOrder.SecurityId, out var securityId))
        {
            _logger.LogWarning("Trigger {Name}: order {OrderId} has an unparseable security id {SecurityId} - cannot monitor it.", trigger.Name, orderId, entryOrder.SecurityId);
            return;
        }

        var position = (await _positions.ListAsync(cancellationToken)).FirstOrDefault(p => p.SecurityId == entryOrder.SecurityId);
        if (position is not { IsOpen: true })
        {
            // Already closed - its own stop-loss, its own target, an earlier square-off attempt
            // finishing since the last sweep, or a manual trade at the broker. Either way, nothing
            // left for THIS trigger to watch - tell someone if the reason is one this app actually
            // knows (see the method's own doc comment for what "known" means here).
            await NotifyPositionClosedIfKnownAsync(trigger, entryOrder, cancellationToken);
            _store.SetLastOrderId(trigger.Id, null);
            // The main leg this hedge was protecting is gone - a hedge with nothing left to hedge
            // is just an unrelated naked long nobody asked for, so it is always closed right here
            // too rather than left to ride. See CloseHedgeIfOpenAsync.
            await CloseHedgeIfOpenAsync(trigger, cancellationToken);
            return;
        }

        var squareOffMinutes = (int)trigger.Parameters.GetValueOrDefault("squareOffMinutes", 0);
        if (squareOffMinutes <= 0) return;

        var cutoff = IstClock.AtIstTime(IstClock.Today(), squareOffMinutes);
        if (DateTimeOffset.UtcNow < cutoff) return; // not due yet - leave LastOrderId as-is for a later sweep

        // How much square-off quantity is already accounted for by an order still resting from an
        // EARLIER sweep - summed, not just "is there any", because a square-off whose own quantity
        // exceeded the freeze limit is itself sliced into several closing orders (see
        // SliceQuantity). A crash or restart landing between two of THOSE slices being placed must
        // not leave the remainder unplaced forever: a plain "is anything still working" check would
        // see slice 1 resting, conclude the square-off is "being handled", and return - never
        // placing slices 2+, which were never placed at all. Comparing quantities instead means
        // only the genuine shortfall gets a fresh order; once every slice from an earlier sweep is
        // actually accounted for, this is 0 and behaves exactly like the old boolean check did.
        var prefix = SquareOffCorrelationPrefix(trigger.Id);
        var alreadyWorkingQuantity = (await _orders.ListAsync(cancellationToken))
            .Where(o => o.SecurityId == entryOrder.SecurityId && o.CorrelationId is { } id && id.StartsWith(prefix, StringComparison.Ordinal)
                && o.OrderStatus is "PENDING" or "TRANSIT" or "PART_TRADED")
            .Sum(o => o.Quantity - o.FilledQty);

        var contract = _optionChainMaster.FindBySecurityId(securityId);
        if (contract is null)
        {
            _logger.LogWarning("Trigger {Name}: security id {SecurityId} is not in the option chain master - cannot price a square-off order.", trigger.Name, securityId);
            return;
        }

        // Every tracked entry order, not just the first - a position whose entry quantity exceeded
        // the exchange freeze limit is sliced across more than one Super Order (see
        // StrategyTriggerHostedService.SliceQuantity), and every slice carries its OWN legs that
        // must stop resting before the closing order below goes out, or a slice's own stale target/
        // stop-loss could race it.
        var allEntryOrderIds = new[] { orderId }.Concat(trigger.AdditionalOrderIds).ToList();

        // Best-effort: cancelling a leg that already fired or was already removed just fails
        // harmlessly here (logged, not thrown) - the point is making sure none is still resting to
        // race the closing order below, not treating an already-gone leg as an error.
        foreach (var entryOrderId in allEntryOrderIds)
        {
            var (targetCancel, targetError) = await _superOrders.CancelAsync(entryOrderId, "TARGET_LEG", cancellationToken);
            if (targetCancel is null) _logger.LogWarning("Trigger {Name}: could not cancel TARGET_LEG for order {OrderId} before squaring off - {Error}", trigger.Name, entryOrderId, targetError ?? "no reason given");
            var (slCancel, slError) = await _superOrders.CancelAsync(entryOrderId, "STOP_LOSS_LEG", cancellationToken);
            if (slCancel is null) _logger.LogWarning("Trigger {Name}: could not cancel STOP_LOSS_LEG for order {OrderId} before squaring off - {Error}", trigger.Name, entryOrderId, slError ?? "no reason given");
        }

        var isCall = contract.IsCall;
        var closingIsSell = position.ClosesBySelling;

        // The shortfall, not the raw position size: subtract whatever an earlier sweep's slice(s)
        // are already working on covering. Zero or negative means every slice from before is
        // already accounted for and there is genuinely nothing left to place this sweep - the same
        // early-return the old boolean check gave for the ordinary, unsliced case.
        var quantity = Math.Abs(position.NetQty) - alreadyWorkingQuantity;
        if (quantity <= 0) return; // a previous sweep's square-off slice(s) already cover the whole remaining position

        var reference = await GetRepricingReferenceForSquareOffAsync(trigger.Underlying, contract.Expiry, contract.Strike, isCall, closingIsSell, cancellationToken);
        if (reference is null)
        {
            _logger.LogWarning("Trigger {Name}: no live premium for {Strike}{Type} - cannot price the square-off order this sweep, will retry next minute.",
                trigger.Name, contract.Strike, isCall ? "CE" : "PE");
            return;
        }

        var rawPrice = Math.Max(0, closingIsSell ? reference.Value - trigger.SlippagePoints : reference.Value + trigger.SlippagePoints);
        var price = RoundToTick(rawPrice, contract.TickSize);

        // The position's own net quantity can itself exceed the exchange freeze limit (it is the
        // SUM of however many entry slices filled), so the closing order needs the same slicing
        // the entry did - one plain LIMIT order per slice, each independently monitored/re-priced.
        var freezeLimit = FreezeQuantityFor(trigger.Underlying);
        var quantitySlices = SliceQuantity(quantity, contract.LotSize, freezeLimit);
        var placedOrderIds = new List<string>();

        for (var i = 0; i < quantitySlices.Count; i++)
        {
            if (i > 0) await Task.Delay(SliceCallDelay, cancellationToken);

            var correlationId = quantitySlices.Count > 1
                ? $"{prefix}{DateTimeOffset.UtcNow:yyyyMMddHHmmss}-{i + 1}"
                : $"{prefix}{DateTimeOffset.UtcNow:yyyyMMddHHmmss}";
            var sliceSummary = $"{(closingIsSell ? "SELL" : "BUY")} {contract.TradingSymbol} x{quantitySlices[i]} (SecurityId {contract.SecurityId})\nLIMIT {price:0.##} - squaring off by {IstClock.FormatMinutesOfDay(squareOffMinutes)} IST" +
                (quantitySlices.Count > 1 ? $" (slice {i + 1}/{quantitySlices.Count}, freeze limit {freezeLimit})" : "");

            var (result, error) = await _orders.PlaceAsync(
                closingIsSell ? "SELL" : "BUY", contract.DhanSegment, ProductType, "LIMIT", "DAY",
                entryOrder.SecurityId, quantitySlices[i], price, correlationId, cancellationToken);

            if (result is null)
            {
                var reason = string.IsNullOrWhiteSpace(error) ? "no reason given by Dhan" : error;
                _logger.LogError("Trigger {Name}: square-off order placement FAILED for {Summary} - {Error}", trigger.Name, sliceSummary, reason);
                var placedNote = placedOrderIds.Count > 0 ? $"\n\nNOTE: {placedOrderIds.Count}/{quantitySlices.Count} slice(s) WERE already placed (orders {string.Join(", ", placedOrderIds)}) - the position is only PARTIALLY squared off." : "";
                await NotifyFollowUpAsync(trigger, $"[SQUARE OFF FAILED] {sliceSummary}\nDhan error: {reason}\nStill open past the square-off time - will retry next minute.{placedNote}", cancellationToken);
                return; // LastOrderId stays set so the (partially closed) position keeps being checked on the next sweep
            }

            _logger.LogInformation("Trigger {Name}: square-off order placed - orderId={OrderId} status={Status} for {Summary}", trigger.Name, result.OrderId, result.OrderStatus, sliceSummary);
            await NotifyFollowUpAsync(trigger, $"[SQUARE OFF ORDER PLACED] {sliceSummary}\nDhan order {result.OrderId} ({result.OrderStatus})\nMonitoring fill (up to {MaxFillAttempts} attempts)...", cancellationToken);
            placedOrderIds.Add(result.OrderId);

            var sliceQuantity = quantitySlices[i];
            var sliceOrderId = result.OrderId;
            _ = Task.Run(async () =>
            {
                try { await MonitorSquareOffFillAsync(trigger, contract, closingIsSell, sliceQuantity, sliceOrderId, cancellationToken); }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.LogError(ex, "Trigger {Name}: square-off fill-monitoring crashed for order {OrderId}.", trigger.Name, sliceOrderId);
                    await NotifyFollowUpAsync(trigger,
                        $"[SQUARE OFF PIPELINE CRASHED] {contract.TradingSymbol} - an unexpected error stopped this square-off order from being monitored. CHECK DHAN DIRECTLY - the position may still be open or the order may still be resting.",
                        CancellationToken.None);
                }
            }, CancellationToken.None);
        }
    }

    /// <summary>Tells a person WHY a position just closed, for the two reasons this app can
    /// actually name with certainty by reading the entry Super Order's own legs: TARGET_LEG TRADED
    /// means the target hit, STOP_LOSS_LEG TRADED means the stop-loss hit. Neither leg TRADED means
    /// it closed some OTHER way - this app's own square-off order (which already sent its own
    /// [SQUARED OFF] message via MonitorSquareOffFillAsync the moment IT confirmed flat, so saying
    /// anything more here would just double up), a manual trade at the broker, or anything else
    /// this service has no way to describe - and stays silent rather than guess.</summary>
    private async Task NotifyPositionClosedIfKnownAsync(StrategyTrigger trigger, SuperOrderSummary entryOrder, CancellationToken cancellationToken)
    {
        var targetStatus = entryOrder.LegDetails.FirstOrDefault(l => l.LegName == "TARGET_LEG")?.OrderStatus;
        var stopLossStatus = entryOrder.LegDetails.FirstOrDefault(l => l.LegName == "STOP_LOSS_LEG")?.OrderStatus;

        if (string.Equals(stopLossStatus, "TRADED", StringComparison.OrdinalIgnoreCase))
        {
            _logger.LogInformation("Trigger {Name}: order {OrderId} closed via its stop-loss.", trigger.Name, entryOrder.OrderId);
            await NotifyFollowUpAsync(trigger, $"[STOP LOSS HIT] Dhan order {entryOrder.OrderId} ({entryOrder.SecurityId})\nThe position closed via its stop-loss.", cancellationToken);
        }
        else if (string.Equals(targetStatus, "TRADED", StringComparison.OrdinalIgnoreCase))
        {
            _logger.LogInformation("Trigger {Name}: order {OrderId} closed via its target.", trigger.Name, entryOrder.OrderId);
            await NotifyFollowUpAsync(trigger, $"[TARGET HIT] Dhan order {entryOrder.OrderId} ({entryOrder.SecurityId})\nThe position closed via its target.", cancellationToken);
        }
    }

    /// <summary>MonitorFillAsync's own retry-until-filled loop, adapted for a plain square-off
    /// order rather than a Super Order's ENTRY_LEG: same MaxFillAttempts x FillCheckInterval
    /// cadence and the same escalating-slippage re-price, but with no "signal price" to bound a
    /// MaxDeviationPercent check against (a square-off is not chasing a specific reference price,
    /// it is trying to get flat as soon as possible) and no cancel-on-timeout (an unfilled or
    /// partially-filled square-off is left resting - a working marketable LIMIT order is still the
    /// best available outcome for "still needs to close", and the next sweep's already-working
    /// check leaves it be rather than stacking a second one on top).
    ///
    /// Clears StrategyTrigger.LastOrderId the moment the position is confirmed flat - checked
    /// directly against DhanPositionsClient rather than assumed from the order's own fill status,
    /// same ground-truth preference as everywhere else in this pipeline.</summary>
    private async Task MonitorSquareOffFillAsync(StrategyTrigger trigger, DhanOptionInstrument contract, bool isSell, int quantity, string orderId, CancellationToken cancellationToken)
    {
        for (var attempt = 1; attempt <= MaxFillAttempts; attempt++)
        {
            try
            {
                await Task.Delay(FillCheckInterval, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                _logger.LogWarning("Trigger {Name}: shutting down while square-off order {OrderId} was still being monitored - leaving it as-is.", trigger.Name, orderId);
                await NotifyFollowUpAsync(trigger,
                    $"[SQUARE OFF UNMONITORED] {contract.TradingSymbol}\nDhan order {orderId}\nThe app is shutting down before this order resolved - it is left exactly as it was. CHECK DHAN DIRECTLY.",
                    CancellationToken.None);
                return;
            }

            var order = (await _orders.ListAsync(cancellationToken)).FirstOrDefault(o => o.OrderId == orderId);
            if (order is null)
            {
                _logger.LogWarning("Trigger {Name}: square-off order {OrderId} not visible on attempt {Attempt}/{Max} - will check again.", trigger.Name, orderId, attempt, MaxFillAttempts);
                continue;
            }

            if (string.Equals(order.OrderStatus, "TRADED", StringComparison.OrdinalIgnoreCase))
            {
                _logger.LogInformation("Trigger {Name}: square-off order {OrderId} filled on attempt {Attempt}/{Max}.", trigger.Name, orderId, attempt, MaxFillAttempts);
                await NotifyFollowUpAsync(trigger, $"[SQUARED OFF] {contract.TradingSymbol}\nFilled {order.FilledQty}/{order.Quantity} at ~{order.Price:0.##} on attempt {attempt}/{MaxFillAttempts}.", cancellationToken);

                // THIS slice filled, but a square-off whose quantity exceeded the freeze limit is
                // sliced into several closing orders (see SquareOffIfDueAsync), each monitored here
                // independently - so this order's own TRADED status is not proof the position as a
                // WHOLE is flat, only that this one slice is. Ground truth is Dhan's own position
                // book, checked fresh: only once THAT shows nothing open for this contract is it
                // safe to stop tracking the entry and cascade into closing the hedge. Clearing (or
                // cascading) on a single slice's fill while siblings are still resting would drop
                // LastOrderId/AdditionalOrderIds while a real, still-open remainder of the position
                // is left with nothing watching it, and would close the hedge while part of what it
                // protects is still open.
                var remainingPosition = (await _positions.ListAsync(cancellationToken)).FirstOrDefault(p => p.SecurityId == order.SecurityId);
                if (remainingPosition is { IsOpen: true })
                {
                    _logger.LogInformation("Trigger {Name}: square-off slice {OrderId} filled, but the position for {Symbol} is still open (netQty {NetQty}) - other slice(s) must still be resting. Leaving LastOrderId set for the next sweep.",
                        trigger.Name, orderId, contract.TradingSymbol, remainingPosition.NetQty);
                    return;
                }

                _store.SetLastOrderId(trigger.Id, null);
                // Same reasoning as SquareOffIfDueAsync's own natural-closure branch: the main leg
                // is confirmed flat, so anything hedging it is closed right along with it.
                await CloseHedgeIfOpenAsync(trigger, cancellationToken);
                return;
            }

            if (order.OrderStatus is "CANCELLED" or "REJECTED")
            {
                var reasonLine = string.IsNullOrWhiteSpace(order.OmsErrorDescription) ? "" : $"\nReason: {order.OmsErrorDescription}";
                _logger.LogWarning("Trigger {Name}: square-off order {OrderId} is {Status} - the position may still be open. CHECK DHAN DIRECTLY.", trigger.Name, orderId, order.OrderStatus);
                await NotifyFollowUpAsync(trigger, $"[SQUARE OFF {order.OrderStatus}] {contract.TradingSymbol}{reasonLine}\nThe position may still be open - the next sweep will retry if so.", cancellationToken);
                return; // LastOrderId deliberately left set: the next sweep re-checks the real position and tries again if it is still open
            }

            if (attempt == MaxFillAttempts)
            {
                _logger.LogWarning("Trigger {Name}: square-off order {OrderId} still {Status} ({Filled}/{Total}) after {Max} attempts - leaving it resting.",
                    trigger.Name, orderId, order.OrderStatus, order.FilledQty, order.Quantity, MaxFillAttempts);
                await NotifyFollowUpAsync(trigger,
                    $"[SQUARE OFF PARTIALLY FILLED] {contract.TradingSymbol}\nFilled {order.FilledQty}/{order.Quantity} after {MaxFillAttempts} attempts. The remainder is left resting - check Dhan if you want to close it manually.",
                    cancellationToken);
                return;
            }

            var latestPrice = await GetRepricingReferenceForSquareOffAsync(trigger.Underlying, contract.Expiry, contract.Strike, contract.IsCall, isSell, cancellationToken);
            if (latestPrice is null)
            {
                _logger.LogWarning("Trigger {Name}: no live premium available for {Strike}{Type} - cannot re-price square-off order {OrderId} on attempt {Attempt}/{Max}.",
                    trigger.Name, contract.Strike, contract.IsCall ? "CE" : "PE", orderId, attempt, MaxFillAttempts);
                continue;
            }

            var remaining = quantity - order.FilledQty;
            var slippage = trigger.SlippagePoints * UnfilledRetrySlippageMultiplier;
            var rawPrice = Math.Max(0, isSell ? latestPrice.Value - slippage : latestPrice.Value + slippage);
            var newPrice = RoundToTick(rawPrice, contract.TickSize);

            var (modifyResult, modifyError) = await _orders.ModifyAsync(orderId, "LIMIT", "DAY", remaining, newPrice, cancellationToken);
            if (modifyResult is null)
            {
                _logger.LogWarning("Trigger {Name}: re-price MODIFY failed for square-off order {OrderId} on attempt {Attempt}/{Max} - {Error} - will check again.",
                    trigger.Name, orderId, attempt, MaxFillAttempts, string.IsNullOrWhiteSpace(modifyError) ? "no reason given by Dhan" : modifyError);
                continue;
            }

            _logger.LogInformation("Trigger {Name}: re-priced square-off order {OrderId} to {Price:0.##} for {Quantity} (attempt {Attempt}/{Max}, live premium {Live:0.##}).",
                trigger.Name, orderId, newPrice, remaining, attempt + 1, MaxFillAttempts, latestPrice);
        }
    }

    /// <summary>The correlationId prefix a hedge-closing order carries - HedgeCloseCorrelationPrefix's
    /// own counterpart to SquareOffCorrelationPrefix, so CloseHedgeIfOpenAsync can tell "is a hedge
    /// close already working" apart from every other correlationId scheme this file uses.</summary>
    private static string HedgeCloseCorrelationPrefix(string triggerId) => $"{triggerId}-hedgeclose-";

    /// <summary>Closes StrategyTrigger.LastHedgeOrderId's own position - a plain SELL to close the
    /// protective BUY (see StrategyTrigger.HedgeOtmSteps) - the moment the main leg it was
    /// protecting is confirmed no longer open. Called from both places that ever clear LastOrderId:
    /// SquareOffIfDueAsync's own "already closed" branch (the main leg hit its own stop-loss/target/
    /// a manual trade), and MonitorSquareOffFillAsync once ITS square-off order confirms flat (the
    /// main leg was closed early on a schedule). A hedge with nothing left protecting it is not
    /// "still hedging" anything - keeping it open past that point would just be an unrelated naked
    /// long nobody asked for, so it is always closed here rather than left to ride.
    ///
    /// Ground truth throughout, same preference as everywhere else in this pipeline: LastHedgeOrderId
    /// only says which plain order this trigger is watching, never assumed still open - the order
    /// and position books are asked fresh every call. A no-op (and self-healing) when there is
    /// nothing to close: no LastHedgeOrderId, the order itself no longer visible, the position
    /// already flat, or a previous sweep's close order still working.</summary>
    private async Task CloseHedgeIfOpenAsync(StrategyTrigger trigger, CancellationToken cancellationToken)
    {
        if (trigger.LastHedgeOrderId is not { } hedgeOrderId) return;

        var hedgeOrder = (await _orders.ListAsync(cancellationToken)).FirstOrDefault(o => o.OrderId == hedgeOrderId);
        if (hedgeOrder is null)
        {
            // No longer visible at all (a very old order Dhan has rolled off) - nothing left to
            // track for this hedge.
            _store.SetLastHedgeOrderId(trigger.Id, null);
            return;
        }

        var hedgePosition = (await _positions.ListAsync(cancellationToken)).FirstOrDefault(p => p.SecurityId == hedgeOrder.SecurityId);
        if (hedgePosition is not { IsOpen: true })
        {
            // Already closed - a previous close attempt finishing since the last sweep, or a
            // manual trade at the broker. Nothing left for this trigger to watch.
            _store.SetLastHedgeOrderId(trigger.Id, null);
            return;
        }

        if (!uint.TryParse(hedgeOrder.SecurityId, out var securityId))
        {
            _logger.LogWarning("Trigger {Name}: hedge order {OrderId} has an unparseable security id {SecurityId} - cannot close it automatically. CHECK DHAN DIRECTLY.",
                trigger.Name, hedgeOrderId, hedgeOrder.SecurityId);
            return;
        }

        var contract = _optionChainMaster.FindBySecurityId(securityId);
        if (contract is null)
        {
            _logger.LogWarning("Trigger {Name}: hedge security id {SecurityId} is not in the option chain master - cannot price closing it. CHECK DHAN DIRECTLY.", trigger.Name, securityId);
            return;
        }

        // Same shortfall reasoning as SquareOffIfDueAsync's own identical check: a hedge close whose
        // quantity exceeded the freeze limit is itself sliced into several orders, and a crash or
        // restart between two of those slices must not leave the remainder unplaced forever - a
        // plain "is anything still working" boolean would see one resting slice and conclude the
        // close is "being handled", never placing the slices that were never placed at all.
        var prefix = HedgeCloseCorrelationPrefix(trigger.Id);
        var alreadyWorkingQuantity = (await _orders.ListAsync(cancellationToken))
            .Where(o => o.SecurityId == hedgeOrder.SecurityId && o.CorrelationId is { } id && id.StartsWith(prefix, StringComparison.Ordinal)
                && o.OrderStatus is "PENDING" or "TRANSIT" or "PART_TRADED")
            .Sum(o => o.Quantity - o.FilledQty);

        var quantity = Math.Abs(hedgePosition.NetQty) - alreadyWorkingQuantity;
        if (quantity <= 0) return; // a previous sweep's hedge-close slice(s) already cover the whole remaining hedge position
        var reference = await GetRepricingReferenceForSquareOffAsync(trigger.Underlying, contract.Expiry, contract.Strike, contract.IsCall, isSell: true, cancellationToken);
        if (reference is null)
        {
            _logger.LogWarning("Trigger {Name}: no live premium for hedge leg {Strike}{Type} - cannot close it this sweep, will retry next minute.",
                trigger.Name, contract.Strike, contract.IsCall ? "CE" : "PE");
            return;
        }

        var rawPrice = Math.Max(0, reference.Value - trigger.SlippagePoints);
        var price = RoundToTick(rawPrice, contract.TickSize);

        // The hedge position's own net quantity is the SUM of however many opening slices filled
        // (see PlaceOrderAsync), so it can itself exceed the exchange freeze limit even when each
        // opening slice individually did not - the closing order needs the same slicing.
        var freezeLimit = FreezeQuantityFor(trigger.Underlying);
        var quantitySlices = SliceQuantity(quantity, contract.LotSize, freezeLimit);
        var placedOrderIds = new List<string>();

        for (var i = 0; i < quantitySlices.Count; i++)
        {
            if (i > 0) await Task.Delay(SliceCallDelay, cancellationToken);

            var correlationId = quantitySlices.Count > 1
                ? $"{prefix}{DateTimeOffset.UtcNow:yyyyMMddHHmmss}-{i + 1}"
                : $"{prefix}{DateTimeOffset.UtcNow:yyyyMMddHHmmss}";
            var sliceSummary = $"SELL {contract.TradingSymbol} x{quantitySlices[i]} (SecurityId {contract.SecurityId})\nLIMIT {price:0.##} - closing the protective hedge now that the main leg is no longer open" +
                (quantitySlices.Count > 1 ? $" (slice {i + 1}/{quantitySlices.Count}, freeze limit {freezeLimit})" : "");

            var (result, error) = await _orders.PlaceAsync("SELL", contract.DhanSegment, ProductType, "LIMIT", "DAY", hedgeOrder.SecurityId, quantitySlices[i], price, correlationId, cancellationToken);

            if (result is null)
            {
                var reason = string.IsNullOrWhiteSpace(error) ? "no reason given by Dhan" : error;
                _logger.LogError("Trigger {Name}: hedge close order placement FAILED for {Summary} - {Error}", trigger.Name, sliceSummary, reason);
                var placedNote = placedOrderIds.Count > 0 ? $"\n\nNOTE: {placedOrderIds.Count}/{quantitySlices.Count} slice(s) WERE already placed (orders {string.Join(", ", placedOrderIds)}) - the hedge is only PARTIALLY closed." : "";
                await NotifyFollowUpAsync(trigger, $"[HEDGE CLOSE FAILED] {sliceSummary}\nDhan error: {reason}\nThe hedge is still (partially) open - will retry next minute.{placedNote}", cancellationToken);
                return; // LastHedgeOrderId stays set so the (partially closed) hedge keeps being checked on the next sweep
            }

            _logger.LogInformation("Trigger {Name}: hedge close order placed - orderId={OrderId} status={Status} for {Summary}", trigger.Name, result.OrderId, result.OrderStatus, sliceSummary);
            await NotifyFollowUpAsync(trigger, $"[HEDGE CLOSE ORDER PLACED] {sliceSummary}\nDhan order {result.OrderId} ({result.OrderStatus})\nMonitoring fill (up to {MaxFillAttempts} attempts)...", cancellationToken);
            placedOrderIds.Add(result.OrderId);

            var sliceQuantity = quantitySlices[i];
            var sliceOrderId = result.OrderId;
            _ = Task.Run(async () =>
            {
                try { await MonitorHedgeCloseFillAsync(trigger, contract, sliceQuantity, sliceOrderId, cancellationToken); }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.LogError(ex, "Trigger {Name}: hedge-close fill-monitoring crashed for order {OrderId}.", trigger.Name, sliceOrderId);
                    await NotifyFollowUpAsync(trigger,
                        $"[HEDGE CLOSE PIPELINE CRASHED] {contract.TradingSymbol} - an unexpected error stopped this hedge-close order from being monitored. CHECK DHAN DIRECTLY - the hedge may still be open or the order may still be resting.",
                        CancellationToken.None);
                }
            }, CancellationToken.None);
        }
    }

    /// <summary>MonitorSquareOffFillAsync's own retry-until-filled loop, adapted for closing a
    /// PROTECTIVE hedge leg instead of the main position: same MaxFillAttempts x FillCheckInterval
    /// cadence and the same escalating-slippage re-price, always selling (a hedge is only ever a
    /// BUY to open, so closing it is only ever a SELL - no isSell parameter needed here unlike
    /// MonitorSquareOffFillAsync, which closes either side depending on the main position it
    /// found). Clears StrategyTrigger.LastHedgeOrderId the moment the hedge position is confirmed
    /// flat, checked directly against DhanPositionsClient - same ground-truth preference as
    /// everywhere else in this pipeline.</summary>
    private async Task MonitorHedgeCloseFillAsync(StrategyTrigger trigger, DhanOptionInstrument contract, int quantity, string orderId, CancellationToken cancellationToken)
    {
        for (var attempt = 1; attempt <= MaxFillAttempts; attempt++)
        {
            try
            {
                await Task.Delay(FillCheckInterval, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                _logger.LogWarning("Trigger {Name}: shutting down while hedge close order {OrderId} was still being monitored - leaving it as-is.", trigger.Name, orderId);
                await NotifyFollowUpAsync(trigger,
                    $"[HEDGE CLOSE UNMONITORED] {contract.TradingSymbol}\nDhan order {orderId}\nThe app is shutting down before this order resolved - it is left exactly as it was. CHECK DHAN DIRECTLY.",
                    CancellationToken.None);
                return;
            }

            var order = (await _orders.ListAsync(cancellationToken)).FirstOrDefault(o => o.OrderId == orderId);
            if (order is null)
            {
                _logger.LogWarning("Trigger {Name}: hedge close order {OrderId} not visible on attempt {Attempt}/{Max} - will check again.", trigger.Name, orderId, attempt, MaxFillAttempts);
                continue;
            }

            if (string.Equals(order.OrderStatus, "TRADED", StringComparison.OrdinalIgnoreCase))
            {
                _logger.LogInformation("Trigger {Name}: hedge close order {OrderId} filled on attempt {Attempt}/{Max}.", trigger.Name, orderId, attempt, MaxFillAttempts);
                await NotifyFollowUpAsync(trigger, $"[HEDGE CLOSED] {contract.TradingSymbol}\nFilled {order.FilledQty}/{order.Quantity} at ~{order.Price:0.##} on attempt {attempt}/{MaxFillAttempts}.", cancellationToken);

                // Same ground-truth requirement as MonitorSquareOffFillAsync's own identical check:
                // a hedge close whose quantity exceeded the freeze limit is sliced into several
                // orders, each monitored independently here, so THIS order's own TRADED status is
                // not proof the hedge as a WHOLE is flat - only Dhan's own position book is.
                // Clearing on one slice's fill while a sibling is still resting would drop
                // LastHedgeOrderId/AdditionalHedgeOrderIds while real hedge quantity is still open
                // with nothing watching it.
                var remainingHedgePosition = (await _positions.ListAsync(cancellationToken)).FirstOrDefault(p => p.SecurityId == order.SecurityId);
                if (remainingHedgePosition is { IsOpen: true })
                {
                    _logger.LogInformation("Trigger {Name}: hedge close slice {OrderId} filled, but the hedge position for {Symbol} is still open (netQty {NetQty}) - other slice(s) must still be resting. Leaving LastHedgeOrderId set for the next sweep.",
                        trigger.Name, orderId, contract.TradingSymbol, remainingHedgePosition.NetQty);
                    return;
                }

                _store.SetLastHedgeOrderId(trigger.Id, null);
                return;
            }

            if (order.OrderStatus is "CANCELLED" or "REJECTED")
            {
                var reasonLine = string.IsNullOrWhiteSpace(order.OmsErrorDescription) ? "" : $"\nReason: {order.OmsErrorDescription}";
                _logger.LogWarning("Trigger {Name}: hedge close order {OrderId} is {Status} - the hedge may still be open. CHECK DHAN DIRECTLY.", trigger.Name, orderId, order.OrderStatus);
                await NotifyFollowUpAsync(trigger, $"[HEDGE CLOSE {order.OrderStatus}] {contract.TradingSymbol}{reasonLine}\nThe hedge may still be open - the next sweep will retry if so.", cancellationToken);
                return; // LastHedgeOrderId deliberately left set: the next sweep re-checks the real position and tries again if it is still open
            }

            if (attempt == MaxFillAttempts)
            {
                _logger.LogWarning("Trigger {Name}: hedge close order {OrderId} still {Status} ({Filled}/{Total}) after {Max} attempts - leaving it resting.",
                    trigger.Name, orderId, order.OrderStatus, order.FilledQty, order.Quantity, MaxFillAttempts);
                await NotifyFollowUpAsync(trigger,
                    $"[HEDGE PARTIALLY CLOSED] {contract.TradingSymbol}\nFilled {order.FilledQty}/{order.Quantity} after {MaxFillAttempts} attempts. The remainder is left resting - check Dhan if you want to close it manually.",
                    cancellationToken);
                return;
            }

            var latestPrice = await GetRepricingReferenceForSquareOffAsync(trigger.Underlying, contract.Expiry, contract.Strike, contract.IsCall, isSell: true, cancellationToken);
            if (latestPrice is null)
            {
                _logger.LogWarning("Trigger {Name}: no live premium available for hedge {Strike}{Type} - cannot re-price hedge close order {OrderId} on attempt {Attempt}/{Max}.",
                    trigger.Name, contract.Strike, contract.IsCall ? "CE" : "PE", orderId, attempt, MaxFillAttempts);
                continue;
            }

            var remaining = quantity - order.FilledQty;
            var slippage = trigger.SlippagePoints * UnfilledRetrySlippageMultiplier;
            var rawPrice = Math.Max(0, latestPrice.Value - slippage);
            var newPrice = RoundToTick(rawPrice, contract.TickSize);

            var (modifyResult, modifyError) = await _orders.ModifyAsync(orderId, "LIMIT", "DAY", remaining, newPrice, cancellationToken);
            if (modifyResult is null)
            {
                _logger.LogWarning("Trigger {Name}: re-price MODIFY failed for hedge close order {OrderId} on attempt {Attempt}/{Max} - {Error} - will check again.",
                    trigger.Name, orderId, attempt, MaxFillAttempts, string.IsNullOrWhiteSpace(modifyError) ? "no reason given by Dhan" : modifyError);
                continue;
            }

            _logger.LogInformation("Trigger {Name}: re-priced hedge close order {OrderId} to {Price:0.##} for {Quantity} (attempt {Attempt}/{Max}, live premium {Live:0.##}).",
                trigger.Name, orderId, newPrice, remaining, attempt + 1, MaxFillAttempts, latestPrice);
        }
    }

    /// <summary>GetRepricingReferenceAsync's own logic (live bid/ask first, last-traded-price
    /// fallback), just addressed by contract fields directly rather than through a SuperOrderPlan
    /// - a square-off has no BacktestTrade/SuperOrderPlan behind it, only the contract it is
    /// closing.</summary>
    private async Task<decimal?> GetRepricingReferenceForSquareOffAsync(string underlying, DateOnly expiry, decimal strike, bool isCall, bool isSell, CancellationToken cancellationToken)
    {
        var contract = _optionChainMaster.Find(underlying, expiry, strike, isCall);
        if (contract is not null && _feedClient.LastTickFor(contract.SecurityId) is { } tick)
        {
            var sideDepth = isSell ? tick.BestBidPrice : tick.BestAskPrice;
            if (sideDepth > 0) return sideDepth;
        }

        return await GetOrderPremiumAsync(underlying, expiry, expiry, strike, isCall, cancellationToken);
    }

    private async Task NotifyAsync(StrategyTrigger trigger, BacktestTrade trade, string? reason, CancellationToken cancellationToken)
    {
        var arrow = trade.Direction == "Bullish" ? "▲" : "▼";
        var reasonLine = reason is null ? "" : $"\n{reason}";
        var ist = IstClock.Offset;

        // Fired and left running BEFORE the alert below is even composed, let alone sent - see
        // PlaceOrderInBackgroundAsync's own doc comment for why. The order no longer waits its turn
        // behind the alert (or the alert behind the order): both start at essentially the same
        // instant. The order's own outcome still always reaches Telegram, just as its own follow-up
        // message a moment later rather than embedded in this one - the "never place or leave an
        // order unsaid" guarantee is unchanged, only WHEN relative to the signal alert it lands.
        if (trigger.LiveTradingEnabled)
            _ = PlaceOrderInBackgroundAsync(trigger, trade, cancellationToken);

        // Entry time/price here are exactly BacktestTrade.EntryTimeUtc/EntryPrice - the same fields
        // the Backtrack trade table's own "Entry" column renders. The signal is WHEN the strategy
        // decided to act; the entry is WHAT you would actually have punched into the order - the
        // signal bar's own close, which is why the two are usually the same instant now.
        //
        // [Trigger] up front for the same reason EmaCrossoverAlertService/ConfluenceAlertService
        // tag their own messages - this is the confirmed, strategy-driven alert, distinct from the
        // raw always-on EMA/Confluence feed that shares the same Telegram chat.
        // In live-premium mode there IS no resolved entry bar yet - that wait is exactly what the
        // mode removes - so the line reports the live premium as of the signal bar's close instead,
        // read straight from CDV's own tracked state (no network call, so this never waits on the
        // order pipeline above). Dereferencing EntryTimeUtc unconditionally here would be a null
        // reference the moment that mode is switched on. A trigger pinned to a different expiry
        // reports the exact contract/price the order used in ITS OWN follow-up message instead
        // (see BuildOrderPlanAsync) - deliberately not duplicated here, since re-deriving it would
        // either block this alert on the same lookup or risk the two messages disagreeing.
        var entryLine = trade.EntryTimeUtc is { } entryTime
            ? $"Entry: {entryTime.ToOffset(ist):HH:mm} IST @ {trade.EntryPrice:0.##}"
            : $"Entry: live premium @ {GetLatestPremium(trade.Underlying, trade.Strike, trade.OptionType == "CE"):0.##} (as of the signal bar's close)";

        var message =
            $"[Trigger] <b>{arrow} {trigger.Name}</b>\n" +
            $"<b>{trade.Underlying}</b> · {trigger.TimeframeMinutes}m · {trigger.StrategyKey}\n" +
            $"<b>{trade.Direction}</b> — {trade.Side} {trade.OptionType} {trade.Strike:0.##}{reasonLine}\n" +
            $"{entryLine}\n" +
            $"Signal bar: {trade.SignalTimeUtc.ToOffset(ist):yyyy-MM-dd HH:mm} IST" +
            (trigger.LiveTradingEnabled ? "\n\nLive trading is on - order status follows separately." : "");

        _logger.LogInformation("Trigger {Name} fired: {Direction} {Side} {OptionType} {Strike}", trigger.Name, trade.Direction, trade.Side, trade.OptionType, trade.Strike);

        await _telegram.SendAsync(message, cancellationToken);

        // Also push it to any open dashboard, reusing the alert feed the page already renders.
        try
        {
            var alert = new ConfluenceAlert(trade.Underlying, DateTimeOffset.UtcNow, "Confluence", trade.Direction, 0, null, message);
            // Deliberately Clients.All - see ConfluenceAlertService's own identical broadcast for why
            // this event specifically stays unscoped (the Dashboard's Alerts panel shows every
            // underlying at once, not just whichever one is currently charted).
            await _hub.Clients.All.SendAsync("confluenceAlert", alert, cancellationToken);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Could not broadcast trigger {Name} to the dashboard.", trigger.Name);
        }
    }

    /// <summary>Builds and places the real order for one fired signal, entirely off to the side of
    /// NotifyAsync's own signal alert - see that method's doc comment for why. Runs as its own
    /// background task (CancellationToken.None on the enclosing Task.Run, same reasoning
    /// PlaceOrderAsync's own MonitorFillAsync dispatch uses: a shutdown mid-flight must not silently
    /// drop whatever this was about to report, only the individual awaited calls inside still honour
    /// <paramref name="cancellationToken"/>), so a slow contract lookup or a slow Dhan round trip
    /// never delays the Telegram message that a signal fired.
    ///
    /// Every outcome still reaches Telegram, exactly as it always did - just as its own follow-up
    /// message via NotifyFollowUpAsync (the same mechanism FILLED/CANCELLED/etc. already use)
    /// instead of a line appended to the signal alert:
    ///   - BuildOrderPlanAsync returning null -> [NO ORDER PLACED] with the reason.
    ///   - Telegram not configured while a real order is about to be placed -> a loud log line,
    ///     since the follow-up send below will simply no-op.
    ///   - PlaceOrderAsync's own [ORDER PLACED]/[ORDER FAILED] line, sent as-is.
    ///   - Anything unexpected throwing -> [ORDER PIPELINE CRASHED], logged, and CHECK DHAN
    ///     DIRECTLY - the one case that must never be silent even when the code itself misbehaves.
    /// </summary>
    private Task PlaceOrderInBackgroundAsync(StrategyTrigger trigger, BacktestTrade trade, CancellationToken cancellationToken)
    {
        return Task.Run(async () =>
        {
            try
            {
                var (plan, hedge, skipReason) = await BuildOrderPlanAsync(trigger, trade, cancellationToken);
                if (plan is null)
                {
                    // A null SkipReason means AdjustStopLossForOpenPositionAsync already sent its
                    // own, more specific Telegram message (or the update failed and it reported
                    // that too) - nothing more to say here.
                    if (skipReason is not null)
                    {
                        await NotifyFollowUpAsync(trigger,
                            $"[NO ORDER PLACED] Live trading is on, but this signal could not be turned into an order - {skipReason}. Nothing is working at the broker for it.",
                            cancellationToken);
                    }
                    return;
                }

                if (!_telegram.IsConfigured)
                {
                    _logger.LogWarning(
                        "Trigger {Name}: a REAL order was placed but Telegram is not configured (Telegram:Enabled/BotToken/ChatId) - no notification will be sent for it or for its fill.",
                        trigger.Name);
                }

                var statusLine = await PlaceOrderAsync(trigger, trade, plan, hedge, cancellationToken);
                await NotifyFollowUpAsync(trigger, statusLine, cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "Trigger {Name}: order placement crashed for a fired signal ({Underlying} {Strike}{Type}).",
                    trigger.Name, trade.Underlying, trade.Strike, trade.OptionType);
                await NotifyFollowUpAsync(trigger,
                    $"[ORDER PIPELINE CRASHED] {trade.Underlying} {trade.Strike:0.##}{trade.OptionType} - an unexpected error stopped this signal's order from being built or placed. Check server logs, and CHECK DHAN DIRECTLY in case an order reached the broker before the crash.",
                    CancellationToken.None);
            }
        }, CancellationToken.None);
    }

    /// <summary>Turns a fired trade into the exact Dhan Super Order it should place. Null when the
    /// contract can't be resolved (no expiry currently tracked for this underlying, or that exact
    /// strike/side isn't in the scrip master), which is logged and simply skips placement rather
    /// than failing the whole notification - the Telegram/dashboard alert for the signal itself
    /// still goes out either way.
    ///
    /// The conversions from what OptionTradeSimulator already computed to what Dhan's API wants:
    ///   - Contract: StrategyTrigger.OrderExpiry when the trigger pins one, otherwise
    ///     CdvHostedService's CURRENTLY tracked expiry for this underlying (CdvUnderlyingState.Expiry
    ///     - whatever the dashboard/Backtrack expiry selector has it on right now), plus the trade's
    ///     own strike/side. Never the expiry that happened to be nearest when some earlier signal
    ///     fired, since a live order has to name a real, currently-listed contract.
    ///   - A pinned expiry that is NOT the tracked one is priced off that contract's own live
    ///     Option Chain quote, regardless of UseLivePremiumEntry: the simulator's entry price is a
    ///     different contract's number and would build the order around a premium this one never
    ///     traded at. No quote means no order, rather than an order at the wrong price.
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
    private async Task<(SuperOrderPlan? Plan, HedgePlan? Hedge, string? SkipReason)> BuildOrderPlanAsync(StrategyTrigger trigger, BacktestTrade trade, CancellationToken cancellationToken)
    {
        var isCall = trade.OptionType == "CE";

        // Which expiry this order goes in: the trigger's own pinned one if it has one, otherwise
        // whatever is being tracked (see StrategyTrigger.OrderExpiry).
        var trackedExpiry = _cdv.StateFor(trade.Underlying, trigger.OrderExpiry)?.Expiry
            ?? (_cdv.States.TryGetValue(trade.Underlying, out var cdvState) ? cdvState.Expiry : null);
        var expiry = trigger.OrderExpiry ?? trackedExpiry;
        if (expiry is null)
        {
            _logger.LogWarning("Trigger {Name}: no currently-tracked expiry for {Underlying} - cannot place order.", trigger.Name, trade.Underlying);
            return (null, null, $"no expiry is currently tracked for {trade.Underlying}");
        }

        // Belt and braces alongside the DhanOptionChainMaster singleton fix: this service never
        // otherwise calls EnsureLoadedAsync itself, so it was passively relying on CdvHostedService's
        // OWN background loop to keep the (now shared) instance warm. That is fine in steady state,
        // but for roughly the first minute after ANY restart - before CdvHostedService's own
        // StartupDelay elapses and its first RecenterAsync runs - the shared master genuinely has
        // nothing loaded yet, and a signal firing in that narrow window would still see "0 contracts"
        // even with the DI fix. EnsureLoadedAsync is a no-op once fresh (IsFresh), so this costs
        // nothing on every other call - it only matters the one time it is actually still empty.
        await _optionChainMaster.EnsureLoadedAsync(cancellationToken);

        var contract = _optionChainMaster.Find(trade.Underlying, expiry.Value, trade.Strike, isCall);
        if (contract is null)
        {
            // "Not listed" is the one skip reason that is usually a symptom rather than a fact -
            // a stale scrip master, or a row the parser dropped - so it logs what IS listed nearby.
            var nearby = _optionChainMaster.DescribeNearestListed(trade.Underlying, expiry.Value, trade.Strike, isCall);
            _logger.LogWarning("Trigger {Name}: {Underlying} {Strike}{Type} not found on expiry {Expiry} - cannot place order. {Nearby}",
                trigger.Name, trade.Underlying, trade.Strike, trade.OptionType, expiry.Value, nearby);
            return (null, null, $"{trade.Strike:0.##}{trade.OptionType} is not listed on the {expiry.Value:dd MMM yyyy} expiry ({nearby})");
        }

        // A pinned expiry that isn't the tracked one is a DIFFERENT contract from the one the
        // strategy simulated, so the simulator's entry price cannot price it - that number belongs
        // to the near month. Such an order is always priced off its own contract's live quote,
        // whatever UseLivePremiumEntry says.
        // "Foreign" now means NOT TRACKED, rather than "not the selected one": a pinned expiry the
        // app subscribes to has real premium candles behind it and prices exactly like the selected
        // one. Only an untracked expiry needs the rate-limited Option Chain snapshot.
        var isForeignExpiry = _cdv.StateFor(trade.Underlying, expiry) is null;

        // The entry reference every other price here is derived from. Normally the simulator's own
        // resolved fill (the signal bar's own close), so a live order is built from exactly the
        // number the backtest measured. With UseLivePremiumEntry it is instead what the strike is
        // trading at RIGHT NOW - see that property's doc comment for the trade-off.
        decimal entryPrice;
        if (trigger.UseLivePremiumEntry || isForeignExpiry)
        {
            var live = await GetOrderPremiumAsync(trade.Underlying, expiry.Value, trackedExpiry, trade.Strike, isCall, cancellationToken);
            if (live is not { } livePremium || livePremium <= 0)
            {
                _logger.LogWarning("Trigger {Name}: no live premium for {Underlying} {Strike}{Type} on expiry {Expiry} - cannot price the order.",
                    trigger.Name, trade.Underlying, trade.Strike, trade.OptionType, expiry.Value);
                return (null, null, $"no live premium available for {trade.Strike:0.##}{trade.OptionType} on the {expiry.Value:dd MMM yyyy} expiry");
            }
            entryPrice = livePremium;
        }
        else if (trade.EntryPrice is { } resolved)
        {
            entryPrice = resolved;
        }
        else
        {
            // Shouldn't happen - EvaluateAsync only reaches here with a resolved entry unless
            // live-premium mode is on - but it is still reported rather than swallowed.
            return (null, null, "the trade has no resolved entry price yet");
        }

        var isSell = trade.Side == "Sell";
        var slPoints = trigger.Parameters.GetValueOrDefault("slPoints", 10);
        var tpPoints = trigger.Parameters.GetValueOrDefault("tpPoints", 20);

        // Same mirror-for-a-seller formula as OptionTradeSimulator.Run.
        var rawStopLoss = isSell ? entryPrice + slPoints : Math.Max(0, entryPrice - slPoints);
        var rawTarget = isSell ? Math.Max(0, entryPrice - tpPoints) : entryPrice + tpPoints;

        // The LIMIT price itself is priced off the contract's live best bid/ask (SELL off the
        // bid, BUY off the ask) when the Full-mode feed already has one - CdvHostedService
        // subscribes every strike in the tracked ATM+-16 window in Full mode as soon as it enters
        // that window (see its own doc comment), well before any signal on it can fire, so this is
        // normally already live the instant a trade picks this contract. That is the real
        // tradeable side of the book right now, a closer number to actually clear than entryPrice
        // (the signal/backtest reference, which can be a few seconds old by the time the order goes
        // out) - target/stop-loss/the deviation check below all stay anchored to entryPrice
        // unchanged, only the price actually SENT to Dhan moves to the live quote when one exists.
        // Falls back to entryPrice when no live depth has arrived yet for this contract.
        var limitReference = entryPrice;
        if (_feedClient.LastTickFor(contract.SecurityId) is { } liveQuote)
        {
            var sideDepth = isSell ? liveQuote.BestBidPrice : liveQuote.BestAskPrice;
            if (sideDepth > 0) limitReference = sideDepth;
        }
        var rawLimit = Math.Max(0, isSell ? limitReference - trigger.SlippagePoints : limitReference + trigger.SlippagePoints);

        var tick = contract.TickSize;
        var limitPrice = RoundToTick(rawLimit, tick);
        var targetPrice = RoundToTick(rawTarget, tick);
        var stopLossPrice = RoundToTick(rawStopLoss, tick);

        // Ground truth from Dhan's own position book, not an inference from a Super Order's own
        // leg statuses: whether an earlier order's target or stop-loss leg has actually fired is
        // exactly the kind of thing this app should not be guessing about with live money on the
        // line. A position that is still open (PositionType != CLOSED, NetQty != 0 - see
        // DhanPosition.IsOpen) for this EXACT contract means Dhan itself has not closed it out
        // yet, regardless of which trigger opened it - two live positions in the same contract at
        // once is never wanted, whatever produced either of them.
        var openPosition = (await _positions.ListAsync(cancellationToken))
            .FirstOrDefault(p => p.SecurityId == contract.SecurityId.ToString() && p.IsOpen);
        if (openPosition is not null)
        {
            if (!trigger.AdjustStopLossOnOpenPosition)
            {
                _logger.LogWarning("Trigger {Name}: {Underlying} {Strike}{Type} already has an open Dhan position ({PositionType}, netQty {NetQty}) - skipping this signal rather than doubling exposure.",
                    trigger.Name, trade.Underlying, trade.Strike, trade.OptionType, openPosition.PositionType, openPosition.NetQty);
                return (null, null, $"{trade.Strike:0.##}{trade.OptionType} already has an open Dhan position ({openPosition.PositionType}, netQty {openPosition.NetQty}) - skipping this signal rather than doubling exposure");
            }

            // Opted in: rather than skip the new signal outright, re-base the EXISTING position's
            // stop-loss off it - stopLossPrice above, computed from THIS signal's own entryPrice,
            // same formula a fresh entry would use. Still never places a second order.
            return await AdjustStopLossForOpenPositionAsync(trigger, trade, contract, openPosition, stopLossPrice, cancellationToken);
        }

        var quantity = trigger.QuantityLots * contract.LotSize;
        var transactionType = isSell ? "SELL" : "BUY";
        var correlationId = $"{trigger.Id}-{trade.SignalTimeUtc:yyyyMMddHHmm}";

        var expiryNote = isForeignExpiry ? $"\nExpiry {expiry.Value:dd MMM yyyy} (pinned - NOT the tracked expiry; priced off its own live quote)" : "";
        var summary = $"{transactionType} {contract.TradingSymbol} x{quantity} (SecurityId {contract.SecurityId})\n" +
            $"LIMIT {limitPrice:0.##} · Target {targetPrice:0.##} · SL {stopLossPrice:0.##}" + expiryNote;

        // A PROTECTIVE hedge leg only ever applies to a fresh sell - see StrategyTrigger.
        // HedgeOtmSteps' own doc comment. Resolved and priced here, alongside the main leg, but not
        // yet placed - PlaceOrderAsync places it FIRST and aborts the whole order if it fails,
        // since a sell this trigger was configured to hedge must never go out naked just because
        // the hedge leg itself could not be built.
        HedgePlan? hedgePlan = null;
        if (isSell && trigger.HedgeOtmSteps > 0)
        {
            var step = _spotFeed.States.TryGetValue(trade.Underlying, out var spotState) ? spotState.Step : 0;
            var requestedHedgeStrike = HedgeStrike(trade.Strike, isCall, trigger.HedgeOtmSteps, step);

            // A distance alone does not make a tradeable strike - see StrategyTrigger.
            // HedgeMinOpenInterestPercent. An empty snapshot (rate limiter, no session, outside
            // market hours) leaves the requested strike exactly as it was: this check can only ever
            // move the hedge CLOSER, so losing it costs protection that the listed/premium guards
            // below still backstop, whereas refusing to trade on a missing decoration would take
            // this trigger offline every time Dhan's 3-second limiter said no.
            // Deliberately NOT ForeignExpiryQuoteMaxAge: that 4-second freshness exists because a
            // stale PRICE makes re-pricing and the deviation guard meaningless. Open interest is a
            // slow-moving number being used only to tell a live strike from a dead one, so the
            // chain API's own 30-second cache is ample - and asking for fresher would push a real
            // outbound call through a limiter that spaces them 3.5s apart, which would sit and WAIT
            // inside the order path. Latency here delays a live order; a half-minute-old OI reading
            // costs nothing.
            var minOiPercent = trigger.HedgeMinOpenInterestPercent ?? HedgeDefaultMinOpenInterestPercent;
            var chainOi = await _cdv.GetChainOpenInterestAsync(trade.Underlying, expiry.Value, isCall, cancellationToken);
            if (chainOi.Count == 0 && minOiPercent > 0)
                _logger.LogWarning("Trigger {Name}: no option chain OI snapshot for {Underlying} {Expiry} - placing the hedge leg at the requested {Strike}{Type} WITHOUT a liquidity check.",
                    trigger.Name, trade.Underlying, expiry.Value, requestedHedgeStrike, trade.OptionType);

            var walked = HedgeStrikeWalkedInward(trade.Strike, isCall, trigger.HedgeOtmSteps, step, chainOi, minOiPercent);
            if (walked is not { } hedgeStrike)
            {
                _logger.LogWarning("Trigger {Name}: no hedge strike between {Floor} and {Requested} steps OTM of {Sold}{Type} has at least {Percent}% of its open interest - aborting the whole order rather than sell naked.",
                    trigger.Name, Math.Max(1, trigger.HedgeOtmSteps / 2), trigger.HedgeOtmSteps, trade.Strike, trade.OptionType, minOiPercent);
                return (null, null, $"every candidate hedge strike from {requestedHedgeStrike:0.##}{trade.OptionType} inward is too illiquid (under {minOiPercent}% of {trade.Strike:0.##}{trade.OptionType}'s open interest) - refusing to sell {trade.Strike:0.##}{trade.OptionType} naked instead");
            }

            var hedgeContract = _optionChainMaster.Find(trade.Underlying, expiry.Value, hedgeStrike, isCall);
            if (hedgeContract is null)
            {
                var nearby = _optionChainMaster.DescribeNearestListed(trade.Underlying, expiry.Value, hedgeStrike, isCall);
                _logger.LogWarning("Trigger {Name}: hedge leg {Strike}{Type} not found on expiry {Expiry} - aborting the whole order rather than sell naked. {Nearby}",
                    trigger.Name, hedgeStrike, trade.OptionType, expiry.Value, nearby);
                return (null, null, $"the protective hedge leg {hedgeStrike:0.##}{trade.OptionType} is not listed on the {expiry.Value:dd MMM yyyy} expiry ({nearby}) - refusing to sell {trade.Strike:0.##}{trade.OptionType} naked instead");
            }

            var hedgeLive = await GetOrderPremiumAsync(trade.Underlying, expiry.Value, trackedExpiry, hedgeStrike, isCall, cancellationToken);
            if (hedgeLive is not { } hedgeReference || hedgeReference <= 0)
            {
                _logger.LogWarning("Trigger {Name}: no live premium for hedge leg {Strike}{Type} on expiry {Expiry} - aborting the whole order rather than sell naked.",
                    trigger.Name, hedgeStrike, trade.OptionType, expiry.Value);
                return (null, null, $"no live premium available for the protective hedge leg {hedgeStrike:0.##}{trade.OptionType} - refusing to sell {trade.Strike:0.##}{trade.OptionType} naked instead");
            }

            // Same live-quote override the main leg's own limitReference applies just above -
            // hedgeReference (GetOrderPremiumAsync) is the last TRADED price, which can already be
            // stale the moment a real order is about to go out; the live best ASK (this is always a
            // BUY) is the actual tradeable price right now when the strike's Full-mode feed has
            // delivered one. Falls back to hedgeReference unchanged when no live depth has arrived
            // yet, exactly like the main leg.
            var hedgeLimitReference = hedgeReference;
            if (_feedClient.LastTickFor(hedgeContract.SecurityId) is { } hedgeQuote && hedgeQuote.BestAskPrice > 0)
                hedgeLimitReference = hedgeQuote.BestAskPrice;

            // Buying, so pay a little ABOVE the reference to stay marketable - the mirror of how
            // limitReference/rawLimit above prices a SELL a little below it.
            var hedgeRawPrice = hedgeLimitReference + trigger.SlippagePoints;
            var hedgePrice = RoundToTick(hedgeRawPrice, hedgeContract.TickSize);

            // Never a silent substitution: a hedge that moved is a different spread - tighter risk,
            // more premium paid - and whoever set that distance is entitled to see that it moved
            // and why, in the same message that reports the order.
            var actualSteps = step > 0 ? (int)(Math.Abs(hedgeStrike - trade.Strike) / step) : trigger.HedgeOtmSteps;
            var hedgeNote = hedgeStrike == requestedHedgeStrike
                ? $"{trigger.HedgeOtmSteps} step(s) further OTM than the sold leg"
                : $"{actualSteps} step(s) further OTM than the sold leg - moved in from the requested {requestedHedgeStrike:0.##} ({trigger.HedgeOtmSteps} steps), which had under {minOiPercent}% of the sold strike's open interest";
            var hedgeSummary = $"BUY {hedgeContract.TradingSymbol} x{quantity} (SecurityId {hedgeContract.SecurityId}) - protective hedge, {hedgeNote}\nLIMIT {hedgePrice:0.##}";

            hedgePlan = new HedgePlan(hedgeContract.SecurityId.ToString(), hedgeContract.SecurityId, quantity, hedgePrice, hedgeSummary, hedgeContract.DhanSegment, hedgeContract.LotSize);
        }

        return (new SuperOrderPlan(transactionType, contract.SecurityId.ToString(), contract.SecurityId, quantity, limitPrice, targetPrice, stopLossPrice, tick, entryPrice, correlationId, summary, expiry.Value, contract.DhanSegment, contract.LotSize), hedgePlan, null);
    }

    /// <summary>The PROTECTIVE hedge leg's own order shape - see StrategyTrigger.HedgeOtmSteps. A
    /// plain marketable BUY (DhanOrderClient, not DhanSuperOrderClient - it carries no SL/target of
    /// its own; it is only ever closed once the main leg it protects closes, see
    /// CloseHedgeIfOpenAsync), priced the same "SlippagePoints beyond the live reference" way every
    /// other entry in this file already is.</summary>
    private sealed record HedgePlan(string SecurityId, uint InstrumentSecurityId, int Quantity, decimal Price, string Summary, string DhanSegment, int LotSize);

    /// <summary>StrategyTrigger.HedgeOtmSteps' own distance rule: further OTM in the SAME direction
    /// the sold leg already is, measured from the SOLD strike itself rather than from ATM again -
    /// a higher strike for a sold CE (calls get cheaper as the strike rises), a lower strike for a
    /// sold PE (puts get cheaper as the strike falls). Pure arithmetic, pulled out of
    /// BuildOrderPlanAsync for direct unit test coverage the way that method's own live Dhan/CDV
    /// dependencies otherwise make impossible to exercise.</summary>
    internal static decimal HedgeStrike(decimal soldStrike, bool isCall, int hedgeOtmSteps, int step) =>
        isCall ? soldStrike + hedgeOtmSteps * step : soldStrike - hedgeOtmSteps * step;

    /// <summary>What StrategyTrigger.HedgeMinOpenInterestPercent defaults to when a trigger leaves
    /// it null. Deliberately LENIENT: the two failure directions are not symmetric. Too lax leaves
    /// the thin strike the distance already landed on - exactly what happened before this check
    /// existed - while too strict silently pulls the hedge closer to the money on every single
    /// trade, paying more premium and quietly changing the spread's economics out from under
    /// whoever configured that distance. The first is the status quo; the second is a new way to
    /// lose money. So this errs toward accepting, and leaves tightening to someone who has watched
    /// the real OI on their own chain.</summary>
    internal const int HedgeDefaultMinOpenInterestPercent = 5;

    /// <summary>StrategyTrigger.HedgeMinOpenInterestPercent's actual search: the requested hedge
    /// strike if it is liquid enough, otherwise the first strike INWARD of it (back toward the sold
    /// leg) that is, down to a floor of half the requested distance. Null when nothing in that band
    /// qualifies - the caller abandons the whole order rather than selling naked.
    ///
    /// Inward is the only direction this may walk. Closer to ATM is both more liquid (which is the
    /// point) and more protective - a narrower spread caps the loss tighter - so the substitution
    /// can only ever cost premium, never widen tail risk. Walking further OUT would be cheaper and
    /// find liquidity at round strikes, but it would silently hand back a worse hedge than the one
    /// that was asked for, which is the one thing this must not do.
    ///
    /// The half-distance floor bounds that cost: a hedge can end up at most twice as close as
    /// configured, never at the sold strike itself (which would not be a hedge at all). Beyond that
    /// the trade is simply not the one the trigger describes, so it does not get placed.
    ///
    /// <paramref name="openInterestByStrike"/> is the live chain snapshot for THIS expiry and side.
    /// A strike missing from it is treated as failing: the chain is what the market is actually
    /// quoting, so absent there means there is nothing to buy, the same conclusion the caller's own
    /// no-live-premium guard reaches by a different route. When the sold strike itself has no OI in
    /// the snapshot the threshold is 0 and everything passes - that is the intended lenient
    /// degradation, not an oversight: with no yardstick there is nothing to measure against, and
    /// refusing to trade on a missing decoration would be far worse than the thin hedge this check
    /// exists to avoid.</summary>
    internal static decimal? HedgeStrikeWalkedInward(
        decimal soldStrike, bool isCall, int requestedSteps, int step,
        IReadOnlyDictionary<decimal, long> openInterestByStrike, int minOpenInterestPercent)
    {
        var requested = HedgeStrike(soldStrike, isCall, requestedSteps, step);
        if (minOpenInterestPercent <= 0 || openInterestByStrike.Count == 0) return requested;

        openInterestByStrike.TryGetValue(soldStrike, out var soldOpenInterest);
        var required = soldOpenInterest * minOpenInterestPercent / 100m;

        // Never below 1: a "hedge" at the sold strike itself is the same contract, not protection.
        var floorSteps = Math.Max(1, requestedSteps / 2);

        for (var steps = requestedSteps; steps >= floorSteps; steps--)
        {
            var strike = HedgeStrike(soldStrike, isCall, steps, step);
            if (openInterestByStrike.TryGetValue(strike, out var oi) && oi >= required) return strike;
        }

        return null;
    }

    /// <summary>StrategyTrigger.AdjustStopLossOnOpenPosition's actual effect: MODIFY the existing
    /// Super Order's STOP_LOSS_LEG to <paramref name="newStopLoss"/> (the new signal's own
    /// entryPrice +/- slPoints, tick-rounded by the caller) rather than place a second order on
    /// top of an already-open position. Always returns a null Plan - there is never a fresh order
    /// to place here, whatever happens - but with a null SkipReason on success/failure-already-
    /// reported, so PlaceOrderInBackgroundAsync's own [NO ORDER PLACED] fallback message stays
    /// silent; this method sends its own, more specific Telegram message either way.</summary>
    private async Task<(SuperOrderPlan? Plan, HedgePlan? Hedge, string? SkipReason)> AdjustStopLossForOpenPositionAsync(
        StrategyTrigger trigger, BacktestTrade trade, DhanOptionInstrument contract, DhanPosition openPosition,
        decimal newStopLoss, CancellationToken cancellationToken)
    {
        // The position book (just checked) says a position exists; the order book is where its
        // STOP_LOSS_LEG(s) actually live, so they still have to be found there by security id -
        // matched on an entry that has actually filled, since a PENDING/TRANSIT entry has no
        // position (and so no stop-loss leg) to modify yet regardless of what triggered this call.
        //
        // ALL matching orders, not just one: a position whose entry quantity exceeded the exchange
        // freeze limit is sliced across more than one Super Order (see
        // StrategyTriggerHostedService.SliceQuantity), and every slice carries its OWN
        // STOP_LOSS_LEG - moving only the first would leave the rest of the position protected at
        // the stale price, silently.
        var orders = await _superOrders.ListAsync(cancellationToken);
        var matchingOrders = orders.Where(o =>
            o.SecurityId == contract.SecurityId.ToString() &&
            (o.LegDetails.FirstOrDefault(l => l.LegName == "ENTRY_LEG")?.OrderStatus ?? o.OrderStatus) is "TRADED" or "PART_TRADED")
            .ToList();

        if (matchingOrders.Count == 0)
        {
            _logger.LogWarning("Trigger {Name}: {Underlying} {Strike}{Type} has an open Dhan position ({PositionType}, netQty {NetQty}) but no matching filled Super Order was found - cannot update its stop-loss.",
                trigger.Name, trade.Underlying, trade.Strike, trade.OptionType, openPosition.PositionType, openPosition.NetQty);
            return (null, null, $"{trade.Strike:0.##}{trade.OptionType} has an open position ({openPosition.PositionType}, netQty {openPosition.NetQty}) but no matching order was found to update its stop-loss - skipping this signal");
        }

        var ist = IstClock.Offset;
        var updated = new List<string>();
        var failed = new List<(string OrderId, string Reason)>();

        foreach (var order in matchingOrders)
        {
            var previousStopLoss = order.StopLossPrice;
            var (result, error) = await _superOrders.ModifyAsync(order.OrderId, "STOP_LOSS_LEG",
                orderType: null, quantity: null, price: null, targetPrice: null, stopLossPrice: newStopLoss, trailingJump: null, cancellationToken);

            if (result is null)
            {
                var reason = string.IsNullOrWhiteSpace(error) ? "no reason given by Dhan" : error;
                _logger.LogError("Trigger {Name}: stop-loss update FAILED for order {OrderId} ({Underlying} {Strike}{Type}) - {Error}",
                    trigger.Name, order.OrderId, trade.Underlying, trade.Strike, trade.OptionType, reason);
                failed.Add((order.OrderId, reason));
                continue;
            }

            _logger.LogInformation("Trigger {Name}: stop-loss updated for order {OrderId} from {Previous:0.##} to {New:0.##} off a new signal instead of opening a second position.",
                trigger.Name, order.OrderId, previousStopLoss, newStopLoss);
            updated.Add(order.OrderId);
        }

        var sliceNote = matchingOrders.Count > 1 ? $" across {matchingOrders.Count} slices" : "";
        if (failed.Count > 0)
        {
            var failedList = string.Join("; ", failed.Select(f => $"{f.OrderId}: {f.Reason}"));
            await NotifyFollowUpAsync(trigger,
                $"[STOP LOSS UPDATE {(updated.Count > 0 ? "PARTIALLY " : "")}FAILED] {trade.Underlying} {trade.Strike:0.##}{trade.OptionType}{sliceNote}\nTried to move SL to {newStopLoss:0.##} off a new {trade.Direction} signal at {trade.SignalTimeUtc.ToOffset(ist):HH:mm} IST.\nSucceeded: {(updated.Count > 0 ? string.Join(", ", updated) : "none")}\nFailed: {failedList}",
                cancellationToken);
        }
        else
        {
            await NotifyFollowUpAsync(trigger,
                $"[STOP LOSS UPDATED] {trade.Underlying} {trade.Strike:0.##}{trade.OptionType}{sliceNote}\nSL moved to {newStopLoss:0.##} on order(s) {string.Join(", ", updated)}, re-based off a new {trade.Direction} signal at {trade.SignalTimeUtc.ToOffset(ist):HH:mm} IST - no second position opened.",
                cancellationToken);
        }

        return (null, null, null);
    }

    /// <summary>Places the order and, on success, hands the fill-monitoring off to MonitorFillAsync
    /// as a background task rather than awaiting it here - a resting LIMIT order can take up to
    /// MaxFillAttempts x FillCheckInterval to resolve, and blocking on that would stall every OTHER
    /// trigger's evaluation behind this one order (EvaluateAsync/ExecuteAsync call this once per
    /// fired trade, in a loop over all enabled triggers). Returns the status line - [ORDER PLACED]
    /// with Dhan's own order id/status on success (fill/cancel outcome follows later as its own
    /// message via NotifyFollowUpAsync), or [ORDER FAILED] with the reason on failure - for the
    /// caller (PlaceOrderInBackgroundAsync) to send as its own follow-up Telegram message. Never
    /// throws: PlaceAsync already logs and returns null on any error (network, rejection, missing IP
    /// whitelisting), so a failed placement never stops the underlying signal alert from going
    /// out - that alert is sent independently and earlier by NotifyAsync regardless.
    ///
    /// <paramref name="hedge"/>, when BuildOrderPlanAsync built one, is placed FIRST - a plain BUY
    /// via DhanOrderClient, not a Super Order (see HedgePlan's own doc comment) - and if IT fails,
    /// the whole thing aborts right here: the main Super Order below is never placed. A trigger
    /// configured with HedgeOtmSteps asked for a hedged spread, not "a spread when convenient, a
    /// naked sell otherwise" - the one substitution real money can never make silently.</summary>
    private async Task<string> PlaceOrderAsync(StrategyTrigger trigger, BacktestTrade trade, SuperOrderPlan plan, HedgePlan? hedge, CancellationToken cancellationToken)
    {
        var freezeLimit = FreezeQuantityFor(trigger.Underlying);
        string? hedgeNote = null;

        if (hedge is not null)
        {
            var hedgeSlices = SliceQuantity(hedge.Quantity, hedge.LotSize, freezeLimit);
            var hedgeOrderIds = new List<string>();

            for (var i = 0; i < hedgeSlices.Count; i++)
            {
                if (i > 0) await Task.Delay(SliceCallDelay, cancellationToken);

                // Distinguishable per slice only when there IS more than one - an unsliced hedge's
                // correlationId is unchanged from before this existed.
                var hedgeCorrelationId = hedgeSlices.Count > 1
                    ? $"{trigger.Id}-hedge-{trade.SignalTimeUtc:yyyyMMddHHmm}-{i + 1}"
                    : $"{trigger.Id}-hedge-{trade.SignalTimeUtc:yyyyMMddHHmm}";

                var (hedgeResult, hedgeError) = await _orders.PlaceAsync(
                    "BUY", hedge.DhanSegment, ProductType, OrderType, "DAY",
                    hedge.SecurityId, hedgeSlices[i], hedge.Price, hedgeCorrelationId, cancellationToken);

                if (hedgeResult is null)
                {
                    var hedgeReason = string.IsNullOrWhiteSpace(hedgeError) ? "no reason given by Dhan" : hedgeError;
                    _logger.LogError("Trigger {Name}: hedge leg placement FAILED for {Summary} (slice {Slice}/{Total}) - {Error} - main order ABORTED, refusing to sell naked.",
                        trigger.Name, hedge.Summary, i + 1, hedgeSlices.Count, hedgeReason);

                    // Nothing further to record here: whatever slice(s) DID place before this one
                    // failed already persisted themselves to the store the instant they existed (see
                    // the success branch below), so CloseHedgeIfOpenAsync can already find them - a
                    // mid-loop failure only means the operator must be told the hedge is partial
                    // rather than either whole or absent.
                    var partialNote = hedgeOrderIds.Count > 0
                        ? $"\n\nNOTE: {hedgeOrderIds.Count}/{hedgeSlices.Count} hedge slice(s) WERE already placed (orders {string.Join(", ", hedgeOrderIds)}) - CHECK DHAN, the hedge is now PARTIAL, not absent."
                        : "";
                    return $"[HEDGE FAILED - MAIN ORDER ABORTED]\n{hedge.Summary}\nDhan error: {hedgeReason}\nRefusing to place the main {plan.TransactionType} leg naked - nothing new was placed for this signal.{partialNote} If that doesn't explain it, a common secondary cause is the account's static IP whitelisting not covering this server.";
                }

                _logger.LogInformation("Trigger {Name}: hedge leg placed - orderId={OrderId} status={Status} qty={Quantity} (slice {Slice}/{Total}) for {Summary}",
                    trigger.Name, hedgeResult.OrderId, hedgeResult.OrderStatus, hedgeSlices[i], i + 1, hedgeSlices.Count, hedge.Summary);
                hedgeOrderIds.Add(hedgeResult.OrderId);

                // Persisted the instant EACH order id exists, not batched until the loop finishes -
                // a real order is live at Dhan the moment this call returns, and a process crash or
                // deploy landing between two slice placements must never leave an already-placed
                // slice untracked. CloseHedgeIfOpenAsync (and a restart) can only find what the
                // store actually holds, so the store has to be as current as reality after every
                // single slice, not just the last one.
                _store.SetLastHedgeOrderId(trigger.Id, hedgeOrderIds[0], hedgeOrderIds.Skip(1).ToList());
            }

            hedgeNote = hedgeSlices.Count > 1
                ? $"\n\n[HEDGE PLACED - {hedgeSlices.Count} slices, freeze limit {freezeLimit}] {hedge.Summary}\nOrders: {string.Join(", ", hedgeOrderIds)}"
                : $"\n\n[HEDGE PLACED] {hedge.Summary}";
        }

        var entrySlices = SliceQuantity(plan.Quantity, plan.LotSize, freezeLimit);
        var entryOrderIds = new List<string>();
        SuperOrderResult? firstResult = null;

        for (var i = 0; i < entrySlices.Count; i++)
        {
            if (i > 0) await Task.Delay(SliceCallDelay, cancellationToken);

            var correlationId = entrySlices.Count > 1 ? $"{plan.CorrelationId}-{i + 1}" : plan.CorrelationId;
            var (result, error) = await _superOrders.PlaceAsync(
                plan.TransactionType, plan.DhanSegment, ProductType, OrderType,
                plan.SecurityId, entrySlices[i], plan.Price, plan.TargetPrice, plan.StopLossPrice,
                correlationId, trailingJump: 0, cancellationToken);

            if (result is null)
            {
                var reason = string.IsNullOrWhiteSpace(error) ? "no reason given by Dhan" : error;
                _logger.LogError("Trigger {Name}: Super Order placement FAILED for {Summary} (slice {Slice}/{Total}) - {Error}",
                    trigger.Name, plan.Summary, i + 1, entrySlices.Count, reason);

                // Nothing further to record here: every slice that DID place already persisted
                // itself to the store the instant it existed (see the success branch below) and was
                // already handed to StartFillMonitoring right then too - a mid-loop failure changes
                // nothing about slices that already succeeded, only stops any FURTHER ones from
                // being attempted.
                var partialNote = entryOrderIds.Count > 0
                    ? $"\n\nNOTE: {entryOrderIds.Count}/{entrySlices.Count} slice(s) WERE already placed (orders {string.Join(", ", entryOrderIds)}) - CHECK DHAN, the position is PARTIAL, not absent."
                    : "";
                // By this point the hedge (if requested) is definitely placed IN FULL - a hedge
                // slice failing returns from the hedge loop above before the entry loop is ever
                // reached, so there is no "partial hedge" case to describe here. What IS true, and
                // worth saying precisely rather than hedging the wording: the hedge is now
                // protecting a SMALLER (or entirely absent) main position than it was sized for.
                var abortedHedgeNote = hedge is not null
                    ? "\n\nNOTE: the protective hedge leg above WAS placed in full - CHECK DHAN, it is now protecting a smaller (or, if no entry slice placed at all, an entirely absent) main position than it was sized for."
                    : "";
                return $"[ORDER FAILED]\n{plan.Summary}\nDhan error: {reason}{partialNote}\nIf that doesn't explain it, a common secondary cause is the account's static IP whitelisting not covering this server.{abortedHedgeNote}";
            }

            firstResult ??= result;
            _logger.LogInformation("Trigger {Name}: Super Order placed - orderId={OrderId} status={Status} qty={Quantity} (slice {Slice}/{Total}) for {Summary}",
                trigger.Name, result.OrderId, result.OrderStatus, entrySlices[i], i + 1, entrySlices.Count, plan.Summary);
            entryOrderIds.Add(result.OrderId);

            // Persisted the instant EACH order id exists, not batched until the loop finishes - see
            // the identical reasoning on the hedge loop above. StrategyTrigger.LastOrderId's own doc
            // comment is why SquareOffIfDueAsync needs this at all; a crash between two slices must
            // never leave an already-placed one with nothing in the store pointing at it.
            _store.SetLastOrderId(trigger.Id, entryOrderIds[0], entryOrderIds.Skip(1).ToList());

            // Each slice is monitored/re-priced independently the instant it exists, exactly as the
            // single unsliced order always was - not after the whole loop finishes, so an earlier
            // slice's fill-monitoring is never delayed behind placing a later one.
            StartFillMonitoring(trigger, trade, plan with { Quantity = entrySlices[i] }, result.OrderId, cancellationToken);
        }

        var sliceNote = entrySlices.Count > 1
            ? $" split into {entrySlices.Count} slices (exchange freeze limit {freezeLimit}) - orders {string.Join(", ", entryOrderIds)}"
            : "";
        return $"[ORDER PLACED] Dhan order {firstResult!.OrderId} ({firstResult.OrderStatus}){sliceNote}\n{plan.Summary}\nMonitoring fill (up to {MaxFillAttempts} attempts)...{hedgeNote}";
    }

    /// <summary>Fire-and-forget wrapper around MonitorFillAsync for exactly ONE placed order -
    /// pulled out of PlaceOrderAsync so a sliced entry can call it once per slice, each watching and
    /// re-pricing its own order independently, without duplicating the crash-safety wrapper. Runs
    /// against CancellationToken.None (like the single-order version always did) so it stops
    /// cleanly on shutdown rather than the per-evaluation token, and its own try/catch is a
    /// backstop only - MonitorFillAsync already handles its expected failure modes internally.</summary>
    private void StartFillMonitoring(StrategyTrigger trigger, BacktestTrade trade, SuperOrderPlan slicePlan, string orderId, CancellationToken cancellationToken)
    {
        _ = Task.Run(async () =>
        {
            try { await MonitorFillAsync(trigger, trade, slicePlan, orderId, cancellationToken); }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "Trigger {Name}: fill-monitoring crashed for order {OrderId}.", trigger.Name, orderId);

                // A real order is live and nothing is watching it any more. That has to reach the
                // phone, not just the log - it is the one state this whole retry loop exists to
                // prevent. CancellationToken.None so a shutdown-time crash still gets the message
                // out rather than cancelling the very notification about it.
                await NotifyFollowUpAsync(trigger,
                    $"[ORDER UNMONITORED] {slicePlan.Summary}\nDhan order {orderId}\nFill-monitoring crashed - the order may still be resting or filled. CHECK DHAN DIRECTLY.",
                    CancellationToken.None);
            }
        }, CancellationToken.None);
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
    /// A PART_TRADED order (part of the quantity already filled, with its own live SL/target legs)
    /// is treated differently from a fully-unfilled one: it is RE-PRICED for just the remaining
    /// quantity, with escalating slippage each attempt so it does not just repeat a price that
    /// already failed to clear - but it is NEVER cancelled, since cancelling ENTRY_LEG cancels the
    /// WHOLE order including the legs protecting the quantity already filled (see
    /// DhanSuperOrderClient's own doc comment). If it is still partial once attempts run out, or the
    /// live premium trips MaxDeviationPercent while still partial, this stops chasing the remainder
    /// and leaves it resting - a plain working LIMIT order, not a naked position - rather than risk
    /// stripping that protection. Only a FULLY unfilled order is ever actually cancelled, which is
    /// what "no open order left" safely means here: nothing is EVER left both unfilled with no plan
    /// for it AND unmonitored.
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
        var referencePrice = plan.ReferencePrice; // fixed for every attempt - see this method's own doc comment, and SuperOrderPlan.ReferencePrice
        var currentPrice = plan.Price;
        var partialFillRetries = 0; // how many re-price attempts have happened SINCE a partial fill was first seen - escalates slippage, see the re-price step below

        for (var attempt = 1; attempt <= MaxFillAttempts; attempt++)
        {
            try
            {
                await Task.Delay(FillCheckInterval, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                // Shutting down. The order is left exactly as it is (cancelling it here could strip
                // the SL/target off a partial fill), but "left as it is" must not also mean "left
                // unsaid": nothing will be watching it after this process exits.
                _logger.LogWarning("Trigger {Name}: shutting down while order {OrderId} was still being monitored - leaving it as-is.", trigger.Name, orderId);
                await NotifyFollowUpAsync(trigger,
                    $"[ORDER UNMONITORED] {plan.Summary}\nDhan order {orderId}\nThe app is shutting down before this order resolved - it is left exactly as it was, unfilled or partially filled, and nothing is watching it now. CHECK DHAN DIRECTLY.",
                    CancellationToken.None);
                return;
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

            var filledQuantity = entryLeg?.TriggeredQuantity ?? 0;

            if (string.Equals(entryStatus, "TRADED", StringComparison.OrdinalIgnoreCase))
            {
                _logger.LogInformation("Trigger {Name}: order {OrderId} filled on attempt {Attempt}/{Max}.", trigger.Name, orderId, attempt, MaxFillAttempts);
                await NotifyFollowUpAsync(trigger,
                    $"[ORDER FILLED] {plan.Summary}\nFilled {plan.Quantity}/{plan.Quantity} on attempt {attempt}/{MaxFillAttempts} at ~{currentPrice:0.##}.",
                    cancellationToken);
                return;
            }

            if (entryStatus is "CANCELLED" or "REJECTED" or "CLOSED")
            {
                // Already off the book by some other means (manual cancel, Dhan-side rejection
                // discovered late) - nothing for this loop to do, and nothing to cancel.
                var reasonLine = string.IsNullOrWhiteSpace(order.OmsErrorDescription) ? "" : $"\nReason: {order.OmsErrorDescription}";
                _logger.LogWarning("Trigger {Name}: order {OrderId} is {Status} ({Reason}) - stopping fill monitoring.",
                    trigger.Name, orderId, entryStatus, order.OmsErrorDescription ?? "no reason given");
                await NotifyFollowUpAsync(trigger, $"[ORDER {entryStatus}] {plan.Summary}{reasonLine}", cancellationToken);
                return;
            }

            // PART_TRADED means part of the quantity is already a real, live position with its own
            // SL/target legs attached - cancelling ENTRY_LEG to clear the unfilled remainder would
            // cancel the WHOLE order (see DhanSuperOrderClient's own doc comment), stripping that
            // protection off the position that already exists. So a partial fill is NEVER cancelled
            // here, only re-priced for just the remaining quantity - and if attempts run out or
            // deviation trips while still partial, this stops chasing and leaves the remainder
            // resting (still a normal, harmless working LIMIT order) rather than risk a naked
            // position by cancelling.
            var isPartial = entryStatus == "PART_TRADED";
            if (isPartial) partialFillRetries++;
            var remainingQuantity = plan.Quantity - filledQuantity;

            if (attempt == MaxFillAttempts)
            {
                // Last allowed check - no more re-pricing regardless of status.
                if (isPartial)
                {
                    _logger.LogWarning("Trigger {Name}: order {OrderId} still PART_TRADED ({Filled}/{Total}) after {Max} attempts - leaving the resting remainder as-is.",
                        trigger.Name, orderId, filledQuantity, plan.Quantity, MaxFillAttempts);
                    await NotifyFollowUpAsync(trigger,
                        $"[ORDER PARTIALLY FILLED] {plan.Summary}\nFilled {filledQuantity}/{plan.Quantity} after {MaxFillAttempts} attempts. The remaining {remainingQuantity} is left resting (NOT cancelled - cancelling would remove the SL/target protecting the {filledQuantity} already filled). Cancel it manually in Dhan if you don't want it to fill later.",
                        cancellationToken);
                }
                else
                {
                    _logger.LogWarning("Trigger {Name}: order {OrderId} still unfilled after {Max} attempts - cancelling.", trigger.Name, orderId, MaxFillAttempts);
                    await CancelOrderAsync(trigger, orderId, plan, $"did not fill after {MaxFillAttempts} attempts", cancellationToken);
                }
                return;
            }

            var latestPrice = await GetRepricingReferenceAsync(trade, plan, isCall, isSell, cancellationToken);
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
                    "Trigger {Name}: live premium {Latest:0.##} has moved {Deviation:0.#}% from the signal price {Reference:0.##} (limit {Limit:0.#}%) - stopping re-price attempts for order {OrderId}.",
                    trigger.Name, latestPrice, deviationPercent, referencePrice, trigger.MaxDeviationPercent, orderId);

                if (isPartial)
                {
                    await NotifyFollowUpAsync(trigger,
                        $"[ORDER PARTIALLY FILLED] {plan.Summary}\nFilled {filledQuantity}/{plan.Quantity}; live premium moved {deviationPercent:0.#}% from the signal price, past the {trigger.MaxDeviationPercent:0.#}% limit. Stopped chasing the remaining {remainingQuantity} rather than cancel (that would strip the SL/target off the {filledQuantity} already filled) - check Dhan.",
                        cancellationToken);
                }
                else
                {
                    await CancelOrderAsync(trigger, orderId, plan,
                        $"price moved {deviationPercent:0.#}% from the signal price ({referencePrice:0.##} -> {latestPrice:0.##}), past the {trigger.MaxDeviationPercent:0.#}% limit",
                        cancellationToken);
                }
                return;
            }

            // A partial fill re-prices with escalating slippage - the base price already failed to
            // clear the remainder, so repeating it attempt after attempt would just keep failing the
            // same way. A fully-unfilled order retries at UnfilledRetrySlippageMultiplier x the
            // trigger's own configured slippage (e.g. 1 point becomes 3) for the same reason - the
            // original, tighter price already failed to clear once, so simply re-quoting it again at
            // the current live premium would just fail the same way again.
            var slippage = isPartial ? trigger.SlippagePoints * (1 + partialFillRetries) : trigger.SlippagePoints * UnfilledRetrySlippageMultiplier;
            var rawPrice = Math.Max(0, isSell ? latestPrice.Value - slippage : latestPrice.Value + slippage);
            var newPrice = RoundToTick(rawPrice, plan.TickSize);
            // ENTRY_LEG's own quantity field is the order's remaining WORKING quantity, not a delta -
            // see DhanSuperOrderClient's own doc comment on ModifyAsync. Re-quoting it down to just
            // what's left to fill (rather than leaving it at the original total) is what stops this
            // from silently trying to buy/sell MORE than the trigger was ever configured for.
            var newQuantity = isPartial ? remainingQuantity : (int?)null;

            var (modifyResult, modifyError) = await _superOrders.ModifyAsync(orderId, "ENTRY_LEG", orderType: null, quantity: newQuantity,
                price: newPrice, targetPrice: null, stopLossPrice: null, trailingJump: null, cancellationToken);
            if (modifyResult is null)
            {
                _logger.LogWarning("Trigger {Name}: re-price MODIFY failed for order {OrderId} on attempt {Attempt}/{Max} - {Error} - will check again.",
                    trigger.Name, orderId, attempt, MaxFillAttempts, string.IsNullOrWhiteSpace(modifyError) ? "no reason given by Dhan" : modifyError);
                continue;
            }

            currentPrice = newPrice;
            _logger.LogInformation("Trigger {Name}: re-priced order {OrderId} to {Price:0.##} for {Quantity} (attempt {Attempt}/{Max}, live premium {Live:0.##}, slippage {Slippage:0.##}).",
                trigger.Name, orderId, newPrice, remainingQuantity == 0 ? plan.Quantity : remainingQuantity, attempt + 1, MaxFillAttempts, latestPrice, slippage);
        }
    }

    /// <summary>What MonitorFillAsync's retry loop re-prices an unfilled/partially-filled entry
    /// off: the live best bid (for a SELL) or best ask (for a BUY) straight from the option
    /// strike's own Full-mode feed subscription (see DhanMarketFeedClient/CdvHostedService) when
    /// one has arrived, since that is the actual tradeable side of the book right now - a closer
    /// number to chase than the last traded price, which can be stale on a thinly-traded strike or
    /// simply be the OTHER side's last print. Falls back to GetOrderPremiumAsync's last-traded-price
    /// behaviour (unchanged) when no live depth is available yet - a strike whose Full subscription
    /// hasn't delivered a packet since it was picked up, or one with a genuinely empty book.</summary>
    private async Task<decimal?> GetRepricingReferenceAsync(BacktestTrade trade, SuperOrderPlan plan, bool isCall, bool isSell, CancellationToken cancellationToken)
    {
        if (_feedClient.LastTickFor(plan.InstrumentSecurityId) is { } tick)
        {
            var sideDepth = isSell ? tick.BestBidPrice : tick.BestAskPrice;
            if (sideDepth > 0) return sideDepth;
        }

        return await GetOrderPremiumAsync(trade.Underlying, plan.Expiry, plan.Expiry, trade.Strike, isCall, cancellationToken);
    }

    /// <summary>The latest known premium for one strike, INCLUDING the still-forming bar
    /// (CdvUnderlyingState.GetStrikeCandles, not the closed-only view) - a retry re-pricing off a
    /// stale closed-bar price could lag the live market by up to a full bar. Null if the underlying
    /// isn't tracked at all or the strike has no candles yet.</summary>
    /// <summary>The premium to price an order (or a re-priced retry) off, for whichever expiry that
    /// order is in. The tracked expiry answers from the live websocket feed, same as it always has.
    /// Any other expiry has no subscribed contracts, so it falls back to Dhan's Option Chain API -
    /// a rate-limited snapshot rather than a tick feed, asked for with a short max-age so a retry
    /// loop is not re-pricing off a half-minute-old number. See StrategyTrigger.OrderExpiry.</summary>
    private async Task<decimal?> GetOrderPremiumAsync(
        string underlying, DateOnly expiry, DateOnly? trackedExpiry, decimal strike, bool isCall, CancellationToken cancellationToken)
    {
        // Any TRACKED expiry answers from its own live feed - including a pinned one, now that
        // several expiries are subscribed at once. GetChainPremiumAsync makes the same check and
        // only calls Dhan for an expiry with no subscription behind it.
        if (_cdv.StateFor(underlying, expiry) is { } tracked && tracked.GetStrikeCandles(strike, isCall) is { Count: > 0 } bars)
            return bars[^1].Close;

        return await _cdv.GetChainPremiumAsync(underlying, expiry, strike, isCall, cancellationToken, ForeignExpiryQuoteMaxAge);
    }

    private decimal? GetLatestPremium(string underlying, decimal strike, bool isCall)
    {
        if (!_cdv.States.TryGetValue(underlying, out var state)) return null;
        var candles = state.GetStrikeCandles(strike, isCall);
        return candles is { Count: > 0 } ? candles[^1].Close : null;
    }

    private async Task CancelOrderAsync(StrategyTrigger trigger, string orderId, SuperOrderPlan plan, string reason, CancellationToken cancellationToken)
    {
        var (result, cancelError) = await _superOrders.CancelAsync(orderId, "ENTRY_LEG", cancellationToken);
        if (result is null)
        {
            var cancelReason = string.IsNullOrWhiteSpace(cancelError) ? "no reason given by Dhan" : cancelError;
            _logger.LogError("Trigger {Name}: failed to cancel unfilled order {OrderId} ({Reason}) - {CancelError} - it may still be resting live, check Dhan directly.",
                trigger.Name, orderId, reason, cancelReason);
            await NotifyFollowUpAsync(trigger,
                $"[ORDER CANCEL FAILED] {plan.Summary}\nReason: {reason}\nDhan error: {cancelReason}\nCould not confirm the cancel with Dhan - check the account directly, the order may still be live.",
                cancellationToken);
            return;
        }

        _logger.LogInformation("Trigger {Name}: cancelled unfilled order {OrderId} - {Reason}.", trigger.Name, orderId, reason);
        await NotifyFollowUpAsync(trigger, $"[ORDER CANCELLED] {plan.Summary}\nReason: {reason}", cancellationToken);
    }

    /// <summary>Sends a standalone Telegram message for something MonitorFillAsync/CancelOrderAsync
    /// discovered well after the trigger's own initial alert already went out - a fill, a cancel, or
    /// a give-up - so the outcome doesn't wait on (or get lost inside) that earlier message.
    ///
    /// This is the ONE place every order-pipeline outcome passes through - [NO ORDER PLACED],
    /// [ORDER PLACED/FAILED/PIPELINE CRASHED] from PlaceOrderInBackgroundAsync, and every
    /// [ORDER FILLED/CANCELLED/PARTIALLY FILLED/UNMONITORED/...] MonitorFillAsync/CancelOrderAsync
    /// can produce - so it is also the one place that records it to _orderHistory, rather than
    /// threading a second call through every individual call site. Recorded BEFORE the Telegram
    /// send (and regardless of whether that send succeeds) so the Triggers page's order history
    /// never depends on Telegram actually being configured or reachable - the whole point of
    /// persisting this at all is to have an answer even when that message was never seen.</summary>
    private async Task NotifyFollowUpAsync(StrategyTrigger trigger, string body, CancellationToken cancellationToken)
    {
        _orderHistory.Record(trigger.Id, trigger.Name, body);

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

    /// <summary>ReferencePrice is the entry price every other number here was derived from - the
    /// simulator's resolved fill, or the live premium when StrategyTrigger.UseLivePremiumEntry is
    /// on. MonitorFillAsync measures its deviation guard against THIS rather than the trade's own
    /// EntryPrice, which is null in live-premium mode. InstrumentSecurityId is the SAME contract as
    /// SecurityId, just as the uint DhanMarketFeedClient.LastTickFor wants rather than the string
    /// Dhan's REST order API wants - MonitorFillAsync uses it to read this contract's live best
    /// bid/ask off the feed when re-pricing an unfilled retry.</summary>
    private sealed record SuperOrderPlan(
        string TransactionType, string SecurityId, uint InstrumentSecurityId, int Quantity,
        decimal Price, decimal TargetPrice, decimal StopLossPrice, decimal TickSize,
        decimal ReferencePrice, string CorrelationId, string Summary, DateOnly Expiry, string DhanSegment,
        int LotSize);

    // ---- Exchange freeze-limit slicing -----------------------------------------------------

    /// <summary>NSE/BSE's exchange freeze quantity per underlying - the ceiling a SINGLE order's
    /// own quantity may not exceed before the exchange rejects it outright. Anything above this
    /// must be split into multiple orders - the same "auto-slice" every major broker's own API
    /// already offers (Zerodha's Kite Connect calls it autoslice, capping at 10 slices and
    /// returning a separate order id per slice; Dhan's own POST /orders/slicing does the identical
    /// thing for a PLAIN order). Dhan's Super Order does NOT support this natively - confirmed
    /// against its own API reference, which lists no disclosedQuantity or slicing parameter on
    /// that endpoint - so every quantity this app ever sends to Dhan, Super Order or plain, is
    /// sliced client-side against this table before being placed, mirroring what a broker's own
    /// autoslice does rather than depending on an endpoint that does not cover the order type this
    /// app actually places for its entries.
    ///
    /// Exchange-published, not account-specific, and revised occasionally by NSE/BSE circulars -
    /// update the numbers here when they do rather than waiting for a rejected live order to
    /// reveal it.</summary>
    private static readonly Dictionary<string, int> FreezeQuantityByUnderlying = new(StringComparer.OrdinalIgnoreCase)
    {
        ["NIFTY"] = 1800,
        ["BANKNIFTY"] = 600,
        ["SENSEX"] = 1000,
    };

    /// <summary>The freeze ceiling for an underlying this app does not (yet) have a published
    /// figure for. int.MaxValue rather than a guess - SliceQuantity then never slices, which is
    /// the same "unsliced, single order" behaviour every quantity had before this existed, so an
    /// underlying missing from the table fails exactly the way it always would have: at the
    /// exchange, with Dhan's own rejection message, rather than this app silently mis-slicing it
    /// against a made-up number.</summary>
    private static int FreezeQuantityFor(string underlying) =>
        FreezeQuantityByUnderlying.TryGetValue(underlying, out var limit) ? limit : int.MaxValue;

    /// <summary>Splits <paramref name="totalQuantity"/> into the fewest slices that each stay at or
    /// under <paramref name="freezeLimit"/> AND are a whole multiple of <paramref name="lotSize"/> -
    /// an F&amp;O quantity is only ever valid in whole lots, so slicing at the raw-quantity level
    /// could produce a slice that respects the ceiling but is itself an invalid order. Slicing is
    /// therefore done in LOTS: at most floor(freezeLimit / lotSize) lots per slice, every slice but
    /// the last carrying exactly that many, the last carrying whatever remains.
    ///
    /// A single slice - the original, entirely unchanged quantity - is returned whenever nothing
    /// actually needs splitting: <paramref name="totalQuantity"/> already at or under the limit,
    /// or a non-positive/invalid lot size or freeze limit (a misconfiguration this defers to Dhan's
    /// own rejection to reveal, rather than looping forever or throwing here).
    ///
    /// Internal for direct unit testing: this is pure arithmetic with no live Dhan/CDV state behind
    /// it, unlike almost everything else in this class.</summary>
    internal static IReadOnlyList<int> SliceQuantity(int totalQuantity, int lotSize, int freezeLimit)
    {
        if (totalQuantity <= 0 || lotSize <= 0 || totalQuantity <= freezeLimit) return new[] { totalQuantity };

        var maxLotsPerSlice = freezeLimit / lotSize;
        if (maxLotsPerSlice <= 0) return new[] { totalQuantity };

        var remainingLots = totalQuantity / lotSize;
        var slices = new List<int>();
        while (remainingLots > 0)
        {
            var lots = Math.Min(maxLotsPerSlice, remainingLots);
            slices.Add(lots * lotSize);
            remainingLots -= lots;
        }
        return slices;
    }

    /// <summary>Pacing between two slices of the SAME logical order - short, since these are not
    /// rate-limited the way a history fetch is; just enough that a burst of otherwise-identical
    /// placements does not land in the same instant.</summary>
    private static readonly TimeSpan SliceCallDelay = TimeSpan.FromMilliseconds(300);
}

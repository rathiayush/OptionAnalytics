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
        DhanSuperOrderClient superOrders, IHubContext<SpotHub> hub, ILogger<StrategyTriggerHostedService> logger)
    {
        _store = store;
        _backtest = backtest;
        _telegram = telegram;
        _spotFeed = spotFeed;
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

    private async Task NotifyAsync(StrategyTrigger trigger, BacktestTrade trade, string? reason, CancellationToken cancellationToken)
    {
        var arrow = trade.Direction == "Bullish" ? "▲" : "▼";
        var reasonLine = reason is null ? "" : $"\n{reason}";
        var ist = TimeSpan.FromHours(5.5);

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
                var (plan, skipReason) = await BuildOrderPlanAsync(trigger, trade, cancellationToken);
                if (plan is null)
                {
                    await NotifyFollowUpAsync(trigger,
                        $"[NO ORDER PLACED] Live trading is on, but this signal could not be turned into an order - {skipReason}. Nothing is working at the broker for it.",
                        cancellationToken);
                    return;
                }

                if (!_telegram.IsConfigured)
                {
                    _logger.LogWarning(
                        "Trigger {Name}: a REAL order was placed but Telegram is not configured (Telegram:Enabled/BotToken/ChatId) - no notification will be sent for it or for its fill.",
                        trigger.Name);
                }

                var statusLine = await PlaceOrderAsync(trigger, trade, plan, cancellationToken);
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
    private async Task<(SuperOrderPlan? Plan, string? SkipReason)> BuildOrderPlanAsync(StrategyTrigger trigger, BacktestTrade trade, CancellationToken cancellationToken)
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
            return (null, $"no expiry is currently tracked for {trade.Underlying}");
        }

        var contract = _optionChainMaster.Find(trade.Underlying, expiry.Value, trade.Strike, isCall);
        if (contract is null)
        {
            // "Not listed" is the one skip reason that is usually a symptom rather than a fact -
            // a stale scrip master, or a row the parser dropped - so it logs what IS listed nearby.
            var nearby = _optionChainMaster.DescribeNearestListed(trade.Underlying, expiry.Value, trade.Strike, isCall);
            _logger.LogWarning("Trigger {Name}: {Underlying} {Strike}{Type} not found on expiry {Expiry} - cannot place order. {Nearby}",
                trigger.Name, trade.Underlying, trade.Strike, trade.OptionType, expiry.Value, nearby);
            return (null, $"{trade.Strike:0.##}{trade.OptionType} is not listed on the {expiry.Value:dd MMM yyyy} expiry ({nearby})");
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
                return (null, $"no live premium available for {trade.Strike:0.##}{trade.OptionType} on the {expiry.Value:dd MMM yyyy} expiry");
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
            return (null, "the trade has no resolved entry price yet");
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

        var expiryNote = isForeignExpiry ? $"\nExpiry {expiry.Value:dd MMM yyyy} (pinned - NOT the tracked expiry; priced off its own live quote)" : "";
        var summary = $"{transactionType} {contract.TradingSymbol} x{quantity} (SecurityId {contract.SecurityId})\n" +
            $"LIMIT {limitPrice:0.##} · Target {targetPrice:0.##} · SL {stopLossPrice:0.##}" + expiryNote;

        return (new SuperOrderPlan(transactionType, contract.SecurityId.ToString(), quantity, limitPrice, targetPrice, stopLossPrice, tick, entryPrice, correlationId, summary, expiry.Value), null);
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
    /// out - that alert is sent independently and earlier by NotifyAsync regardless.</summary>
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

                // A real order is live and nothing is watching it any more. That has to reach the
                // phone, not just the log - it is the one state this whole retry loop exists to
                // prevent. CancellationToken.None so a shutdown-time crash still gets the message
                // out rather than cancelling the very notification about it.
                await NotifyFollowUpAsync(trigger,
                    $"[ORDER UNMONITORED] {plan.Summary}\nDhan order {result.OrderId}\nFill-monitoring crashed - the order may still be resting or filled. CHECK DHAN DIRECTLY.",
                    CancellationToken.None);
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

            var latestPrice = await GetOrderPremiumAsync(trade.Underlying, plan.Expiry, plan.Expiry, trade.Strike, isCall, cancellationToken);
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
            // same way. A fully-unfilled order keeps the trigger's own configured slippage unchanged.
            var slippage = isPartial ? trigger.SlippagePoints * (1 + partialFillRetries) : trigger.SlippagePoints;
            var rawPrice = Math.Max(0, isSell ? latestPrice.Value - slippage : latestPrice.Value + slippage);
            var newPrice = RoundToTick(rawPrice, plan.TickSize);
            // ENTRY_LEG's own quantity field is the order's remaining WORKING quantity, not a delta -
            // see DhanSuperOrderClient's own doc comment on ModifyAsync. Re-quoting it down to just
            // what's left to fill (rather than leaving it at the original total) is what stops this
            // from silently trying to buy/sell MORE than the trigger was ever configured for.
            var newQuantity = isPartial ? remainingQuantity : (int?)null;

            var modifyResult = await _superOrders.ModifyAsync(orderId, "ENTRY_LEG", orderType: null, quantity: newQuantity,
                price: newPrice, targetPrice: null, stopLossPrice: null, trailingJump: null, cancellationToken);
            if (modifyResult is null)
            {
                _logger.LogWarning("Trigger {Name}: re-price MODIFY failed for order {OrderId} on attempt {Attempt}/{Max} - will check again.",
                    trigger.Name, orderId, attempt, MaxFillAttempts);
                continue;
            }

            currentPrice = newPrice;
            _logger.LogInformation("Trigger {Name}: re-priced order {OrderId} to {Price:0.##} for {Quantity} (attempt {Attempt}/{Max}, live premium {Live:0.##}, slippage {Slippage:0.##}).",
                trigger.Name, orderId, newPrice, remainingQuantity == 0 ? plan.Quantity : remainingQuantity, attempt + 1, MaxFillAttempts, latestPrice, slippage);
        }
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

    /// <summary>ReferencePrice is the entry price every other number here was derived from - the
    /// simulator's resolved fill, or the live premium when StrategyTrigger.UseLivePremiumEntry is
    /// on. MonitorFillAsync measures its deviation guard against THIS rather than the trade's own
    /// EntryPrice, which is null in live-premium mode.</summary>
    private sealed record SuperOrderPlan(
        string TransactionType, string SecurityId, int Quantity,
        decimal Price, decimal TargetPrice, decimal StopLossPrice, decimal TickSize,
        decimal ReferencePrice, string CorrelationId, string Summary, DateOnly Expiry);
}

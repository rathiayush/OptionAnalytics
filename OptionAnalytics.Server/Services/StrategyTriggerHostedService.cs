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
/// LiveTradingEnabled triggers ALSO get a Dhan Super Order built from the fired trade - see
/// BuildOrderPreview for exactly how the strategy's points-based SL/TP and this trigger's own
/// quantity/slippage become the absolute prices and lot-multiplied quantity Dhan's API wants.
/// DRY RUN ONLY for now, deliberately: the order is computed and logged (and shown in the Telegram
/// message, tagged [DRY RUN]) but DhanSuperOrderClient.PlaceAsync is never called. Nothing in this
/// class currently sends a real order - that wiring is a separate, explicit step once dry-run
/// output has been checked against enough real trigger firings to trust the numbers.
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
    /// fills immediately in practice (see BuildOrderPreview).</summary>
    private const string OrderType = "LIMIT";

    private readonly StrategyTriggerStore _store;
    private readonly BacktestService _backtest;
    private readonly TelegramAlertService _telegram;
    private readonly CdvHostedService _cdv;
    private readonly DhanOptionChainMaster _optionChainMaster;
    private readonly IHubContext<SpotHub> _hub;
    private readonly ILogger<StrategyTriggerHostedService> _logger;

    public StrategyTriggerHostedService(
        StrategyTriggerStore store, BacktestService backtest, TelegramAlertService telegram,
        CdvHostedService cdv, DhanOptionChainMaster optionChainMaster,
        IHubContext<SpotHub> hub, ILogger<StrategyTriggerHostedService> logger)
    {
        _store = store;
        _backtest = backtest;
        _telegram = telegram;
        _cdv = cdv;
        _optionChainMaster = optionChainMaster;
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

        var orderPreview = trigger.LiveTradingEnabled ? BuildOrderPreview(trigger, trade) : null;
        var orderLine = orderPreview is null ? "" : $"\n\n{orderPreview.TelegramLine}";

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
        if (orderPreview is not null)
        {
            _logger.LogInformation(
                "Trigger {Name} [DRY RUN] would place: {Transaction} {Segment}:{SecurityId} qty={Qty} LIMIT={Price} target={Target} stopLoss={StopLoss} correlationId={CorrelationId}",
                trigger.Name, orderPreview.TransactionType, "NSE_FNO", orderPreview.SecurityId, orderPreview.Quantity,
                orderPreview.Price, orderPreview.TargetPrice, orderPreview.StopLossPrice, orderPreview.CorrelationId);
        }

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

    /// <summary>Turns a fired trade into the exact Dhan Super Order it would produce - DRY RUN only
    /// (see this class's own doc comment); nothing here calls DhanSuperOrderClient. Null when the
    /// contract can't be resolved (no expiry currently tracked for this underlying, or that exact
    /// strike/side isn't in the scrip master), which is logged and simply skips the preview rather
    /// than failing the whole notification - the Telegram/dashboard alert still goes out either way.
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
    private SuperOrderPreview? BuildOrderPreview(StrategyTrigger trigger, BacktestTrade trade)
    {
        if (trade.EntryPrice is not { } entryPrice) return null; // shouldn't happen - EvaluateAsync only calls this for trades with a resolved entry

        var expiry = _cdv.States.TryGetValue(trade.Underlying, out var cdvState) ? cdvState.Expiry : null;
        if (expiry is null)
        {
            _logger.LogWarning("Trigger {Name}: no currently-tracked expiry for {Underlying} - skipping order preview.", trigger.Name, trade.Underlying);
            return null;
        }

        var isCall = trade.OptionType == "CE";
        var contract = _optionChainMaster.Find(trade.Underlying, expiry.Value, trade.Strike, isCall);
        if (contract is null)
        {
            _logger.LogWarning("Trigger {Name}: {Underlying} {Strike}{Type} not found on expiry {Expiry} - skipping order preview.",
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

        var telegramLine =
            $"[DRY RUN] Super Order: {transactionType} {contract.TradingSymbol} x{quantity} (SecurityId {contract.SecurityId})\n" +
            $"LIMIT {limitPrice:0.##} · Target {targetPrice:0.##} · SL {stopLossPrice:0.##}";

        return new SuperOrderPreview(transactionType, contract.SecurityId.ToString(), quantity, limitPrice, targetPrice, stopLossPrice, correlationId, telegramLine);
    }

    private static decimal RoundToTick(decimal price, decimal tick) =>
        tick > 0 ? Math.Round(price / tick, MidpointRounding.AwayFromZero) * tick : price;

    private sealed record SuperOrderPreview(
        string TransactionType, string SecurityId, int Quantity,
        decimal Price, decimal TargetPrice, decimal StopLossPrice,
        string CorrelationId, string TelegramLine);
}

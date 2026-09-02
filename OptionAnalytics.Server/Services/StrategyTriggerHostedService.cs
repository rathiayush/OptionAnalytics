using Microsoft.AspNetCore.SignalR;
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
/// A signal whose strike was never tracked (BacktestTrade.NoData) advances the watermark like any
/// other event - re-alerting on the same unfillable signal forever would be its own kind of noise -
/// but is never sent to Telegram, since there is nothing a user could actually act on.
///
/// Arming a trigger never floods: the first evaluation only records where the strategy currently
/// stands, without alerting. Only trades opening after that notify. The same priming happens if a
/// trigger has been disabled for a while and is switched back on, so a re-enabled trigger doesn't
/// replay everything it missed.
/// </summary>
public sealed class StrategyTriggerHostedService : BackgroundService
{
    /// <summary>How often to re-evaluate. Signals only change when a bar closes (a minute at the
    /// finest timeframe), so polling faster than this would just repeat identical work.</summary>
    private static readonly TimeSpan EvaluationInterval = TimeSpan.FromSeconds(30);

    /// <summary>Let the feeds backfill and the first bars close before the first evaluation -
    /// evaluating against a half-loaded history would prime triggers at the wrong point.</summary>
    private static readonly TimeSpan StartupDelay = TimeSpan.FromMinutes(1);

    private readonly StrategyTriggerStore _store;
    private readonly BacktestService _backtest;
    private readonly TelegramAlertService _telegram;
    private readonly IHubContext<SpotHub> _hub;
    private readonly ILogger<StrategyTriggerHostedService> _logger;

    public StrategyTriggerHostedService(
        StrategyTriggerStore store, BacktestService backtest, TelegramAlertService telegram,
        IHubContext<SpotHub> hub, ILogger<StrategyTriggerHostedService> logger)
    {
        _store = store;
        _backtest = backtest;
        _telegram = telegram;
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

        var latest = trades[^1];

        if (trigger.LastSignalUtc is not { } lastSeen)
        {
            // First look at this trigger - remember where things stand, alert on nothing.
            _store.MarkEvaluated(trigger.Id, latest.SignalTimeUtc, firedSummary: null);
            _logger.LogInformation("Trigger {Name} armed at {Time:u} - future trades will notify.", trigger.Name, latest.SignalTimeUtc);
            return;
        }

        var fresh = trades.Where(t => t.SignalTimeUtc > lastSeen).ToList();
        if (fresh.Count == 0) return;

        // NoData rows (the signal's strike was never tracked) still move the watermark past - see
        // this class's own doc comment - but there is no fillable trade to tell the user about.
        var tradable = fresh.Where(t => t.EntryTimeUtc is not null).ToList();

        if (tradable.Count > 0)
        {
            // The strategy's own EntrySignals carries the human-readable WHY ("Spot crossed down +
            // ATM PE confirmed + ...") that BacktestTrade doesn't - matched back by time+direction
            // so the alert explains the reasoning, not just the strike/side RunStrategy decided on.
            var reasons = _backtest.ReplayForStrategy(trigger.Underlying, trigger.StrategyKey, trigger.TimeframeMinutes, trigger.Parameters)
                .Where(s => s.Kind is "Entry" or "Confluence")
                .ToDictionary(s => (s.TimeUtc, s.Direction), s => s.Summary);

            foreach (var trade in tradable)
            {
                reasons.TryGetValue((trade.SignalTimeUtc, trade.Direction), out var reason);
                await NotifyAsync(trigger, trade, reason, cancellationToken);
            }
        }

        _store.MarkEvaluated(trigger.Id, latest.SignalTimeUtc, firedSummary: tradable.Count > 0 ? Describe(tradable[^1]) : null);
    }

    private static string Describe(BacktestTrade trade) =>
        $"{trade.Side} {trade.OptionType} {trade.Strike:0.##}";

    private async Task NotifyAsync(StrategyTrigger trigger, BacktestTrade trade, string? reason, CancellationToken cancellationToken)
    {
        var arrow = trade.Direction == "Bullish" ? "▲" : "▼";
        var reasonLine = reason is null ? "" : $"\n{reason}";
        var message =
            $"<b>{arrow} {trigger.Name}</b>\n" +
            $"<b>{trade.Underlying}</b> · {trigger.TimeframeMinutes}m · {trigger.StrategyKey}\n" +
            $"<b>{trade.Direction}</b> — {trade.Side} {trade.OptionType} {trade.Strike:0.##}{reasonLine}\n" +
            $"Bar: {trade.SignalTimeUtc.ToOffset(TimeSpan.FromHours(5.5)):yyyy-MM-dd HH:mm} IST";

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
}

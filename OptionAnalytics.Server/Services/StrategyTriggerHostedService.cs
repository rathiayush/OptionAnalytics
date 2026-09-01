using Microsoft.AspNetCore.SignalR;
using OptionAnalytics.Server.Hubs;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Telegram;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Watches every enabled StrategyTrigger and sends a Telegram message when its strategy produces a
/// NEW entry signal.
///
/// It re-runs the very same BacktestService.ReplayForStrategy the Backtrack page uses, on an
/// interval, and compares the newest entry signal against the one the trigger last saw. That reuse
/// is the whole point: a rule tuned on the Backtrack page fires live off identical code, so what
/// was backtested is what gets alerted - there is no second, subtly-different live implementation
/// to drift out of sync with it.
///
/// Arming a trigger never floods: the first evaluation only records where the strategy currently
/// stands, without alerting. Only signals appearing after that notify. The same priming happens if
/// a trigger has been disabled for a while and is switched back on, so a re-enabled trigger doesn't
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
        var signals = _backtest.ReplayForStrategy(trigger.Underlying, trigger.StrategyKey, trigger.TimeframeMinutes, trigger.Parameters);

        // Only signals the strategy would actually have traded - a strategy that also reports its
        // rejections (see EmaSurgeStrategy) must not alert on those.
        var entries = signals
            .Where(s => s.Kind is "Entry" or "Confluence")
            .OrderBy(s => s.TimeUtc)
            .ToList();

        if (entries.Count == 0) return;

        var latest = entries[^1];

        if (trigger.LastSignalUtc is not { } lastSeen)
        {
            // First look at this trigger - remember where things stand, alert on nothing.
            _store.MarkEvaluated(trigger.Id, latest.TimeUtc, firedSummary: null);
            _logger.LogInformation("Trigger {Name} armed at {Time:u} - future signals will notify.", trigger.Name, latest.TimeUtc);
            return;
        }

        var fresh = entries.Where(s => s.TimeUtc > lastSeen).ToList();
        if (fresh.Count == 0) return;

        foreach (var signal in fresh)
        {
            await NotifyAsync(trigger, signal, cancellationToken);
        }

        _store.MarkEvaluated(trigger.Id, latest.TimeUtc, firedSummary: fresh[^1].Summary);
    }

    private async Task NotifyAsync(StrategyTrigger trigger, BacktestSignal signal, CancellationToken cancellationToken)
    {
        var arrow = signal.Direction == "Bullish" ? "▲" : "▼";
        var message =
            $"<b>{arrow} {trigger.Name}</b>\n" +
            $"<b>{signal.Underlying}</b> · {trigger.TimeframeMinutes}m · {trigger.StrategyKey}\n" +
            $"<b>{signal.Direction}</b> — {signal.Summary}\n" +
            $"Bar: {signal.TimeUtc.ToOffset(TimeSpan.FromHours(5.5)):yyyy-MM-dd HH:mm} IST";

        _logger.LogInformation("Trigger {Name} fired: {Direction} {Summary}", trigger.Name, signal.Direction, signal.Summary);

        await _telegram.SendAsync(message, cancellationToken);

        // Also push it to any open dashboard, reusing the alert feed the page already renders.
        try
        {
            var alert = new ConfluenceAlert(signal.Underlying, DateTimeOffset.UtcNow, "Confluence", signal.Direction, 0, null, message);
            await _hub.Clients.All.SendAsync("confluenceAlert", alert, cancellationToken);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Could not broadcast trigger {Name} to the dashboard.", trigger.Name);
        }
    }
}

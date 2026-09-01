using OptionAnalytics.Server.Telegram;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Watches every underlying's closed-bar series for an EMA 9/21 crossover and sends a Telegram
/// alert the moment one happens - the server-side counterpart to the EMA overlay the spot chart
/// already draws client-side (App.jsx's useEmaCrossover), so an alert fires even with nobody
/// looking at the page. Reacts to SpotUnderlyingState.BarClosed rather than polling: an alert is
/// only meaningful the instant a bar actually finishes, and computing off a still-forming bar
/// would flip-flop as its price kept moving.
///
/// The crossover check itself is EmaCrossoverDetector (Skender.Stock.Indicators under the hood,
/// not hand-rolled math), shared with ConfluenceAlertService's ATM CE/PE side of the same check.
/// </summary>
public sealed class EmaCrossoverAlertService : BackgroundService
{
    private readonly SpotFeedHostedService _spotFeed;
    private readonly TelegramAlertService _telegram;
    private readonly ILogger<EmaCrossoverAlertService> _logger;

    // Guards against alerting twice for the same bar - BarClosed could in principle fire more
    // than once for the same underlying in pathological cases (e.g. a reconnect replaying a bar
    // boundary); tracking the last alerted bar time makes that a no-op rather than a duplicate
    // Telegram message.
    private readonly Dictionary<string, DateTimeOffset> _lastAlertedBarTime = new();

    public EmaCrossoverAlertService(SpotFeedHostedService spotFeed, TelegramAlertService telegram, ILogger<EmaCrossoverAlertService> logger)
    {
        _spotFeed = spotFeed;
        _telegram = telegram;
        _logger = logger;
    }

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        foreach (var state in _spotFeed.States.Values)
        {
            var underlyingState = state; // local copy - one per loop iteration, safe to capture
            underlyingState.BarClosed += _ => OnBarClosed(underlyingState, stoppingToken);
        }

        return Task.CompletedTask;
    }

    private void OnBarClosed(SpotUnderlyingState state, CancellationToken cancellationToken)
    {
        var closedBars = state.GetClosedCandles();
        var direction = EmaCrossoverDetector.Detect(closedBars);
        if (direction is null) return;

        var last = closedBars[^1];
        if (_lastAlertedBarTime.TryGetValue(state.Underlying, out var alerted) && alerted == last.Time) return;
        _lastAlertedBarTime[state.Underlying] = last.Time;

        var detail = direction == "Bullish" ? "Bullish - EMA9 crossed above EMA21" : "Bearish - EMA9 crossed below EMA21";
        var message = $"<b>{state.Underlying}</b> EMA 9/21 crossover\n{detail}\nClose: {last.Close:N2}\nBar: {last.Time:yyyy-MM-dd HH:mm} UTC";
        _logger.LogInformation("EMA 9/21 crossover for {Underlying}: {Direction} at close {Close}.", state.Underlying, detail, last.Close);
        _ = _telegram.SendAsync(message, cancellationToken);
    }
}

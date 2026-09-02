using OptionAnalytics.Server.Telegram;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Watches every underlying's closed-bar series for a CONFIRMED EMA 9/21 direction change and
/// sends a Telegram alert the moment one happens - the server-side counterpart to the EMA overlay
/// the spot chart already draws client-side (App.jsx's useEmaCrossover), so an alert fires even
/// with nobody looking at the page. Reacts to SpotUnderlyingState.BarClosed rather than polling: an
/// alert is only meaningful the instant a bar actually finishes, and computing off a still-forming
/// bar would flip-flop as its price kept moving.
///
/// The check itself is EmaCrossoverDetector.ConfirmedDirection (Skender.Stock.Indicators under the
/// hood, not hand-rolled math), shared with ConfluenceAlertService's three legs - see that method's
/// own doc comment for why requiring the bar's CLOSE to have actually finished beyond both EMAs
/// (not just the EMA9-vs-EMA21 relationship flipping) matters: without it, a flat/choppy stretch
/// where the two lines sit almost on top of each other would alert on every noisy tick that swaps
/// their order, even though nothing directional happened - exactly the "signal but the chart shows
/// nothing" complaint this replaced the plain crossover check to fix.
/// </summary>
public sealed class EmaCrossoverAlertService : BackgroundService
{
    private readonly SpotFeedHostedService _spotFeed;
    private readonly TelegramAlertService _telegram;
    private readonly ILogger<EmaCrossoverAlertService> _logger;

    // The last CONFIRMED direction alerted for each underlying - alerting only when this changes
    // (rather than the old "same bar twice" time check) both dedups a repeated bar-close event AND
    // is what makes the confirmed-close rule actually quiet during chop: ConfirmedDirection can
    // return null for many consecutive bars while price sits between the two EMAs without ever
    // confirming either way, and this dictionary just keeps holding whatever direction last
    // genuinely confirmed until a new one does.
    private readonly Dictionary<string, string> _lastDirection = new();

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
            // Seed from whatever backfilled/already-closed history exists right now, silently -
            // this is catching up to already-known history on startup, not a live change worth
            // alerting on (same reasoning as ConfluenceAlertService's own initial seed pass).
            SeedDirection(underlyingState);
            underlyingState.BarClosed += _ => OnBarClosed(underlyingState, stoppingToken);
        }

        return Task.CompletedTask;
    }

    private void SeedDirection(SpotUnderlyingState state)
    {
        var direction = EmaCrossoverDetector.ConfirmedDirection(state.GetClosedCandles());
        if (direction is not null) _lastDirection[state.Underlying] = direction;
    }

    private void OnBarClosed(SpotUnderlyingState state, CancellationToken cancellationToken)
    {
        var closedBars = state.GetClosedCandles();
        var direction = EmaCrossoverDetector.ConfirmedDirection(closedBars);
        // Not enough bars, an exact EMA tie, or the bias hasn't been confirmed by a close beyond
        // both EMAs yet - stay quiet and keep whatever was last confirmed.
        if (direction is null) return;
        if (_lastDirection.TryGetValue(state.Underlying, out var previous) && previous == direction) return;
        _lastDirection[state.Underlying] = direction;

        var last = closedBars[^1];
        var detail = direction == "Bullish" ? "Bullish - closed above EMA9/21" : "Bearish - closed below EMA9/21";
        // [Spot EMA] up front - this fires on the SPOT leg alone, every time it confirms a new
        // direction, for both underlyings, with no strategy logic behind it. In the same Telegram
        // chat as Confluence alerts and armed Strategy Triggers, a message needs to say which of
        // the three it is before you read past the first line, since a push notification preview
        // only shows that.
        var message = $"[Spot EMA] <b>{state.Underlying}</b> EMA 9/21 crossover\n{detail}\nClose: {last.Close:N2}\nBar: {last.Time:yyyy-MM-dd HH:mm} UTC";
        _logger.LogInformation("EMA 9/21 confirmed direction for {Underlying}: {Direction} at close {Close}.", state.Underlying, direction, last.Close);
        _ = _telegram.SendAsync(message, cancellationToken);
    }
}

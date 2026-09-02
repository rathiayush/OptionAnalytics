using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Telegram;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Watches every underlying's candle series for a CONFIRMED EMA 9/21 direction change and sends a
/// Telegram alert the moment one happens - the server-side counterpart to the EMA overlay the spot
/// chart already draws client-side (App.jsx's useEmaCrossover), so an alert fires even with nobody
/// looking at the page.
///
/// Two evaluation paths, BOTH always wired up:
///   1. Closed-and-confirmed (the reliable baseline, unconditional): reacts to
///      SpotUnderlyingState.BarClosed - an alert off a CLOSED bar is only meaningful the instant it
///      actually finishes, and computing off a still-forming bar would flip-flop as its price kept
///      moving.
///   2. Live (only when AlertModeStore.IsLive): a short periodic re-check of the STILL-FORMING
///      candle, additive to path 1, never a replacement for it - see AlertModeStore's own doc
///      comment for why. A reversal before that candle closes just produces a new alert once path 1
///      catches up; both paths share the same "alert only when the confirmed direction actually
///      changed" dedup, so switching AlertModeStore mid-session can't double-fire for a direction
///      already announced.
///
/// The check itself is EmaCrossoverDetector.ConfirmedDirection (Skender.Stock.Indicators under the
/// hood, not hand-rolled math), shared with ConfluenceAlertService's three legs - see that method's
/// own doc comment for why requiring the bar's CLOSE to have actually finished beyond both EMAs
/// (not just the EMA9-vs-EMA21 relationship flipping) matters: without it, a flat/choppy stretch
/// where the two lines sit almost on top of each other would alert on every noisy tick that swaps
/// their order, even though nothing directional happened.
/// </summary>
public sealed class EmaCrossoverAlertService : BackgroundService
{
    /// <summary>How often the Live path re-checks the still-forming candle. Frequent enough to feel
    /// live, infrequent enough that recomputing EMA9/21 over a multi-day series for both
    /// underlyings on every tick would be wasted work for no real benefit - a price move worth
    /// alerting on is not going to happen and reverse within a few seconds unnoticed.</summary>
    private static readonly TimeSpan LiveCheckInterval = TimeSpan.FromSeconds(10);

    private readonly SpotFeedHostedService _spotFeed;
    private readonly TelegramAlertService _telegram;
    private readonly AlertModeStore _alertMode;
    private readonly ILogger<EmaCrossoverAlertService> _logger;

    // The last CONFIRMED direction alerted for each underlying, shared by both paths - alerting
    // only when this changes both dedups a repeated bar-close event AND is what makes the
    // confirmed-close rule actually quiet during chop: ConfirmedDirection can return null for many
    // consecutive bars while price sits between the two EMAs without ever confirming either way,
    // and this dictionary just keeps holding whatever direction last genuinely confirmed.
    private readonly Dictionary<string, string> _lastDirection = new();

    public EmaCrossoverAlertService(
        SpotFeedHostedService spotFeed, TelegramAlertService telegram, AlertModeStore alertMode, ILogger<EmaCrossoverAlertService> logger)
    {
        _spotFeed = spotFeed;
        _telegram = telegram;
        _alertMode = alertMode;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        foreach (var state in _spotFeed.States.Values)
        {
            var underlyingState = state; // local copy - one per loop iteration, safe to capture
            // Seed from whatever backfilled/already-closed history exists right now, silently -
            // this is catching up to already-known history on startup, not a live change worth
            // alerting on (same reasoning as ConfluenceAlertService's own initial seed pass).
            SeedDirection(underlyingState);
            underlyingState.BarClosed += _ => Evaluate(underlyingState, underlyingState.GetClosedCandles(), stoppingToken);
        }

        try
        {
            using var timer = new PeriodicTimer(LiveCheckInterval);
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                if (!_alertMode.IsLive) continue;
                foreach (var state in _spotFeed.States.Values)
                    Evaluate(state, state.GetCandles(), stoppingToken); // includes the still-forming bar
            }
        }
        catch (OperationCanceledException)
        {
            // Shutting down.
        }
    }

    private void SeedDirection(SpotUnderlyingState state)
    {
        var direction = EmaCrossoverDetector.ConfirmedDirection(state.GetClosedCandles());
        if (direction is not null) _lastDirection[state.Underlying] = direction;
    }

    private void Evaluate(SpotUnderlyingState state, IReadOnlyList<Candle> bars, CancellationToken cancellationToken)
    {
        var direction = EmaCrossoverDetector.ConfirmedDirection(bars);
        // Not enough bars, an exact EMA tie, or the bias hasn't been confirmed by a close beyond
        // both EMAs yet - stay quiet and keep whatever was last confirmed.
        if (direction is null) return;
        if (_lastDirection.TryGetValue(state.Underlying, out var previous) && previous == direction) return;
        _lastDirection[state.Underlying] = direction;

        var last = bars[^1];
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

using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Telegram;
using Skender.Stock.Indicators;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Watches every underlying's closed-bar series for an EMA 9/21 crossover and sends a Telegram
/// alert the moment one happens - the server-side counterpart to the EMA overlay the spot chart
/// already draws client-side (App.jsx's useEmaCrossover), so an alert fires even with nobody
/// looking at the page. Reacts to SpotUnderlyingState.BarClosed rather than polling: an alert is
/// only meaningful the instant a bar actually finishes, and computing off a still-forming bar
/// would flip-flop as its price kept moving.
///
/// EMA itself is computed by Skender.Stock.Indicators rather than hand-rolled math - a
/// well-tested, widely-used .NET technical-analysis library (the same "standard EMA" definition:
/// seeded from a plain SMA of the first `period` closes, then the usual exponential recurrence -
/// so results match the hand-rolled version this replaced), and it makes adding another indicator
/// (RSI, MACD, ...) later a one-line call instead of another custom implementation.
/// </summary>
public sealed class EmaCrossoverAlertService : BackgroundService
{
    private const int FastPeriod = 9;
    private const int SlowPeriod = 21;

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
        // Need at least one prior bar beyond the slow EMA's own seed window, so there is a
        // previous EMA9/EMA21 pair to compare the new one against.
        if (closedBars.Count < SlowPeriod + 1) return;

        var quotes = closedBars.Select(c => new Quote
        {
            Date = c.Time.UtcDateTime,
            Open = c.Open,
            High = c.High,
            Low = c.Low,
            Close = c.Close,
            Volume = 0,
        }).ToList();

        var ema9 = quotes.GetEma(FastPeriod).ToList();
        var ema21 = quotes.GetEma(SlowPeriod).ToList();

        var last = quotes.Count - 1;
        if (ema9[last].Ema is not { } fastNow || ema21[last].Ema is not { } slowNow) return;
        if (ema9[last - 1].Ema is not { } fastPrev || ema21[last - 1].Ema is not { } slowPrev) return;

        var prevDiff = fastPrev - slowPrev;
        var currDiff = fastNow - slowNow;

        string? direction = prevDiff <= 0 && currDiff > 0 ? "Bullish - EMA9 crossed above EMA21"
            : prevDiff >= 0 && currDiff < 0 ? "Bearish - EMA9 crossed below EMA21"
            : null;
        if (direction is null) return;

        var barTime = closedBars[last].Time;
        if (_lastAlertedBarTime.TryGetValue(state.Underlying, out var alerted) && alerted == barTime) return;
        _lastAlertedBarTime[state.Underlying] = barTime;

        var message = $"<b>{state.Underlying}</b> EMA 9/21 crossover\n{direction}\nClose: {closedBars[last].Close:N2}\nBar: {barTime:yyyy-MM-dd HH:mm} UTC";
        _logger.LogInformation("EMA 9/21 crossover for {Underlying}: {Direction} at close {Close}.", state.Underlying, direction, closedBars[last].Close);
        _ = _telegram.SendAsync(message, cancellationToken);
    }
}

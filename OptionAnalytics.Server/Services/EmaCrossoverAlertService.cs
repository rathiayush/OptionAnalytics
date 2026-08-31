using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Telegram;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Watches every underlying's closed-bar series for an EMA 9/21 crossover and sends a Telegram
/// alert the moment one happens - the server-side counterpart to the EMA overlay the spot chart
/// already draws client-side (App.jsx's useEmaCrossover), so an alert fires even with nobody
/// looking at the page. Reacts to SpotUnderlyingState.BarClosed rather than polling: an alert is
/// only meaningful the instant a bar actually finishes, and computing off a still-forming bar
/// would flip-flop as its price kept moving.
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

        var closes = closedBars.Select(c => c.Close).ToList();
        var ema9 = ComputeEma(closes, FastPeriod);
        var ema21 = ComputeEma(closes, SlowPeriod);

        var last = closes.Count - 1;
        if (ema9[last] is not { } fastNow || ema21[last] is not { } slowNow) return;
        if (ema9[last - 1] is not { } fastPrev || ema21[last - 1] is not { } slowPrev) return;

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

    /// <summary>Same EMA algorithm as the frontend's computeEma (App.jsx) - seeded with a plain
    /// average of the first `period` closes, then the usual exponential recurrence. One value per
    /// input bar, null before the seed window fills.</summary>
    private static decimal?[] ComputeEma(IReadOnlyList<decimal> closes, int period)
    {
        var result = new decimal?[closes.Count];
        if (closes.Count < period) return result;

        var k = 2m / (period + 1);
        decimal sum = 0;
        for (var i = 0; i < period; i++) sum += closes[i];
        var prev = sum / period;
        result[period - 1] = prev;

        for (var i = period; i < closes.Count; i++)
        {
            prev = closes[i] * k + prev * (1 - k);
            result[i] = prev;
        }
        return result;
    }
}

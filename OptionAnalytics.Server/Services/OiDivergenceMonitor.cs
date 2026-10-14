using Microsoft.AspNetCore.SignalR;
using OptionAnalytics.Server.Hubs;
using OptionAnalytics.Server.Telegram;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Sends an alert when price moves for several minutes but the OI at the nearest strike does not give
/// way (see PriceOiDivergence). Runs on the server, so it alerts with no browser open - OiReplayLiveFeedService
/// feeds it each nearest-expiry option leg's OI as it ticks (RecordOi), and every completed 1-minute spot
/// bar re-checks the underlying. Only completed minutes are read, and only OI seen up to the end of the
/// last of them - nothing later than the moment the alert is about.
///
/// A zone found is not sent at once: it waits until the ConfirmMinutes (5) completed minutes after it confirm it
/// (DivergenceGate / PriceOiDivergenceDetector.Confirm) and is dropped, unsent, when they do not. The confirmed alert
/// goes to Telegram and to every open page as "oiDivergenceAlert" (SpotHub); the OI Replay page shows it as a
/// notification. Once per zone per underlying inside the cool-down.
/// </summary>
public sealed class OiDivergenceMonitor : BackgroundService
{
    private readonly SpotFeedHostedService _spotFeed;
    private readonly TelegramAlertService _telegram;
    private readonly IHubContext<SpotHub> _hub;
    private readonly ILogger<OiDivergenceMonitor> _logger;
    private readonly DivergenceOptions _options;
    private readonly object _lock = new();
    private readonly OiMinuteBook _book = new();
    private readonly DivergenceGate _gate;
    private readonly LinkedList<PriceOiDivergence> _history = new();

    public OiDivergenceMonitor(SpotFeedHostedService spotFeed, TelegramAlertService telegram, IHubContext<SpotHub> hub,
        ILogger<OiDivergenceMonitor> logger, IConfiguration? configuration = null)
    {
        _spotFeed = spotFeed;
        _telegram = telegram;
        _hub = hub;
        _logger = logger;
        _options = configuration?.GetSection("OiDivergence").Get<DivergenceOptions>() ?? new DivergenceOptions();
        _gate = new DivergenceGate(_options);
    }

    public IReadOnlyList<PriceOiDivergence> Recent()
    {
        lock (_lock) return _history.ToList();
    }

    /// <summary>One option leg's OI as it ticks (the nearest listed expiry only).</summary>
    public void RecordOi(string underlying, string side, decimal strike, DateTimeOffset observedAt, long openInterest)
    {
        if (!_options.Enabled) return;
        _book.Record(underlying, side, strike, observedAt, openInterest);
    }

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.Enabled)
        {
            _logger.LogInformation("OI divergence alerts are turned off (OiDivergence:Enabled = false).");
            return Task.CompletedTask;
        }
        foreach (var (underlying, state) in _spotFeed.States)
        {
            var capturedUnderlying = underlying;
            var capturedState = state;
            capturedState.BarClosed += _ => Check(capturedUnderlying, capturedState, stoppingToken);
        }
        return Task.CompletedTask;
    }

    private void Check(string underlying, SpotUnderlyingState state, CancellationToken cancellationToken)
    {
        try
        {
            var closed = state.GetClosedCandles();
            long? OiAt(string side, decimal strike, long minute) => _book.At(underlying, side, strike, minute, _options.MaxCarryMinutes);
            var found = PriceOiDivergenceDetector.Evaluate(underlying, closed, state.Step, _book.Strikes(underlying), OiAt, _options);

            IReadOnlyList<PriceOiDivergence> alerts;
            lock (_lock)
            {
                var (sent, dropped) = _gate.OnBar(underlying, closed, OiAt, found);
                alerts = sent;
                foreach (var (zone, reason) in dropped)
                    _logger.LogInformation("OI divergence not confirmed, not sent: {Underlying} {Zone} zone at {Side} {Strike} - {Reason}", zone.Underlying, zone.Zone, zone.Side, zone.Strike, reason);
                foreach (var alert in alerts)
                {
                    _history.AddFirst(alert);
                    while (_history.Count > 50) _history.RemoveLast();
                }
            }
            if (found is not null && _options.ConfirmMinutes > 0)
                _logger.LogInformation("OI divergence found, confirming over {Minutes} min: {Message}", _options.ConfirmMinutes, found.Message);
            foreach (var alert in alerts)
            {
                _logger.LogInformation("OI divergence: {Message}", alert.Message);
                var confirmed = alert.ConfirmMinutes > 0 ? $" - confirmed after {alert.ConfirmMinutes} min" : "";
                if (_options.Telegram) _ = _telegram.SendAsync($"[OI divergence] <b>{alert.Underlying}</b> {alert.Zone.ToUpperInvariant()} zone{confirmed}\n{alert.Message}", cancellationToken);
                _ = BroadcastAsync(alert);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "OI divergence check for {Underlying} failed.", underlying);
        }
    }

    private async Task BroadcastAsync(PriceOiDivergence alert)
    {
        try { await _hub.Clients.All.SendAsync("oiDivergenceAlert", alert); }
        catch (Exception ex) { _logger.LogDebug(ex, "Failed to broadcast an OI divergence alert for {Underlying}.", alert.Underlying); }
    }
}

/// <summary>Each option leg's OI per minute (the last reading seen in the minute), a short rolling window
/// per (underlying, side, strike) - what the divergence check reads "OI as of the end of minute m" from.</summary>
public sealed class OiMinuteBook
{
    private const int KeepReadings = 40;
    private readonly object _lock = new();
    private readonly Dictionary<(string Underlying, string Side, decimal Strike), List<(long Minute, long Oi)>> _oi = new();

    public void Record(string underlying, string side, decimal strike, DateTimeOffset observedAt, long openInterest)
    {
        if (openInterest <= 0) return;
        var minute = observedAt.ToUnixTimeSeconds() / 60;
        lock (_lock)
        {
            if (!_oi.TryGetValue((underlying, side, strike), out var list)) _oi[(underlying, side, strike)] = list = new List<(long, long)>();
            if (list.Count > 0 && list[^1].Minute == minute) list[^1] = (minute, openInterest);
            else if (list.Count == 0 || list[^1].Minute < minute) list.Add((minute, openInterest));
            if (list.Count > KeepReadings) list.RemoveRange(0, list.Count - KeepReadings);
        }
    }

    /// <summary>OI as of the END of <paramref name="minute"/> (unix minutes): the last reading in or before it,
    /// and none older than <paramref name="maxCarryMinutes"/> (yesterday's last reading is not this morning's OI).</summary>
    public long? At(string underlying, string side, decimal strike, long minute, int maxCarryMinutes)
    {
        lock (_lock)
        {
            if (!_oi.TryGetValue((underlying, side, strike), out var list)) return null;
            for (var i = list.Count - 1; i >= 0; i--)
            {
                if (list[i].Minute > minute) continue;
                return minute - list[i].Minute <= maxCarryMinutes ? list[i].Oi : null;
            }
            return null;
        }
    }

    public IReadOnlyList<decimal> Strikes(string underlying)
    {
        lock (_lock) return _oi.Keys.Where(k => k.Underlying == underlying).Select(k => k.Strike).Distinct().ToList();
    }
}

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
/// Two reads, each once per zone per underlying inside its cool-down, both to every open page as "oiDivergenceAlert"
/// (SpotHub - the OI Replay page's popup): the 1-MINUTE one ("OiDivergence": three closes in a row) and the 15-MINUTE
/// one ("OiDivergence15m": the last completed 15-minute candle - checked as each one completes). Only the 15-minute one
/// goes to TELEGRAM (asked for - "only send signal for 15 min divergence"): each read's own `Telegram` switch, off for
/// the 1-minute one by default.
/// </summary>
public sealed class OiDivergenceMonitor : BackgroundService
{
    private readonly SpotFeedHostedService _spotFeed;
    private readonly TelegramAlertService _telegram;
    private readonly IHubContext<SpotHub> _hub;
    private readonly ILogger<OiDivergenceMonitor> _logger;
    private readonly DivergenceOptions _options;
    private readonly DivergenceOptions _options15;
    private readonly object _lock = new();
    private readonly OiMinuteBook _book = new();
    private readonly Dictionary<(string Underlying, string Zone, int BarMinutes), DateTimeOffset> _lastAlert = new();
    private readonly LinkedList<PriceOiDivergence> _history = new();

    public OiDivergenceMonitor(SpotFeedHostedService spotFeed, TelegramAlertService telegram, IHubContext<SpotHub> hub,
        ILogger<OiDivergenceMonitor> logger, IConfiguration? configuration = null)
    {
        _spotFeed = spotFeed;
        _telegram = telegram;
        _hub = hub;
        _logger = logger;
        _options = configuration?.GetSection("OiDivergence").Get<DivergenceOptions>() ?? new DivergenceOptions();
        _options15 = FifteenMinuteOptions(configuration);
    }

    /// <summary>The 15-minute read's settings: its defaults with whatever "OiDivergence15m" sets over them.</summary>
    internal static DivergenceOptions FifteenMinuteOptions(IConfiguration? configuration)
    {
        var options = DivergenceOptions.FifteenMinuteDefaults();
        configuration?.GetSection("OiDivergence15m").Bind(options);
        return options;
    }

    /// <summary>The Telegram text: "[OI divergence 15m] NIFTY DISCOUNT zone" and the read in words.</summary>
    internal static string TelegramText(PriceOiDivergence found, int barMinutes) =>
        $"[OI divergence{(barMinutes > 1 ? $" {barMinutes}m" : "")}] <b>{found.Underlying}</b> {found.Zone.ToUpperInvariant()} zone\n{found.Message}";

    public IReadOnlyList<PriceOiDivergence> Recent()
    {
        lock (_lock) return _history.ToList();
    }

    /// <summary>One option leg's OI as it ticks (the nearest listed expiry only).</summary>
    public void RecordOi(string underlying, string side, decimal strike, DateTimeOffset observedAt, long openInterest)
    {
        if (!_options.Enabled && !_options15.Enabled) return;
        _book.Record(underlying, side, strike, observedAt, openInterest);
    }

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Background work: its Dhan calls are not sent outside market hours (MarketHours).
        using var background = MarketHours.BackgroundScope();
        if (!_options.Enabled && !_options15.Enabled)
        {
            _logger.LogInformation("OI divergence alerts are turned off (OiDivergence:Enabled and OiDivergence15m:Enabled = false).");
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
            if (_options.Enabled) Raise(underlying, closed, state.Step, _options, cancellationToken);
            // The 15-minute read: when the minute that just closed completes a 15-minute candle.
            if (_options15.Enabled && closed.Count > 0 && CompletesCandle(closed[^1].Time, _options15.BarMinutes))
                Raise(underlying, PriceOiDivergenceDetector.SessionCandles(closed, _options15.BarMinutes), state.Step, _options15, cancellationToken);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "OI divergence check for {Underlying} failed.", underlying);
        }
    }

    /// <summary>Whether a closed 1-minute bar is the last minute of a session candle of `barMinutes` (from 09:15 IST).</summary>
    internal static bool CompletesCandle(DateTimeOffset minuteStart, int barMinutes)
    {
        var fromOpen = IstClock.MinutesOfDay(minuteStart) - (9 * 60 + 15);
        return barMinutes <= 1 || (fromOpen >= 0 && fromOpen % barMinutes == barMinutes - 1);
    }

    private void Raise(string underlying, IReadOnlyList<Models.Candle> bars, decimal step, DivergenceOptions options, CancellationToken cancellationToken)
    {
        var found = PriceOiDivergenceDetector.Evaluate(underlying, bars, step, _book.Strikes(underlying),
            (side, strike, minute) => _book.At(underlying, side, strike, minute, options.MaxCarryMinutes), options);
        if (found is null) return;
        var barMinutes = Math.Max(1, options.BarMinutes);
        lock (_lock)
        {
            var key = (underlying, found.Zone, barMinutes);
            if (_lastAlert.TryGetValue(key, out var at) && found.BarTime - at < TimeSpan.FromMinutes(options.CooldownMinutes)) return;
            _lastAlert[key] = found.BarTime;
            _history.AddFirst(found);
            while (_history.Count > 50) _history.RemoveLast();
        }
        _logger.LogInformation("OI divergence ({Minutes} min bars): {Message}", barMinutes, found.Message);
        if (options.Telegram) _ = _telegram.SendAsync(TelegramText(found, barMinutes), cancellationToken);
        _ = BroadcastAsync(found);
    }

    private async Task BroadcastAsync(PriceOiDivergence alert)
    {
        try { await _hub.Clients.Group(SpotHub.StaffGroup).SendAsync("oiDivergenceAlert", alert); }
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

using Microsoft.AspNetCore.SignalR;
using OptionAnalytics.Server.Hubs;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Telegram;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// The notification engine: correlates each underlying's spot EMA9/21 crossover with its ATM
/// CE/PE premium crossovers and fires an alert only when all three line up, per the confirmation
/// rule a real directional move should show across spot and both option sides:
///
///   BULLISH  - spot breaks UP, ATM CE breaks UP, ATM PE breaks DOWN
///   BEARISH  - spot breaks DOWN, ATM PE breaks UP, ATM CE breaks DOWN
///
/// (CE and PE premiums move opposite to each other on a real directional move - spot up pushes CE
/// up and PE down, so a "CE breaks up but PE doesn't break down" case is exactly the kind of
/// unconfirmed/noisy move this is meant to filter out, not just "spot crossed").
///
/// Reacts to SpotUnderlyingState.BarClosed and CdvUnderlyingState.AtmBarClosed - never polls, and
/// never computes off a still-forming bar (see EmaCrossoverDetector). Each underlying keeps only
/// its most recent spot/CE/PE crossover (direction + the bar it closed on); every time any one of
/// the three updates, the combination is re-checked. The three don't necessarily close in the same
/// instant (spot and option ticks arrive independently), so a crossover only counts toward the
/// combination while its bar is within ConfluenceWindow of the others - a crossover from ten
/// minutes ago doesn't retroactively confirm a fresh one now.
///
/// Alerts are pushed three ways: Telegram (reusing TelegramAlertService, same as the plain spot
/// EMA alert), SignalR ("confluenceAlert" on SpotHub, for live display), and a bounded in-memory
/// history (GetRecentAlerts / GET /api/alerts) so a page load or refresh still shows recent alerts
/// rather than only ones that happen to arrive while the tab is open.
/// </summary>
public sealed class ConfluenceAlertService : BackgroundService
{
    private static readonly TimeSpan ConfluenceWindow = TimeSpan.FromMinutes(5);
    private const int MaxHistory = 50;

    private readonly SpotFeedHostedService _spotFeed;
    private readonly CdvHostedService _cdv;
    private readonly TelegramAlertService _telegram;
    private readonly IHubContext<SpotHub> _hub;
    private readonly ILogger<ConfluenceAlertService> _logger;

    private readonly Dictionary<string, UnderlyingConfluenceState> _states = new();
    private readonly LinkedList<ConfluenceAlert> _history = new();
    private readonly object _historyLock = new();

    public ConfluenceAlertService(
        SpotFeedHostedService spotFeed, CdvHostedService cdv, TelegramAlertService telegram,
        IHubContext<SpotHub> hub, ILogger<ConfluenceAlertService> logger)
    {
        _spotFeed = spotFeed;
        _cdv = cdv;
        _telegram = telegram;
        _hub = hub;
        _logger = logger;
    }

    /// <summary>Read by AlertsController for GET /api/alerts - most recent first.</summary>
    public IReadOnlyList<ConfluenceAlert> GetRecentAlerts()
    {
        lock (_historyLock) { return _history.ToList(); }
    }

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        foreach (var (underlying, spotState) in _spotFeed.States)
        {
            var capturedUnderlying = underlying;
            var capturedSpotState = spotState;
            spotState.BarClosed += _ => OnSpotBarClosed(capturedUnderlying, capturedSpotState, stoppingToken);
        }

        foreach (var (underlying, cdvState) in _cdv.States)
        {
            var capturedUnderlying = underlying;
            var capturedCdvState = cdvState;
            cdvState.AtmBarClosed += (isCall, _) => OnAtmBarClosed(capturedUnderlying, capturedCdvState, isCall, stoppingToken);
        }

        return Task.CompletedTask;
    }

    private void OnSpotBarClosed(string underlying, SpotUnderlyingState spotState, CancellationToken cancellationToken)
    {
        var direction = EmaCrossoverDetector.Detect(spotState.GetClosedCandles());
        if (direction is null) return;

        var barTime = spotState.GetClosedCandles()[^1].Time;
        var state = GetOrCreateState(underlying);
        lock (state) { state.Spot = (direction, barTime); }
        Evaluate(underlying, state, cancellationToken);
    }

    private void OnAtmBarClosed(string underlying, CdvUnderlyingState cdvState, bool isCall, CancellationToken cancellationToken)
    {
        var closedBars = cdvState.GetAtmClosedCandles(isCall);
        var direction = EmaCrossoverDetector.Detect(closedBars);
        if (direction is null) return;

        var barTime = closedBars[^1].Time;
        var state = GetOrCreateState(underlying);
        lock (state)
        {
            if (isCall) state.Ce = (direction, barTime); else state.Pe = (direction, barTime);
        }
        Evaluate(underlying, state, cancellationToken);
    }

    private void Evaluate(string underlying, UnderlyingConfluenceState state, CancellationToken cancellationToken)
    {
        string direction;
        DateTimeOffset spotBarTime;

        lock (state)
        {
            if (state.Spot is not { } spot || state.Ce is not { } ce || state.Pe is not { } pe) return;
            if ((spot.BarTime - ce.BarTime).Duration() > ConfluenceWindow) return;
            if ((spot.BarTime - pe.BarTime).Duration() > ConfluenceWindow) return;

            var isBullish = spot.Direction == "Bullish" && ce.Direction == "Bullish" && pe.Direction == "Bearish";
            var isBearish = spot.Direction == "Bearish" && pe.Direction == "Bullish" && ce.Direction == "Bearish";
            if (!isBullish && !isBearish) return;

            // One alert per spot crossover, not one per contributing update - CE/PE settling into
            // place after spot already re-confirms the same combination and must not re-fire it.
            if (state.LastAlertedSpotBarTime == spot.BarTime) return;
            state.LastAlertedSpotBarTime = spot.BarTime;

            direction = isBullish ? "Bullish" : "Bearish";
            spotBarTime = spot.BarTime;
        }

        var spotPrice = _spotFeed.States.TryGetValue(underlying, out var spotState) ? spotState.LastPrice : 0;
        var atmStrike = _cdv.States.TryGetValue(underlying, out var cdvState) ? cdvState.AtmStrike : null;

        var summary = direction == "Bullish"
            ? "Spot breakup + ATM CE breakup + ATM PE breakdown"
            : "Spot breakdown + ATM PE breakup + ATM CE breakdown";
        var message = $"<b>{underlying}</b> {direction.ToUpperInvariant()} confluence\n{summary}\nSpot: {spotPrice:N2} · ATM {atmStrike}\nBar: {spotBarTime:yyyy-MM-dd HH:mm} UTC";

        var alert = new ConfluenceAlert(underlying, DateTimeOffset.UtcNow, direction, spotPrice, atmStrike, message);
        _logger.LogInformation("Confluence alert for {Underlying}: {Direction} at spot {Spot}, ATM {Atm}.", underlying, direction, spotPrice, atmStrike);

        lock (_historyLock)
        {
            _history.AddFirst(alert);
            while (_history.Count > MaxHistory) _history.RemoveLast();
        }

        _ = _telegram.SendAsync(message, cancellationToken);
        _ = BroadcastAsync(alert);
    }

    private async Task BroadcastAsync(ConfluenceAlert alert)
    {
        try
        {
            await _hub.Clients.All.SendAsync("confluenceAlert", alert);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Failed to broadcast a confluence alert for {Underlying}.", alert.Underlying);
        }
    }

    private UnderlyingConfluenceState GetOrCreateState(string underlying)
    {
        lock (_states)
        {
            if (!_states.TryGetValue(underlying, out var state))
            {
                state = new UnderlyingConfluenceState();
                _states[underlying] = state;
            }
            return state;
        }
    }

    /// <summary>One underlying's most recent spot/ATM-CE/ATM-PE crossover, each just a direction +
    /// the bar it closed on - locked on itself (not a shared lock) since spot and option bar
    /// closes for different underlyings never contend with each other.</summary>
    private sealed class UnderlyingConfluenceState
    {
        public (string Direction, DateTimeOffset BarTime)? Spot;
        public (string Direction, DateTimeOffset BarTime)? Ce;
        public (string Direction, DateTimeOffset BarTime)? Pe;
        public DateTimeOffset? LastAlertedSpotBarTime;
    }
}

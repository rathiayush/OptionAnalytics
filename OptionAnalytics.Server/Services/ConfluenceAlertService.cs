using Microsoft.AspNetCore.SignalR;
using OptionAnalytics.Server.Hubs;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Telegram;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// The notification engine. Keeps each underlying's CURRENT, close-CONFIRMED EMA9/21 bias for
/// three legs - spot, ATM CE, ATM PE - continuously up to date (EmaCrossoverDetector.
/// ConfirmedDirection, recomputed on every closed bar - see its own doc comment for why "confirmed"
/// means the bar's close actually finished beyond both EMAs, not just their relationship flipping),
/// and fires two kinds of alert off that live state:
///
///   1. An individual alert the moment any ONE leg's bias flips (Kind: "Spot"/"AtmCe"/"AtmPe") -
///      the lightweight "something just changed" signal.
///   2. A stronger "Confluence" alert only when all three confirm the same move at once:
///
///        BULLISH  - spot is UP, ATM CE is UP, ATM PE is DOWN
///        BEARISH  - spot is DOWN, ATM PE is UP, ATM CE is DOWN
///
///      (CE and PE premiums move opposite to each other on a real directional move - spot up
///      pushes CE up and PE down, so "CE up but PE not down" is exactly the kind of unconfirmed
///      move this is meant to filter out). Fires once per alignment episode - re-evaluated on
///      every leg update, but only actually alerts the moment the three-way match first becomes
///      true, staying quiet on every subsequent bar where it's still true, and re-arming itself
///      the moment the alignment breaks (see ConfluenceAlerted).
///
/// The three legs' bars don't necessarily close in the same instant (spot and option ticks arrive
/// independently), so the confluence check only counts a leg while its bar is within
/// ConfluenceWindow of the spot bar that triggered the check - a leg's bias from ten minutes ago
/// doesn't retroactively confirm a fresh spot flip now.
///
/// Each leg updates on two paths, BOTH always wired up - see AlertModeStore's own doc comment for
/// why Live is additive, never a replacement, and shares its dedup (ConfluenceAlerted / each leg's
/// last-known direction) with the closed path:
///   - Closed-and-confirmed (unconditional): BarClosed/AtmBarClosed, off GetClosedCandles()/
///     GetAtmClosedCandles(isCall).
///   - Live (only when AlertModeStore.IsLive): a short periodic re-check off GetCandles()/
///     GetAtmCandles(isCall) - the still-forming candle included.
///
/// GetCurrentStates() serves the live per-leg snapshot (GET /api/alerts/state) - filled from
/// whatever closed-bar history already exists the moment this service starts (ExecuteAsync's
/// initial seed pass), not just from bars that close after that, so a page load right after a
/// restart still shows a real "where do things stand" rather than three blanks waiting for the
/// next bar.
///
/// Both alert kinds go out over SignalR ("confluenceAlert" on SpotHub, for live display) and a
/// bounded in-memory history (GetRecentAlerts / GET /api/alerts). Only the stronger Confluence
/// alert goes to Telegram - individual leg flips would otherwise double up with
/// EmaCrossoverAlertService's own existing spot-crossover Telegram alert and turn the channel into
/// noise for a signal that isn't yet confirmed.
/// </summary>
public sealed class ConfluenceAlertService : BackgroundService
{
    private static readonly TimeSpan ConfluenceWindow = TimeSpan.FromMinutes(5);
    /// <summary>Same reasoning as EmaCrossoverAlertService.LiveCheckInterval - frequent enough to
    /// feel live, infrequent enough not to burn CPU recomputing EMA9/21 for six legs (two
    /// underlyings x spot/CE/PE) on every tick for no real benefit.</summary>
    private static readonly TimeSpan LiveCheckInterval = TimeSpan.FromSeconds(10);
    private const int MaxHistory = 50;

    private readonly SpotFeedHostedService _spotFeed;
    private readonly CdvHostedService _cdv;
    private readonly TelegramAlertService _telegram;
    private readonly AlertModeStore _alertMode;
    private readonly IHubContext<SpotHub> _hub;
    private readonly ILogger<ConfluenceAlertService> _logger;

    private readonly Dictionary<string, UnderlyingConfluenceState> _states = new();
    private readonly LinkedList<ConfluenceAlert> _history = new();
    private readonly object _historyLock = new();

    public ConfluenceAlertService(
        SpotFeedHostedService spotFeed, CdvHostedService cdv, TelegramAlertService telegram, AlertModeStore alertMode,
        IHubContext<SpotHub> hub, ILogger<ConfluenceAlertService> logger)
    {
        _spotFeed = spotFeed;
        _cdv = cdv;
        _telegram = telegram;
        _alertMode = alertMode;
        _hub = hub;
        _logger = logger;
    }

    /// <summary>Read by AlertsController for GET /api/alerts - most recent first, every kind mixed
    /// together (individual leg flips and confirmed confluences alike).</summary>
    public IReadOnlyList<ConfluenceAlert> GetRecentAlerts()
    {
        lock (_historyLock) { return _history.ToList(); }
    }

    /// <summary>Read by AlertsController for GET /api/alerts/state - every underlying's current
    /// spot/ATM-CE/ATM-PE bias right now.</summary>
    public IReadOnlyList<CrossoverState> GetCurrentStates()
    {
        lock (_states)
        {
            return _states.Select(kv =>
            {
                lock (kv.Value)
                {
                    return new CrossoverState(kv.Key, kv.Value.Spot?.Direction, kv.Value.Ce?.Direction, kv.Value.Pe?.Direction, kv.Value.LastUpdatedUtc);
                }
            }).ToList();
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        foreach (var (underlying, spotState) in _spotFeed.States)
        {
            var capturedUnderlying = underlying;
            var capturedSpotState = spotState;
            // Seed the current bias from whatever backfilled/already-closed bars exist right now -
            // silent (announce: false), since this is catching up to already-known history on
            // startup, not a live change worth alerting on.
            UpdateSpotLeg(capturedUnderlying, capturedSpotState.GetClosedCandles(), announce: false, stoppingToken);
            spotState.BarClosed += _ => UpdateSpotLeg(capturedUnderlying, capturedSpotState.GetClosedCandles(), announce: true, stoppingToken);
        }

        foreach (var (underlying, cdvState) in _cdv.States)
        {
            var capturedUnderlying = underlying;
            var capturedCdvState = cdvState;
            UpdateAtmLeg(capturedUnderlying, isCall: true, capturedCdvState.GetAtmClosedCandles(true), announce: false, stoppingToken);
            UpdateAtmLeg(capturedUnderlying, isCall: false, capturedCdvState.GetAtmClosedCandles(false), announce: false, stoppingToken);
            cdvState.AtmBarClosed += (isCall, _) => UpdateAtmLeg(capturedUnderlying, isCall, capturedCdvState.GetAtmClosedCandles(isCall), announce: true, stoppingToken);
            // A day rollover or a manual expiry switch (CdvHostedService.SelectExpiryAsync) wipes
            // this underlying's whole strike window - see ClearAtmLegs for why the CE/PE bias
            // cached here must be dropped too, not left showing a reading from a contract that no
            // longer exists.
            cdvState.StrikesReset += () => ClearAtmLegs(capturedUnderlying);
        }

        // Extra, faster path: only active in Live mode (AlertModeStore) - re-checks every leg's
        // STILL-FORMING candle on a short interval, in ADDITION to (never instead of) the
        // BarClosed/AtmBarClosed-driven closed-and-confirmed checks above, which keep running
        // regardless of mode as the reliable baseline.
        try
        {
            using var timer = new PeriodicTimer(LiveCheckInterval);
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                if (!_alertMode.IsLive) continue;

                foreach (var (underlying, spotState) in _spotFeed.States)
                    UpdateSpotLeg(underlying, spotState.GetCandles(), announce: true, stoppingToken);

                foreach (var (underlying, cdvState) in _cdv.States)
                {
                    UpdateAtmLeg(underlying, isCall: true, cdvState.GetAtmCandles(true), announce: true, stoppingToken);
                    UpdateAtmLeg(underlying, isCall: false, cdvState.GetAtmCandles(false), announce: true, stoppingToken);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Shutting down.
        }
    }

    private void UpdateSpotLeg(string underlying, IReadOnlyList<Candle> bars, bool announce, CancellationToken cancellationToken)
    {
        // ConfirmedDirection, not the plain EMA9-vs-EMA21 relationship - see its own doc comment.
        // In a flat/choppy stretch the two EMAs can sit almost on top of each other and swap order
        // on a single noisy tick with price never really leaving their neighborhood; requiring the
        // close to have actually finished beyond both lines is what keeps a leg (and therefore
        // Confluence, which needs all three to agree) from "confirming" on that noise.
        var direction = EmaCrossoverDetector.ConfirmedDirection(bars);
        if (direction is null || bars.Count == 0) return;

        UpdateLeg(underlying, "Spot", direction, bars[^1].Time, announce, s => s.Spot, (s, v) => s.Spot = v, cancellationToken);
    }

    private void UpdateAtmLeg(string underlying, bool isCall, IReadOnlyList<Candle> bars, bool announce, CancellationToken cancellationToken)
    {
        var direction = EmaCrossoverDetector.ConfirmedDirection(bars);
        if (direction is null || bars.Count == 0) return;

        var kind = isCall ? "AtmCe" : "AtmPe";
        if (isCall)
            UpdateLeg(underlying, kind, direction, bars[^1].Time, announce, s => s.Ce, (s, v) => s.Ce = v, cancellationToken);
        else
            UpdateLeg(underlying, kind, direction, bars[^1].Time, announce, s => s.Pe, (s, v) => s.Pe = v, cancellationToken);
    }

    private void UpdateLeg(
        string underlying, string kind, string direction, DateTimeOffset barTime, bool announce,
        Func<UnderlyingConfluenceState, (string Direction, DateTimeOffset BarTime)?> getLeg,
        Action<UnderlyingConfluenceState, (string Direction, DateTimeOffset BarTime)?> setLeg,
        CancellationToken cancellationToken)
    {
        var state = GetOrCreateState(underlying);
        bool changed;
        lock (state)
        {
            var previous = getLeg(state);
            changed = previous is not { } prev || prev.Direction != direction;
            setLeg(state, (direction, barTime));
            state.LastUpdatedUtc = DateTimeOffset.UtcNow;
            if (changed) state.ConfluenceAlerted = false; // a leg just moved - allow a fresh confluence alert if the new combination aligns
        }

        if (announce && changed) RaiseIndividualAlert(underlying, kind, direction, barTime, cancellationToken);
        EvaluateConfluence(underlying, state, cancellationToken);
    }

    private void RaiseIndividualAlert(string underlying, string kind, string direction, DateTimeOffset barTime, CancellationToken cancellationToken)
    {
        var spotPrice = _spotFeed.States.TryGetValue(underlying, out var spotState) ? spotState.LastPrice : 0;
        var atmStrike = _cdv.States.TryGetValue(underlying, out var cdvState) ? cdvState.AtmStrike : null;
        var legLabel = kind switch { "Spot" => "Spot", "AtmCe" => "ATM CE", "AtmPe" => "ATM PE", _ => kind };

        var message = $"<b>{underlying}</b> {legLabel} EMA 9/21 turned {direction}\nSpot: {spotPrice:N2} · ATM {atmStrike}\nBar: {barTime:yyyy-MM-dd HH:mm} UTC";
        var alert = new ConfluenceAlert(underlying, DateTimeOffset.UtcNow, kind, direction, spotPrice, atmStrike, message);
        _logger.LogInformation("{Kind} bias change for {Underlying}: {Direction} at spot {Spot}.", kind, underlying, direction, spotPrice);

        RecordAndBroadcast(alert, sendTelegram: false, cancellationToken);
    }

    private void EvaluateConfluence(string underlying, UnderlyingConfluenceState state, CancellationToken cancellationToken)
    {
        string direction;
        DateTimeOffset spotBarTime;

        lock (state)
        {
            if (state.Spot is not { } spot || state.Ce is not { } ce || state.Pe is not { } pe)
            {
                state.ConfluenceAlerted = false;
                return;
            }

            var withinWindow = (spot.BarTime - ce.BarTime).Duration() <= ConfluenceWindow && (spot.BarTime - pe.BarTime).Duration() <= ConfluenceWindow;
            var isBullish = withinWindow && spot.Direction == "Bullish" && ce.Direction == "Bullish" && pe.Direction == "Bearish";
            var isBearish = withinWindow && spot.Direction == "Bearish" && pe.Direction == "Bullish" && ce.Direction == "Bearish";

            if (!isBullish && !isBearish)
            {
                state.ConfluenceAlerted = false;
                return;
            }
            // Already alerted for this exact alignment - stays quiet until it breaks (a leg flips,
            // handled by UpdateLeg resetting this flag) and a fresh one forms.
            if (state.ConfluenceAlerted) return;

            state.ConfluenceAlerted = true;
            direction = isBullish ? "Bullish" : "Bearish";
            spotBarTime = spot.BarTime;
        }

        var spotPrice = _spotFeed.States.TryGetValue(underlying, out var spotState) ? spotState.LastPrice : 0;
        var atmStrike = _cdv.States.TryGetValue(underlying, out var cdvState) ? cdvState.AtmStrike : null;

        var summary = direction == "Bullish"
            ? "Spot breakup + ATM CE breakup + ATM PE breakdown"
            : "Spot breakdown + ATM PE breakup + ATM CE breakdown";
        // [Confluence] up front - same reasoning as EmaCrossoverAlertService's [Spot EMA] tag: this
        // channel also carries armed Strategy Trigger alerts and the spot-only EMA crossover feed,
        // and a Telegram push notification preview only shows the first line.
        var message = $"[Confluence] <b>{underlying}</b> {direction.ToUpperInvariant()} confluence\n{summary}\nSpot: {spotPrice:N2} · ATM {atmStrike}\nBar: {spotBarTime:yyyy-MM-dd HH:mm} UTC";

        var alert = new ConfluenceAlert(underlying, DateTimeOffset.UtcNow, "Confluence", direction, spotPrice, atmStrike, message);
        _logger.LogInformation("Confluence alert for {Underlying}: {Direction} at spot {Spot}, ATM {Atm}.", underlying, direction, spotPrice, atmStrike);

        RecordAndBroadcast(alert, sendTelegram: true, cancellationToken);
    }

    private void RecordAndBroadcast(ConfluenceAlert alert, bool sendTelegram, CancellationToken cancellationToken)
    {
        lock (_historyLock)
        {
            _history.AddFirst(alert);
            while (_history.Count > MaxHistory) _history.RemoveLast();
        }

        if (sendTelegram) _ = _telegram.SendAsync(alert.Message, cancellationToken);
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

    /// <summary>Drops the cached ATM CE/PE bias for one underlying - called on CdvUnderlyingState.
    /// StrikesReset (day rollover or a manual expiry switch). Without this, the CE/PE readings held
    /// here would keep reporting the OLD contract's last-known direction until its replacement's
    /// first live bar closes and overwrites them - a window in which EvaluateConfluence could
    /// combine a fresh SPOT reading with a stale, now-nonexistent-contract CE/PE bias and produce a
    /// Confluence alert that mixes two different instruments' data. Spot is left untouched - it has
    /// no relationship to option expiry. EvaluateConfluence's own null checks already treat "no CE/
    /// PE reading yet" as "nothing to evaluate", so clearing to null is enough to close the gap; the
    /// real reading comes back the moment the new expiry's first ATM bar closes.</summary>
    private void ClearAtmLegs(string underlying)
    {
        var state = GetOrCreateState(underlying);
        lock (state)
        {
            state.Ce = null;
            state.Pe = null;
            state.ConfluenceAlerted = false;
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

    /// <summary>One underlying's current spot/ATM-CE/ATM-PE bias, each a direction + the bar it was
    /// last confirmed on - locked on itself (not a shared lock) since spot and option bar closes
    /// for different underlyings never contend with each other.</summary>
    private sealed class UnderlyingConfluenceState
    {
        public (string Direction, DateTimeOffset BarTime)? Spot;
        public (string Direction, DateTimeOffset BarTime)? Ce;
        public (string Direction, DateTimeOffset BarTime)? Pe;
        public DateTimeOffset LastUpdatedUtc;
        /// <summary>True once the Confluence alert has fired for the CURRENT three-way alignment -
        /// reset the moment any leg flips (see UpdateLeg), so the next genuine alignment can alert
        /// again instead of this staying stuck true forever.</summary>
        public bool ConfluenceAlerted;
    }
}

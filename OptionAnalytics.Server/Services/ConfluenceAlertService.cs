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
///      That bookkeeping is updated on EVERY evaluation, including ExecuteAsync's own silent
///      startup catch-up pass over already-closed history - but only a call from a genuinely NEW
///      closed bar (announce: true) ever actually broadcasts/Telegrams (see EvaluateConfluence).
///      Without that split, a restart would risk re-announcing an alignment that had already been
///      sitting there for the last hour as if it just happened, purely because this process forgot
///      it was already true.
///
/// The three legs' bars don't necessarily close in the same instant (spot and option ticks arrive
/// independently), so the confluence check only counts a leg while its bar is within
/// ConfluenceWindow of the spot bar that triggered the check - a leg's bias from ten minutes ago
/// doesn't retroactively confirm a fresh spot flip now.
///
/// Each leg updates strictly off CLOSED bars - BarClosed/AtmBarClosed, GetClosedCandles()/
/// GetAtmClosedCandles(isCall) - never a still-forming one. There is no earlier point at which
/// reacting gets you a real, achievable price instead of a stale one: a candle's EMA relationship
/// only becomes trustworthy once it's done, and there's nothing to trade on before then anyway.
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

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        foreach (var (underlying, spotState) in _spotFeed.States)
        {
            var capturedUnderlying = underlying;
            var capturedSpotState = spotState;
            // Seed the current bias from whatever backfilled/already-closed bars exist right now -
            // silent (announce: false), since this is catching up to already-known history on
            // startup, not a live change worth alerting on.
            UpdateSpotLeg(capturedUnderlying, capturedSpotState, announce: false, stoppingToken);
            spotState.BarClosed += _ => UpdateSpotLeg(capturedUnderlying, capturedSpotState, announce: true, stoppingToken);
        }

        foreach (var (underlying, cdvState) in _cdv.States)
        {
            var capturedUnderlying = underlying;
            var capturedCdvState = cdvState;
            UpdateAtmLeg(capturedUnderlying, capturedCdvState, isCall: true, announce: false, stoppingToken);
            UpdateAtmLeg(capturedUnderlying, capturedCdvState, isCall: false, announce: false, stoppingToken);
            cdvState.AtmBarClosed += (isCall, _) => UpdateAtmLeg(capturedUnderlying, capturedCdvState, isCall, announce: true, stoppingToken);
            // A day rollover or a manual expiry switch (CdvHostedService.SelectExpiryAsync) wipes
            // this underlying's whole strike window - see ClearAtmLegs for why the CE/PE bias
            // cached here must be dropped too, not left showing a reading from a contract that no
            // longer exists.
            cdvState.StrikesReset += () => ClearAtmLegs(capturedUnderlying);
        }

        return Task.CompletedTask;
    }

    private void UpdateSpotLeg(string underlying, SpotUnderlyingState spotState, bool announce, CancellationToken cancellationToken)
    {
        var closedBars = spotState.GetClosedCandles();
        // ConfirmedDirection, not the plain EMA9-vs-EMA21 relationship - see its own doc comment.
        // In a flat/choppy stretch the two EMAs can sit almost on top of each other and swap order
        // on a single noisy tick with price never really leaving their neighborhood; requiring the
        // close to have actually finished beyond both lines is what keeps a leg (and therefore
        // Confluence, which needs all three to agree) from "confirming" on that noise.
        var direction = EmaCrossoverDetector.ConfirmedDirection(closedBars);
        if (direction is null || closedBars.Count == 0) return;

        UpdateLeg(underlying, "Spot", direction, closedBars[^1].Time, announce, s => s.Spot, (s, v) => s.Spot = v, cancellationToken);
    }

    private void UpdateAtmLeg(string underlying, CdvUnderlyingState cdvState, bool isCall, bool announce, CancellationToken cancellationToken)
    {
        var closedBars = cdvState.GetAtmClosedCandles(isCall);
        var direction = EmaCrossoverDetector.ConfirmedDirection(closedBars);
        if (direction is null || closedBars.Count == 0) return;

        var kind = isCall ? "AtmCe" : "AtmPe";
        if (isCall)
            UpdateLeg(underlying, kind, direction, closedBars[^1].Time, announce, s => s.Ce, (s, v) => s.Ce = v, cancellationToken);
        else
            UpdateLeg(underlying, kind, direction, closedBars[^1].Time, announce, s => s.Pe, (s, v) => s.Pe = v, cancellationToken);
    }

    private void UpdateLeg(
        string underlying, string kind, string direction, DateTimeOffset barTime, bool announce,
        Func<UnderlyingConfluenceState, (string Direction, DateTimeOffset BarTime)?> getLeg,
        Action<UnderlyingConfluenceState, (string Direction, DateTimeOffset BarTime)?> setLeg,
        CancellationToken cancellationToken)
    {
        var state = GetOrCreateState(underlying);
        bool changed;
        bool hadPrevious;
        lock (state)
        {
            var previous = getLeg(state);
            hadPrevious = previous is not null;
            changed = previous is not { } prev || prev.Direction != direction;
            setLeg(state, (direction, barTime));
            state.LastUpdatedUtc = DateTimeOffset.UtcNow;
            if (changed) state.ConfluenceAlerted = false; // a leg just moved - allow a fresh confluence alert if the new combination aligns
        }

        // The first reading ever recorded for THIS leg is a baseline, not a flip worth alerting on
        // - see EvaluateConfluence's EverComplete check for why this can legitimately still be the
        // first reading even when announce is true (this call came from a real bar close, not the
        // startup seed pass, because backfill for this leg hadn't finished by the time the seed
        // pass ran).
        if (announce && changed && hadPrevious) RaiseIndividualAlert(underlying, kind, direction, barTime, cancellationToken);
        EvaluateConfluence(underlying, state, announce, cancellationToken);
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

    private void EvaluateConfluence(string underlying, UnderlyingConfluenceState state, bool announce, CancellationToken cancellationToken)
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

            // The first instant all three legs have EVER been known at once is a baseline, not an
            // event - whether that happens during ExecuteAsync's own silent seed pass or, because
            // backfill for one or more legs hadn't finished by then (a real race: backfill is an
            // async Dhan REST round trip, not instant), on whichever real bar close afterward
            // happens to complete the trio. Without this, a restart could treat an alignment that
            // was already sitting there before this process started as brand new and Telegram it.
            if (!state.EverComplete)
            {
                state.EverComplete = true;
                announce = false;
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

        // Marked ConfluenceAlerted above regardless - that bookkeeping has to reflect reality
        // whether this call came from a real bar close or the startup catch-up pass - but only a
        // real one (announce: true) is actually worth telling anyone about. Without this check, a
        // restart's silent seed pass (ExecuteAsync's own initial UpdateSpotLeg/UpdateAtmLeg calls,
        // announce: false) could discover three legs that were ALREADY aligned before this process
        // even started watching - an alignment that has been sitting there for the last hour, not
        // something that just happened - and broadcast/Telegram it as if it were a fresh signal.
        // Every redeploy would then risk paging a stale "confluence" that is really just this
        // service re-learning history it forgot on restart.
        if (!announce) return;

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
        /// <summary>True once all three legs have EVER been known at the same time - see
        /// EvaluateConfluence's own use of this for why the first time that happens is never itself
        /// worth alerting on, regardless of which call (seed pass or a real bar close) it happens on.</summary>
        public bool EverComplete;
    }
}

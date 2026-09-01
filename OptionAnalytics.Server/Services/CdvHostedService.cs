using Microsoft.AspNetCore.SignalR;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Hubs;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Computes CE/PE cumulative delta volume (CDV) for NIFTY/BANKNIFTY's near-the-money option
/// chain: every 30 minutes, re-centers on the current ATM strike (spot rounded to the nearest
/// strike step) and tracks the 8-ITM + 8-OTM window around it for both CE and PE (17 strikes x 2
/// sides = up to 34 contracts), subscribing/unsubscribing on the shared DhanMarketFeedClient as
/// the window moves. Every option tick is folded into its underlying's CdvUnderlyingState (tick
/// rule + sigmoid moneyness delta-weighting - see that class) and the resulting CE/PE totals are
/// pushed to the dashboard over the same SpotHub the spot chart uses.
/// </summary>
public sealed class CdvHostedService : BackgroundService
{
    private static readonly (string Underlying, int Step)[] Underlyings =
    {
        ("NIFTY", 50),
        ("BANKNIFTY", 100),
    };

    /// <summary>8 ITM + 8 OTM strikes around ATM (so 17 strikes total, ATM included), for both CE
    /// and PE.</summary>
    private const int StrikeRange = 8;

    private static readonly TimeSpan AtmRecenterInterval = TimeSpan.FromMinutes(30);

    /// <summary>Matches SpotFeedHostedService's own backfill window exactly - the ATM CE/PE premium
    /// chart and CDV's reconstructed history need to cover the same trading days the spot chart
    /// does, or the charts would visibly disagree on how far back "history" goes.</summary>
    private const int HistoryTradingDays = 5;
    private const int HistoryLookbackCalendarDays = 15;

    /// <summary>Dhan gives no documented rate limit for this endpoint, but a recenter can mean
    /// backfilling up to ~34 contracts (17 strikes x CE/PE) back to back on first startup - a small
    /// gap between calls is cheap insurance against tripping one anyway.</summary>
    private static readonly TimeSpan BackfillCallDelay = TimeSpan.FromMilliseconds(200);

    private readonly DhanOptionChainMaster _optionChainMaster;
    private readonly DhanMarketFeedClient _feedClient;
    private readonly SpotFeedHostedService _spotFeed;
    private readonly DhanHistoricalDataService _historicalData;
    private readonly IHubContext<SpotHub> _hub;
    private readonly ILogger<CdvHostedService> _logger;

    private readonly Dictionary<uint, CdvUnderlyingState> _bySecurityId = new();
    private readonly Dictionary<string, HashSet<uint>> _subscribedTokens = new();

    /// <summary>Marks an underlying once its first backfill batch has actually fed the CDV
    /// reconstruction (not just been attempted) - HashSet.Add's return value doubles as the "is
    /// this the first backfill batch" flag BackfillStrikesAsync needs (see
    /// CdvUnderlyingState.SeedStrikeHistory's includeInCdvHistory parameter for why only the first
    /// batch feeds the CDV reconstruction). If that first batch seeds zero strikes (e.g. it raced
    /// TOTP auth and every fetch failed), BackfillStrikesAsync removes the mark again so a later
    /// recenter cycle gets a clean second attempt instead of being permanently locked out of CDV
    /// history for the rest of the session.</summary>
    private readonly HashSet<string> _cdvHistorySeeded = new();

    public CdvHostedService(
        DhanOptionChainMaster optionChainMaster,
        DhanMarketFeedClient feedClient,
        SpotFeedHostedService spotFeed,
        DhanHistoricalDataService historicalData,
        IHubContext<SpotHub> hub,
        ILogger<CdvHostedService> logger)
    {
        _optionChainMaster = optionChainMaster;
        _feedClient = feedClient;
        _spotFeed = spotFeed;
        _historicalData = historicalData;
        _hub = hub;
        _logger = logger;

        States = Underlyings.ToDictionary(u => u.Underlying, u => new CdvUnderlyingState(u.Underlying));
        foreach (var (underlying, _) in Underlyings) _subscribedTokens[underlying] = new HashSet<uint>();
    }

    /// <summary>Read by CdvController - keyed by underlying name.</summary>
    public IReadOnlyDictionary<string, CdvUnderlyingState> States { get; }

    /// <summary>The strike/side verification list for GET /api/cdv/{underlying}/strikes - see
    /// CdvUnderlyingState.GetTrackedStrikes. _subscribedTokens (this service's own bookkeeping, not
    /// the state's) is what tells that method which strikes are the CURRENTLY active ATM+-8 window
    /// versus ones that rolled out earlier today.</summary>
    public IReadOnlyList<CdvStrikeInfo> GetTrackedStrikes(string underlying)
    {
        if (!States.TryGetValue(underlying, out var state)) return Array.Empty<CdvStrikeInfo>();
        var active = _subscribedTokens.TryGetValue(underlying, out var tokens) ? tokens : new HashSet<uint>();
        return state.GetTrackedStrikes(active);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await _optionChainMaster.EnsureLoadedAsync(stoppingToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "Could not load the Dhan option chain - CDV cannot resolve strikes yet. Will retry on the next re-center.");
        }

        _feedClient.TickReceived += OnTick;

        // The very first recenter can easily lose the race with SpotFeedHostedService's own
        // startup work (scrip master download, historical backfill) and find every underlying's
        // spot price still 0 - which used to mean waiting a full 30 minutes for the next scheduled
        // recenter before the CDV chart ever got a strike window. Retry on a short interval until
        // every underlying has resolved an ATM at least once, then fall through to the normal
        // 30-minute cadence.
        for (var attempt = 0; attempt < 30 && !stoppingToken.IsCancellationRequested; attempt++)
        {
            await RecenterAllAsync(stoppingToken);
            if (States.Values.All(s => s.AtmStrike is not null)) break;
            await Task.Delay(TimeSpan.FromSeconds(20), stoppingToken);
        }

        using var timer = new PeriodicTimer(AtmRecenterInterval);
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            await RecenterAllAsync(stoppingToken);
        }
    }

    private async Task RecenterAllAsync(CancellationToken cancellationToken)
    {
        try
        {
            await _optionChainMaster.EnsureLoadedAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Could not refresh the Dhan option chain for this re-center - keeping the previous strike window.");
        }

        foreach (var (underlying, step) in Underlyings)
            await RecenterAsync(underlying, step, cancellationToken);
    }

    private async Task RecenterAsync(string underlying, int step, CancellationToken cancellationToken)
    {
        var spot = _spotFeed.States.TryGetValue(underlying, out var spotState) ? spotState.LastPrice : 0;
        if (spot <= 0)
        {
            _logger.LogInformation("CDV: {Underlying} has no spot price yet - skipping this re-center.", underlying);
            return;
        }

        var today = DateOnly.FromDateTime(DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(5.5)).DateTime);
        var state = States[underlying];

        // CDV is a SESSION indicator (see CdvUnderlyingState.TradingDay's doc comment) - the moment
        // the IST calendar date rolls over, yesterday's whole strike chain and running totals are no
        // longer meaningful and must start clean, exactly like LiveSpreadCalculator's own CDV port
        // does on its "freshDay" check.
        if (state.TradingDay is { } lastTradingDay && lastTradingDay != today)
            await ResetForNewDayAsync(underlying, state, cancellationToken);
        state.TradingDay = today;

        var atm = (int)(Math.Round(spot / step) * step);
        var expiry = _optionChainMaster.GetNearestExpiry(underlying, today);
        if (expiry is null)
        {
            _logger.LogWarning("CDV: {Underlying} - no listed option expiry found. Skipping.", underlying);
            return;
        }

        state.AtmStrike = atm;
        state.Expiry = expiry;
        state.LastSpot = spot;

        var strikes = Enumerable.Range(-StrikeRange, StrikeRange * 2 + 1).Select(i => atm + i * step).ToArray();

        var desiredTokens = new HashSet<uint>();
        var ceList = new List<int>();
        var peList = new List<int>();
        var needsBackfill = new List<uint>();

        foreach (var strike in strikes)
        {
            foreach (var isCall in new[] { true, false })
            {
                var contract = _optionChainMaster.Find(underlying, expiry.Value, strike, isCall);
                if (contract is null) continue;

                var isNewlyTracked = state.EnsureTracked(contract.SecurityId, strike, isCall);
                // A strike whose OWN first backfill attempt found nothing (auth not ready yet,
                // a transient Dhan error) is still "tracked" from EnsureTracked's point of view, so
                // it would never show up as newly-tracked again - NeedsBackfill catches that case
                // and retries it right alongside genuinely new strikes on this recenter.
                if (isNewlyTracked || state.NeedsBackfill(contract.SecurityId))
                    needsBackfill.Add(contract.SecurityId);
                _bySecurityId[contract.SecurityId] = state;
                desiredTokens.Add(contract.SecurityId);
                (isCall ? ceList : peList).Add(strike);
            }
        }

        // Backfill every strike that needs it BEFORE subscribing it live - otherwise a live tick
        // could arrive and start building a bar while the backfill for that same strike is still in
        // flight, corrupting SeedHistory's "nothing live yet" assumption. Cheap for a routine
        // 30-minute recenter (usually just a handful of strikes as the window shifts by one step,
        // plus any earlier failures still needing a retry); the one expensive case is the very
        // first recenter after startup, where the whole ATM+-8 window (up to 34 contracts) needs it
        // at once - a one-time cost, not repeated on every recenter once everything has succeeded.
        if (needsBackfill.Count > 0)
            await BackfillStrikesAsync(underlying, state, needsBackfill, spot, cancellationToken);

        var currentlySubscribed = _subscribedTokens[underlying];
        var toSubscribe = desiredTokens.Where(t => !currentlySubscribed.Contains(t)).ToArray();
        var toUnsubscribe = currentlySubscribed.Where(t => !desiredTokens.Contains(t)).ToArray();

        if (toSubscribe.Length > 0)
        {
            var segments = toSubscribe.ToDictionary(t => t, _ => "NSE_FNO");
            await _feedClient.SubscribeAsync(segments, cancellationToken);
        }
        if (toUnsubscribe.Length > 0)
        {
            await _feedClient.UnsubscribeAsync(toUnsubscribe, cancellationToken);
            foreach (var token in toUnsubscribe) _bySecurityId.Remove(token);
        }

        _subscribedTokens[underlying] = desiredTokens;

        _logger.LogInformation(
            "CDV: {Underlying} spot={Spot} -> ATM={Atm}, expiry={Expiry}. Tracking CE strikes [{Ce}] and PE strikes [{Pe}].",
            underlying, spot, atm, expiry.Value, string.Join(", ", ceList.OrderBy(v => v)), string.Join(", ", peList.OrderBy(v => v)));
    }

    /// <summary>Unsubscribes every currently-live token for this underlying, drops all the
    /// bookkeeping that points at its (about-to-be-wiped) CdvUnderlyingState, and calls Reset() -
    /// called once by RecenterAsync the moment TradingDay shows yesterday's date. After this
    /// returns, the rest of RecenterAsync's normal EnsureTracked/backfill/subscribe flow runs
    /// exactly as it would for a brand-new CdvUnderlyingState.</summary>
    private async Task ResetForNewDayAsync(string underlying, CdvUnderlyingState state, CancellationToken cancellationToken)
    {
        var tokens = _subscribedTokens[underlying];
        if (tokens.Count > 0)
        {
            await _feedClient.UnsubscribeAsync(tokens, cancellationToken);
            foreach (var token in tokens) _bySecurityId.Remove(token);
        }
        _subscribedTokens[underlying] = new HashSet<uint>();
        _cdvHistorySeeded.Remove(underlying);
        state.Reset();
        _logger.LogInformation("CDV: {Underlying} - new trading day, resetting CDV state.", underlying);
    }

    /// <summary>Fetches and seeds each strike's own last HistoryTradingDays of premium+volume
    /// history - covers both newly-tracked strikes and previously-tracked ones whose earlier
    /// backfill attempt came back empty (see CdvUnderlyingState.NeedsBackfill). See
    /// CdvUnderlyingState.SeedStrikeHistory for what gets seeded (the strike's own candle series
    /// plus its contribution to the CDV backfill) and FinalizeCdvBackfill for how those per-strike
    /// contributions get combined into one series afterward. A contract that fails or comes back
    /// empty (didn't trade the whole window, a transient Dhan error, or Dhan wasn't authenticated
    /// yet) just contributes nothing rather than failing the batch - same tolerance
    /// SpotFeedHostedService's own backfill has. If this was the underlying's first CDV-history
    /// batch and every single strike in it failed, the batch un-marks itself so RecenterAsync's
    /// next cycle retries cleanly instead of leaving CDV history permanently empty.</summary>
    private async Task BackfillStrikesAsync(string underlying, CdvUnderlyingState state, IReadOnlyList<uint> securityIds, decimal currentSpot, CancellationToken cancellationToken)
    {
        var today = DateOnly.FromDateTime(DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(5.5)).DateTime);
        var fromDay = today.AddDays(-HistoryLookbackCalendarDays);
        // The previous-day reference line's target date - a plain weekday-skip, same "accepted
        // approximation" LiveSpreadCalculator's own CDV backfill uses (not exchange-holiday aware;
        // a strike simply contributes nothing for a day it has no bars for, same graceful
        // degradation as everywhere else in this backfill).
        var previousDay = PreviousWeekday(today);
        var seededCount = 0;

        // Only the underlying's very first backfill batch feeds the combined CDV reconstruction -
        // see CdvUnderlyingState.SeedStrikeHistory's includeInCdvHistory doc comment for why a later
        // batch (ATM rolled onto a strike never tracked before) can't retroactively merge into it.
        // Every batch still seeds each strike's own price/volume history regardless, which is what
        // backs that strike's ATM CE/PE chart once it becomes the ATM contract.
        var includeInCdvHistory = _cdvHistorySeeded.Add(underlying);

        for (var i = 0; i < securityIds.Count; i++)
        {
            if (i > 0) await Task.Delay(BackfillCallDelay, cancellationToken);

            var securityId = securityIds[i];
            IReadOnlyList<CandleWithVolume> bars;
            try
            {
                bars = await _historicalData.GetIntradayOptionCandlesAsync(securityId, "NSE_FNO", fromDay, today, 1, cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogDebug(ex, "CDV backfill: request threw for {Underlying} security {SecurityId}", underlying, securityId);
                continue;
            }

            if (bars.Count == 0) continue;

            var trimmed = TrimToRecentTradingDays(bars, HistoryTradingDays);
            if (trimmed.Count == 0) continue;

            // trimmed spans up to HistoryTradingDays for the ATM CE/PE candle+OBV chart (a
            // legitimate multi-day price series), but CDV is day-scoped (see CdvUnderlyingState.
            // Reset) - only today's own slice of that same fetch feeds the CDV reconstruction.
            var todayBars = trimmed.Where(b => IstDate(b.Time) == today).ToList();
            state.SeedStrikeHistory(securityId, trimmed, todayBars, currentSpot, includeInCdvHistory);

            if (includeInCdvHistory)
            {
                var previousDayBars = trimmed.Where(b => IstDate(b.Time) == previousDay).ToList();
                state.SeedPreviousDayStrike(securityId, previousDayBars, currentSpot);
            }

            seededCount++;
        }

        if (includeInCdvHistory)
        {
            if (seededCount == 0)
            {
                // Every strike in the underlying's first CDV-history batch failed - most likely
                // this raced Dhan TOTP auth the same way SpotFeedHostedService's backfill can (see
                // its AuthWaitTimeout doc comment). FinalizeCdvBackfill/FinalizePreviousDay are
                // no-ops with nothing seeded, so there is no partial state to unwind - just undo
                // the mark so the next RecenterAsync cycle (state.NeedsBackfill still true for
                // every strike here, since SeedStrikeHistory never got to set Backfilled) retries
                // this batch as a fresh "first batch" instead of being locked out of CDV history
                // for the rest of the trading day.
                _cdvHistorySeeded.Remove(underlying);
            }
            else
            {
                state.FinalizeCdvBackfill();
                state.FinalizePreviousDay();
            }
        }
        _logger.LogInformation("CDV: backfilled {Seeded}/{Total} contract(s) for {Underlying} (CDV history {Included}).",
            seededCount, securityIds.Count, underlying,
            includeInCdvHistory ? (seededCount > 0 ? "included" : "failed - will retry") : "not included - later batch");
    }

    private static DateOnly PreviousWeekday(DateOnly day)
    {
        var prev = day.AddDays(-1);
        while (prev.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) prev = prev.AddDays(-1);
        return prev;
    }

    /// <summary>Same trimming SpotFeedHostedService.TrimToRecentTradingDays does for the spot chart -
    /// keeps only the most recent HistoryTradingDays distinct IST calendar dates actually present,
    /// so an option contract's backfill covers exactly the same trading days the spot chart does
    /// even though the lookback window asked Dhan for is intentionally wider (to survive holiday
    /// clusters).</summary>
    private static List<CandleWithVolume> TrimToRecentTradingDays(IReadOnlyList<CandleWithVolume> bars, int maxDays)
    {
        var recentDays = bars
            .Select(b => IstDate(b.Time))
            .Distinct()
            .OrderDescending()
            .Take(maxDays)
            .ToHashSet();

        return bars
            .Where(b => recentDays.Contains(IstDate(b.Time)))
            .OrderBy(b => b.Time)
            .ToList();
    }

    private static DateOnly IstDate(DateTimeOffset time) => DateOnly.FromDateTime(time.ToOffset(TimeSpan.FromHours(5.5)).DateTime);

    private void OnTick(SpotTick tick)
    {
        if (!_bySecurityId.TryGetValue(tick.SecurityId, out var state)) return;
        if (!state.IsTracked(tick.SecurityId)) return;

        var spot = _spotFeed.States.TryGetValue(state.Underlying, out var spotState) ? spotState.LastPrice : 0;
        state.ApplyTick(tick, spot);
        _ = BroadcastAsync(state);
    }

    private async Task BroadcastAsync(CdvUnderlyingState state)
    {
        try
        {
            await _hub.Clients.All.SendAsync("cdvUpdate", state.ToSnapshot());
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Failed to broadcast a CDV update for {Underlying}.", state.Underlying);
        }
    }

    public override Task StopAsync(CancellationToken cancellationToken)
    {
        _feedClient.TickReceived -= OnTick;
        return base.StopAsync(cancellationToken);
    }
}

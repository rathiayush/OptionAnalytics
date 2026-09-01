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

    /// <summary>How long an on-demand (untracked) strike's fetched candles are reused before going
    /// back to Dhan - long enough that flipping between strikes in the picker doesn't re-fetch, short
    /// enough that a chart left open during the session still catches up on a refresh.</summary>
    private static readonly TimeSpan OnDemandCandleLifetime = TimeSpan.FromMinutes(2);

    private readonly DhanOptionChainMaster _optionChainMaster;
    private readonly DhanOptionChainQuotes _chainQuotes;
    private readonly DhanMarketFeedClient _feedClient;
    private readonly SpotFeedHostedService _spotFeed;
    private readonly DhanHistoricalDataService _historicalData;
    private readonly IHubContext<SpotHub> _hub;
    private readonly ILogger<CdvHostedService> _logger;

    private readonly Dictionary<uint, CdvUnderlyingState> _bySecurityId = new();
    private readonly Dictionary<string, HashSet<uint>> _subscribedTokens = new();

    /// <summary>Fetched-on-demand candles for strikes this app doesn't track, keyed by contract and
    /// IST trading day (so yesterday's entry can never be served today). Guarded by its own lock -
    /// unlike the rest of this service's state it is touched from request threads, not just the
    /// background recenter loop.</summary>
    private readonly Dictionary<(uint SecurityId, DateOnly Day), (DateTimeOffset FetchedAt, IReadOnlyList<Candle> Candles)> _onDemandCandles = new();

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
        DhanOptionChainQuotes chainQuotes,
        DhanMarketFeedClient feedClient,
        SpotFeedHostedService spotFeed,
        DhanHistoricalDataService historicalData,
        IHubContext<SpotHub> hub,
        ILogger<CdvHostedService> logger)
    {
        _optionChainMaster = optionChainMaster;
        _chainQuotes = chainQuotes;
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

    /// <summary>This underlying's strike step (50 for NIFTY, 100 for BANKNIFTY), or 0 if unknown.</summary>
    public int StepFor(string underlying) =>
        Underlyings.FirstOrDefault(u => string.Equals(u.Underlying, underlying, StringComparison.OrdinalIgnoreCase)).Step;

    /// <summary>
    /// The strikes the dashboard's option-chart picker offers: <paramref name="spanSteps"/> steps
    /// either side of the current ATM, on the nearest expiry, filtered to the ones actually listed
    /// in the scrip master. Wider than the ATM+-8 window CDV subscribes to, deliberately - a chart
    /// only needs history, and GetStrikeCandlesAsync can fetch that for any listed strike, so the
    /// picker is not limited to the strikes this app happens to be tracking live. Each entry says
    /// which it is.
    ///
    /// Live premium and open interest are then merged in from Dhan's Option Chain API when that call
    /// is available - see DhanOptionChainQuotes for why that is decoration only and never the source
    /// of the strike list itself.
    /// </summary>
    public async Task<OptionChainResponse?> GetChainAsync(string underlying, int spanSteps, CancellationToken cancellationToken)
    {
        if (!States.TryGetValue(underlying, out var state)) return null;

        var step = StepFor(underlying);
        var atm = state.AtmStrike;
        var expiry = state.Expiry;

        if (atm is null || expiry is null || step <= 0)
            return new OptionChainResponse(underlying, expiry, atm, step, false, Array.Empty<OptionChainStrike>());

        try
        {
            await _optionChainMaster.EnsureLoadedAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogDebug(ex, "Could not refresh the option chain master for {Underlying}'s strike picker.", underlying);
        }

        var trackedCe = state.GetTrackedStrikePrices(true).ToHashSet();
        var trackedPe = state.GetTrackedStrikePrices(false).ToHashSet();

        var quotes = await GetChainQuotesAsync(underlying, expiry.Value, cancellationToken);
        var quotesByStrike = quotes.ToDictionary(q => q.Strike);

        var strikes = new List<OptionChainStrike>();
        for (var i = -spanSteps; i <= spanSteps; i++)
        {
            var strike = atm.Value + i * step;

            // A strike is offered only if BOTH legs are listed - the picker drives a CE chart and a
            // PE chart side by side, so a strike with only one of them would leave half the page
            // permanently empty.
            if (_optionChainMaster.Find(underlying, expiry.Value, strike, true) is null) continue;
            if (_optionChainMaster.Find(underlying, expiry.Value, strike, false) is null) continue;

            quotesByStrike.TryGetValue(strike, out var quote);
            strikes.Add(new OptionChainStrike(
                strike,
                Tracked: trackedCe.Contains(strike) && trackedPe.Contains(strike),
                IsAtm: strike == atm.Value,
                CeLastPrice: quote?.CeLastPrice,
                CeOpenInterest: quote?.CeOpenInterest,
                PeLastPrice: quote?.PeLastPrice,
                PeOpenInterest: quote?.PeOpenInterest));
        }

        return new OptionChainResponse(underlying, expiry, atm, step, quotes.Count > 0, strikes);
    }

    private async Task<IReadOnlyList<DhanOptionChainQuote>> GetChainQuotesAsync(string underlying, DateOnly expiry, CancellationToken cancellationToken)
    {
        var instrument = _spotFeed.States.TryGetValue(underlying, out var spotState) ? spotState.Instrument : null;
        if (instrument is null) return Array.Empty<DhanOptionChainQuote>();

        return await _chainQuotes.GetQuotesAsync(instrument.SecurityId, instrument.DhanSegment, expiry, cancellationToken);
    }

    /// <summary>
    /// One strike's premium candles for the dashboard chart. Tracked strikes (inside, or previously
    /// inside today, the CDV ATM+-8 window) answer straight from memory including the still-forming
    /// bar, exactly as the ATM charts do. Any other listed strike is fetched from Dhan's intraday
    /// history on demand and cached briefly - that history is complete but static, so such a chart
    /// shows the same days as the tracked ones but only advances when re-fetched, which is the
    /// trade-off for being able to look at a strike this app never subscribed to.
    /// </summary>
    public async Task<IReadOnlyList<Candle>> GetStrikeCandlesAsync(string underlying, decimal strike, bool isCall, CancellationToken cancellationToken)
    {
        if (!States.TryGetValue(underlying, out var state)) return Array.Empty<Candle>();

        // A tracked strike with a genuinely empty series (tracked seconds ago, nothing seeded yet)
        // still counts as tracked - GetStrikeCandles returns null only when it isn't tracked at all.
        if (state.GetStrikeCandles(strike, isCall) is { } tracked && tracked.Count > 0) return tracked;

        var expiry = state.Expiry;
        if (expiry is null) return Array.Empty<Candle>();

        var contract = _optionChainMaster.Find(underlying, expiry.Value, strike, isCall);
        if (contract is null) return Array.Empty<Candle>();

        var cacheKey = (contract.SecurityId, DateOnly.FromDateTime(DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(5.5)).DateTime));
        lock (_onDemandCandles)
        {
            if (_onDemandCandles.TryGetValue(cacheKey, out var cached) && DateTimeOffset.UtcNow - cached.FetchedAt < OnDemandCandleLifetime)
                return cached.Candles;
        }

        var today = cacheKey.Item2;
        var fromDay = today.AddDays(-HistoryLookbackCalendarDays);

        IReadOnlyList<CandleWithVolume> bars;
        try
        {
            bars = await _historicalData.GetIntradayOptionCandlesAsync(contract.SecurityId, "NSE_FNO", fromDay, today, 1, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogDebug(ex, "On-demand candle fetch threw for {Underlying} {Strike}{Type}", underlying, strike, isCall ? "CE" : "PE");
            return Array.Empty<Candle>();
        }

        // Same trading-day trim the tracked strikes get, so an on-demand chart covers exactly the
        // same span as a tracked one rather than a wider one just because it was fetched differently.
        var candles = TrimToRecentTradingDays(bars, HistoryTradingDays)
            .Select(b => new Candle(b.Time, b.Open, b.High, b.Low, b.Close))
            .ToList();

        lock (_onDemandCandles) { _onDemandCandles[cacheKey] = (DateTimeOffset.UtcNow, candles); }
        return candles;
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

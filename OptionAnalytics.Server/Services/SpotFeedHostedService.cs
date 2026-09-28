using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Hubs;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// The orchestrator: resolves NIFTY/BANKNIFTY/SENSEX's Dhan security ids, backfills the last
/// HistoryWindow.TradingDays trading days' 1-minute candles into memory (nothing is ever persisted
/// to disk - a restart re-fetches from Dhan every time), then runs the live WS feed and folds every
/// tick into the current bar, pushing each update to the dashboard over SignalR.
/// </summary>
public sealed class SpotFeedHostedService : BackgroundService
{
    /// <summary>Strike-step rounding used for the "round figure" price shown under the chart - the
    /// same step each index's own option chain uses (50 for NIFTY, 100 for BANKNIFTY and SENSEX).
    /// NIFTY/BANKNIFTY are NSE-listed, SENSEX is BSE-listed - a different exchange, not just
    /// another symbol - but DhanSpotInstrumentMaster.FindSpot resolves either one identically by
    /// name, so nothing else here needs to know which exchange a given underlying is actually on.</summary>
    private static readonly (string Underlying, int Step)[] Underlyings =
    {
        ("NIFTY", 50),
        ("BANKNIFTY", 100),
        ("SENSEX", 100),
    };

    /// <summary>Shared with CdvHostedService's own backfill - see HistoryWindow for why the spot
    /// chart and the option charts must reach back exactly as far as each other.</summary>
    private const int HistoryTradingDays = HistoryWindow.TradingDays;
    private const int HistoryLookbackCalendarDays = HistoryWindow.LookbackCalendarDays;

    private readonly DhanOptions _options;
    private readonly DhanSession _session;
    private readonly DhanSpotInstrumentMaster _instrumentMaster;
    private readonly DhanHistoricalDataService _historicalData;
    private readonly DhanMarketFeedClient _feedClient;
    private readonly IHubContext<SpotHub> _hub;
    private readonly ILogger<SpotFeedHostedService> _logger;

    private readonly Dictionary<uint, SpotUnderlyingState> _bySecurityId = new();

    // Tracks the last IST calendar day OnTick trimmed each state's candle history on - see OnTick's
    // own comment for why this exists at all.
    private DateOnly? _lastTrimmedDay;

    public SpotFeedHostedService(
        IOptions<DhanOptions> options,
        DhanSession session,
        DhanSpotInstrumentMaster instrumentMaster,
        DhanHistoricalDataService historicalData,
        DhanMarketFeedClient feedClient,
        IHubContext<SpotHub> hub,
        ILogger<SpotFeedHostedService> logger)
    {
        _options = options.Value;
        _session = session;
        _instrumentMaster = instrumentMaster;
        _historicalData = historicalData;
        _feedClient = feedClient;
        _hub = hub;
        _logger = logger;

        States = Underlyings.ToDictionary(u => u.Underlying, u => new SpotUnderlyingState(u.Underlying, u.Step));
    }

    /// <summary>Read by SpotController for the REST endpoints - keyed by underlying name.</summary>
    public IReadOnlyDictionary<string, SpotUnderlyingState> States { get; }

    /// <summary>How long to wait for TOTP auto-login before backfilling anyway. Generous on
    /// purpose: DhanTotpAutoRenewalHostedService's own retry can hit Dhan's real "once every 2
    /// minutes" generateAccessToken cooldown (a confirmed real case, not just theoretical), which a
    /// short wait would lose the race against every time - the historical endpoint would then
    /// report "not authenticated" and this app would be stuck with zero history for the rest of the
    /// run, since backfill previously never got a second attempt. 3 minutes comfortably covers that
    /// worst case with room to spare.</summary>
    private static readonly TimeSpan AuthWaitTimeout = TimeSpan.FromMinutes(3);

    /// <summary>How long RetryBackfillIfNeededAsync waits before its FIRST re-check, doubling from
    /// there up to RetryBackfillMaxInterval. That retry never gives up (see its own doc comment);
    /// MaxBackfillRetries now only decides how many attempts are logged at Information before the
    /// rest drop to Debug.</summary>
    private static readonly TimeSpan BackfillRetryInterval = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan RetryBackfillMaxInterval = TimeSpan.FromMinutes(5);
    private const int MaxBackfillRetries = 15;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.HasSession && !_options.HasTotpCredentials)
        {
            _logger.LogWarning("Neither Dhan:AccessToken nor Dhan:Pin/Dhan:TotpSecret are configured - the spot feed will not authenticate until one of them is set.");
        }
        else if (_options.HasTotpCredentials)
        {
            // TOTP auto-login runs concurrently in its own hosted service (see
            // DhanTotpAutoRenewalHostedService) - wait for it so the historical backfill below has
            // a live token on its first attempt rather than routinely losing that race on a fresh
            // boot. Not fatal if it still doesn't finish in time (network trouble, Dhan down) -
            // RetryBackfillIfNeededAsync below is the real safety net for that.
            var waited = TimeSpan.Zero;
            while (!_session.IsAuthenticated && waited < AuthWaitTimeout && !stoppingToken.IsCancellationRequested)
            {
                await Task.Delay(500, stoppingToken);
                waited += TimeSpan.FromMilliseconds(500);
            }
        }

        try
        {
            await ResolveInstrumentsAsync(stoppingToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Never fatal. An unhandled exception out of ExecuteAsync does not just stop THIS
            // service - .NET's default BackgroundServiceExceptionBehavior stops the whole host, so
            // the container dies and (restart: unless-stopped) comes back to do it again. One
            // underlying's resolve failing must not be able to do that.
            _logger.LogError(ex, "Resolving spot instruments failed - continuing with whatever resolved, the retry loop below re-attempts backfill.");
        }

        await BackfillAsync(stoppingToken);

        _feedClient.TickReceived += OnTick;

        var tokenSegments = _bySecurityId.ToDictionary(kv => kv.Key, kv => kv.Value.Instrument!.DhanSegment);
        try
        {
            await _feedClient.SubscribeAsync(tokenSegments, stoppingToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // The whole subscription goes up in ONE batched message covering every underlying, and
            // they no longer share an exchange - so a token Dhan won't accept (a BSE index on an
            // account entitled to NSE only) is a plausible way for this single call to fail. Losing
            // the live feed is bad; taking the host down with it, and with it the backfilled history
            // and every backtest that reads it, is far worse.
            _logger.LogError(ex, "Subscribing the spot feed failed for {Count} instrument(s) - backfilled history is still served, but live ticks will not flow until the feed reconnects.", tokenSegments.Count);
        }

        // Live ticks are already flowing by now regardless of whether backfill above actually got
        // any history - this runs alongside them, not blocking anything, so a slow/failed first
        // backfill attempt (auth still not ready, a transient Dhan hiccup) still ends up with real
        // history instead of being stuck at zero for the rest of the run.
        _ = RetryBackfillIfNeededAsync(stoppingToken);

        // See WatchForStaleTicksAsync's own doc comment for why this exists alongside
        // DhanMarketFeedClient's own connection-wide stall watchdog, not instead of it.
        _ = WatchForStaleTicksAsync(stoppingToken);
    }

    /// <summary>How long a spot instrument may go without a live tick, during market hours, before
    /// this service suspects Dhan silently dropped just ITS OWN subscription. DhanMarketFeedClient's
    /// shared FeedStallDetector judges the WHOLE connection - any message, from ANY instrument (an
    /// option strike, a futures contract), counts as proof the feed is alive (see its own doc
    /// comment: "liveness being tracked, not usefulness") - so as long as CdvHostedService/
    /// OiReplayLiveFeedService keep seeing their own ticks, that watchdog never fires, even if
    /// Dhan silently stopped sending just the spot/index token specifically. This is the narrower,
    /// per-instrument check that catches exactly that case: a live spot index ticks essentially
    /// continuously during market hours (unlike a deep OTM strike, which can legitimately go quiet
    /// for a stretch), so 90 seconds of silence on it specifically, while the connection is
    /// otherwise clearly alive, is a real signal rather than a normal lull.</summary>
    private static readonly TimeSpan SpotStaleThreshold = TimeSpan.FromSeconds(90);
    private static readonly TimeSpan StaleCheckInterval = TimeSpan.FromSeconds(30);

    // NSE/BSE's regular equity/derivatives session - re-subscribing outside these hours would just
    // manufacture warnings every day for a feed that is silent for the entirely ordinary reason that
    // the market itself is closed.
    private static readonly TimeOnly MarketOpen = new(9, 15);
    private static readonly TimeOnly MarketClose = new(15, 30);

    private async Task WatchForStaleTicksAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            if (!await DelayAsync(StaleCheckInterval, stoppingToken)) return;

            var timeOfDayIst = TimeOnly.FromDateTime(DateTimeOffset.UtcNow.ToOffset(IstClock.Offset).DateTime);
            if (timeOfDayIst < MarketOpen || timeOfDayIst > MarketClose) continue;

            var stale = _bySecurityId
                .Where(kv => DateTimeOffset.UtcNow - kv.Value.LastUpdateUtc > SpotStaleThreshold)
                .ToArray();
            if (stale.Length == 0) continue;

            _logger.LogWarning(
                "Spot feed: {Underlyings} had no live tick in over {Seconds}s during market hours while the shared feed connection is otherwise alive - re-sending their subscription in case Dhan silently dropped just these.",
                string.Join(", ", stale.Select(kv => kv.Value.Underlying)), SpotStaleThreshold.TotalSeconds);

            try
            {
                await _feedClient.ResendSubscriptionsForAsync(stale.Select(kv => kv.Key), stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogWarning(ex, "Spot feed: re-subscribing stale instrument(s) failed - the connection-wide watchdog will still catch a genuinely dead connection.");
            }
        }
    }

    private static async Task<bool> DelayAsync(TimeSpan delay, CancellationToken cancellationToken)
    {
        try { await Task.Delay(delay, cancellationToken); return true; }
        catch (OperationCanceledException) { return false; }
    }

    /// <summary>Keeps retrying BackfillAsync for as long as ANY underlying still has zero candles -
    /// the fallback for "market's closed / Dhan was briefly unreachable / auth wasn't ready yet".
    ///
    /// Deliberately UNBOUNDED, retrying slowly forever rather than giving up. It used to stop after
    /// MaxBackfillRetries (15 x 20s, about five minutes), and that cap was the difference between an
    /// underlying with history and one permanently without: spot is backfilled ONCE at startup, so
    /// when those five minutes ran out before Dhan auth was usable - a token that expired overnight
    /// and is waiting on TOTP renewal, a restart before the market opens - the spot series stayed
    /// empty for the entire life of the process, and every backtest reading it found no signals at
    /// all. CdvHostedService never had this problem because its own recenter loop re-backfills
    /// option strikes every cycle, indefinitely. That asymmetry is exactly why option data could be
    /// flowing on the dashboard while spot sat null underneath it.
    ///
    /// Instruments are re-resolved whenever any underlying still has none, for the same reason: a
    /// scrip master that hadn't downloaded yet on the first pass leaves Instrument null, and
    /// BackfillAsync skips an underlying in that state - so retrying the backfill alone would never
    /// have recovered it however many attempts it was given.
    ///
    /// The interval backs off to RetryBackfillMaxInterval so an underlying that legitimately has no
    /// data (an exchange this account holds no entitlement for) costs one quiet call every few
    /// minutes rather than a tight loop - while still meaning spot recovers on its own once a token
    /// is renewed or the market opens, with no restart needed.</summary>
    private async Task RetryBackfillIfNeededAsync(CancellationToken stoppingToken)
    {
        var delay = BackfillRetryInterval;

        for (var attempt = 1; !stoppingToken.IsCancellationRequested; attempt++)
        {
            // GetClosedCandles(), never GetCandles() - the latter also counts the still-forming live
            // bar, so a single stray tick (even a bogus post-connect snapshot with no real trade
            // behind it - see DhanTickPacketParser.ReadEpoch's own doc comment) would satisfy this
            // check and stop the retry loop for good, permanently leaving an underlying with a
            // real backfill history of zero candles that nothing ever asks Dhan for again.
            if (States.Values.All(s => s.GetClosedCandles().Count > 0)) return;

            try
            {
                await Task.Delay(delay, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            var empty = States.Values.Where(s => s.GetClosedCandles().Count == 0).Select(s => s.Underlying).ToArray();
            if (empty.Length == 0) return;

            // Log the first few attempts at Information and everything after that at Debug: the
            // early ones are the ordinary startup race and worth seeing, while a permanently empty
            // underlying must not spend the rest of the run writing a warning every few minutes.
            if (attempt <= MaxBackfillRetries)
                _logger.LogInformation("Spot backfill retry {Attempt}: still no history for {Underlyings}.", attempt, string.Join(", ", empty));
            else
                _logger.LogDebug("Spot backfill retry {Attempt}: still no history for {Underlyings}.", attempt, string.Join(", ", empty));

            // A late scrip master leaves Instrument null, which BackfillAsync skips outright - so
            // re-resolve before retrying rather than retrying a fetch that cannot run.
            if (States.Values.Any(s => s.Instrument is null))
                await ResolveInstrumentsAsync(stoppingToken);

            await BackfillAsync(stoppingToken, onlyIfEmpty: true);

            if (delay < RetryBackfillMaxInterval)
                delay = TimeSpan.FromTicks(Math.Min(delay.Ticks * 2, RetryBackfillMaxInterval.Ticks));
        }
    }

    private async Task ResolveInstrumentsAsync(CancellationToken cancellationToken)
    {
        try
        {
            await _instrumentMaster.EnsureLoadedAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "Could not load the Dhan scrip master - NIFTY/BANKNIFTY cannot be resolved yet. Will retry as the feed loop runs.");
        }

        foreach (var (underlying, _) in Underlyings)
        {
            var instrument = _instrumentMaster.FindSpot(underlying);
            if (instrument is null)
            {
                _logger.LogWarning("Could not resolve a Dhan spot instrument for {Underlying} - it will not stream until the scrip master is refreshed.", underlying);
                continue;
            }

            States[underlying].Instrument = instrument;
            _bySecurityId[instrument.SecurityId] = States[underlying];
        }
    }

    /// <summary>Fetches the last HistoryLookbackCalendarDays' worth of candles in ONE range call
    /// per underlying (far cheaper than one request per day), then trims to the most recent
    /// HistoryTradingDays distinct trading days actually present in the response - everything held
    /// in memory only, nothing persisted, so this runs fresh on every restart.
    ///
    /// <paramref name="onlyIfEmpty"/> (set by RetryBackfillIfNeededAsync) skips an underlying that
    /// already has candles instead of unconditionally re-fetching and reseeding it. Without this, a
    /// retry fired because SOME OTHER underlying was still empty (a slow scrip-master resolve, a
    /// transient Dhan hiccup) would ALSO silently replace an underlying that already had perfectly
    /// good history - either from its own first backfill, or built up since purely from live ticks
    /// (SeedHistory does a full clear-and-replace, with no BarClosed event to mark that this just
    /// happened). Dhan's historical endpoint reconstructs a bar's OHLC independently of this app's
    /// own live-tick folding, and the two need not agree to the last paisa for a bar still settling
    /// intraday - close enough to matter nothing normally, but enough to occasionally flip which
    /// side of a border-line EMA9/21 an already-alerted bar's close falls on, producing a spurious
    /// "confirmed direction changed" a moment later that doesn't correspond to any real price move a
    /// user watching the chart would ever see. An underlying that already has data needs no second
    /// backfill at all - only ever the ones the retry loop exists for.</summary>
    private async Task BackfillAsync(CancellationToken cancellationToken, bool onlyIfEmpty = false)
    {
        var today = IstToday();
        var fromDay = today.AddDays(-HistoryLookbackCalendarDays);

        foreach (var state in States.Values)
        {
            if (state.Instrument is not { } instrument) continue;
            // GetClosedCandles(), not GetCandles() - see RetryBackfillIfNeededAsync's own comment on
            // this same distinction. Without it, an underlying whose backfill genuinely returned zero
            // candles but has since received one live tick (building only a still-forming _currentBar)
            // reads as "already has data" here and is skipped on every future retry forever.
            if (onlyIfEmpty && state.GetClosedCandles().Count > 0) continue;

            // Per-underlying, for the same reason CdvHostedService.RecenterAllAsync isolates its own
            // loop: these underlyings no longer even share an exchange (NIFTY/BANKNIFTY are NSE,
            // SENSEX is BSE), so one of them can fail for reasons that say nothing about the others -
            // a data entitlement the account doesn't have, an instrument Dhan won't serve history
            // for. Without this, the FIRST such failure aborts the whole loop and every underlying
            // after it in the dictionary silently gets no history at all; and since this is awaited
            // straight from ExecuteAsync, before the tick handler and the feed subscription are even
            // wired up, it would take the entire spot feed - live ticks included - down with it.
            try
            {
                var (candles, error) = await _historicalData.GetIntradayCandlesAsync(instrument.SecurityId, instrument.DhanSegment, fromDay, today, 1, cancellationToken, interactive: false);

                var trimmed = TrimToRecentTradingDays(candles, HistoryTradingDays, c => c.Time);
                state.SeedHistory(trimmed.Select(c => c.ToCandle()));
                state.SeedVolumeHistory(trimmed);

                var dayCount = trimmed.Select(c => IstDate(c.Time)).Distinct().Count();
                _logger.LogInformation("Backfilled {Count} candle(s) across {Days} trading day(s) for {Underlying}.", trimmed.Count, dayCount, state.Underlying);

                if (trimmed.Count == 0)
                    _logger.LogWarning("Backfill returned NO candles for {Underlying} ({Segment}:{Id}) - it will chart nothing and any backtest on it finds no signals. Check whether this account is entitled to that exchange's data. {Error}",
                        state.Underlying, instrument.DhanSegment, instrument.SecurityId, error);
                // Real index volume is a January 2026 Dhan rollout (see DhanHistoricalDataService's
                // own doc comment) - worth a loud, one-time-per-backfill signal if this account's own
                // Dhan plan/segment isn't actually delivering it despite that rollout, since nothing
                // else here would ever surface that: a strategy reading VwapCalculator off an
                // all-zero-volume series simply finds no VWAP at any bar and quietly takes no trades,
                // which looks identical to "the strategy's other conditions never lined up" from the
                // Backtrack page alone.
                else if (trimmed.All(c => c.Volume == 0))
                    _logger.LogWarning("Backfill for {Underlying} ({Segment}:{Id}) returned {Count} candle(s), all with ZERO volume - a VWAP-based strategy will find no confirmation at any bar for this underlying. Dhan is expected to report real index volume for spot/index bars since January 2026; if this persists, check whether this account's own Dhan plan/data subscription actually includes it.",
                        state.Underlying, instrument.DhanSegment, instrument.SecurityId, trimmed.Count);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "Backfill FAILED for {Underlying} ({Segment}:{Id}) - leaving it empty and continuing with the other underlyings.",
                    state.Underlying, instrument.DhanSegment, instrument.SecurityId);
            }
        }
    }

    /// <summary>Keeps only the candles from the most recent <paramref name="maxDays"/> distinct
    /// IST calendar dates present in <paramref name="candles"/> - Dhan's range response may
    /// legitimately span more days than that (the lookback window is intentionally generous to
    /// survive holiday clusters), so this is what actually enforces "last HistoryTradingDays trading
    /// days". Generic over the candle shape (Candle or CandleWithVolume) via <paramref name="time"/>
    /// rather than duplicated per shape.</summary>
    private static List<T> TrimToRecentTradingDays<T>(IReadOnlyList<T> candles, int maxDays, Func<T, DateTimeOffset> time)
    {
        var recentDays = candles
            .Select(c => IstDate(time(c)))
            .Distinct()
            .OrderDescending()
            .Take(maxDays)
            .ToHashSet();

        return candles
            .Where(c => recentDays.Contains(IstDate(time(c))))
            .OrderBy(time)
            .ToList();
    }

    private static DateOnly IstDate(DateTimeOffset time) => IstClock.IstDate(time);

    private void OnTick(SpotTick tick)
    {
        if (!_bySecurityId.TryGetValue(tick.SecurityId, out var state)) return;

        state.ApplyTick(tick);
        TrimHistoryOnceDaily();
        _ = BroadcastAsync(state);
    }

    /// <summary>SpotUnderlyingState.ApplyTick only ever APPENDS a closed candle - BackfillAsync's
    /// "last HistoryTradingDays trading days" trim only ever runs once, at startup (and a few times
    /// more if RetryBackfillIfNeededAsync is still catching up on a slow first attempt). Without
    /// this, a process left running for weeks would keep every candle it had ever seen in memory
    /// forever, unbounded, and GetCandles() would silently drift from the "last N trading days" the
    /// dashboard chart is documented to show into "everything since the container last restarted".
    /// Re-trims once per IST calendar day (checked cheaply on every tick, so a quiet weekend/holiday
    /// with no ticks just delays the next trim rather than needing its own timer) using the exact
    /// same TrimToRecentTradingDays + SeedHistory reuse BackfillAsync itself already relies on -
    /// SeedHistory's clear-then-replace is exactly "trim in place", no new mutator needed.</summary>
    private void TrimHistoryOnceDaily()
    {
        var today = IstToday();
        if (_lastTrimmedDay == today) return;
        _lastTrimmedDay = today;

        foreach (var state in States.Values)
        {
            state.SeedHistory(TrimToRecentTradingDays(state.GetClosedCandles(), HistoryTradingDays, c => c.Time));
            state.SeedVolumeHistory(TrimToRecentTradingDays(state.GetClosedVolumeBars(), HistoryTradingDays, c => c.Time));
        }
    }

    private async Task BroadcastAsync(SpotUnderlyingState state)
    {
        try
        {
            await _hub.Clients.Group($"u:{state.Underlying}").SendAsync("spotUpdate", state.ToSnapshot());
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Failed to broadcast a spot update for {Underlying}.", state.Underlying);
        }
    }

    /// <summary>Today's date in IST (UTC+5:30, a fixed offset - no DST, no tzdata lookup needed).</summary>
    private static DateOnly IstToday() => IstClock.Today();

    public override Task StopAsync(CancellationToken cancellationToken)
    {
        // DhanMarketFeedClient's connection lifecycle (including disposal) is owned by
        // DhanMarketFeedHostedService, which this service shares the client singleton with.
        _feedClient.TickReceived -= OnTick;
        return base.StopAsync(cancellationToken);
    }
}

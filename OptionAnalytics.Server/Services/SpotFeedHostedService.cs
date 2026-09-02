using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Hubs;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// The orchestrator: resolves NIFTY/BANKNIFTY's Dhan security ids, backfills the last 5 trading
/// days' 1-minute candles into memory (nothing is ever persisted to disk - a restart re-fetches
/// from Dhan every time), then runs the live WS feed and folds every tick into the current bar,
/// pushing each update to the dashboard over SignalR.
/// </summary>
public sealed class SpotFeedHostedService : BackgroundService
{
    /// <summary>Strike-step rounding used for the "round figure" price shown under the chart -
    /// the same step NSE index option chains use (50 for NIFTY, 100 for BANKNIFTY).</summary>
    private static readonly (string Underlying, int Step)[] Underlyings =
    {
        ("NIFTY", 50),
        ("BANKNIFTY", 100),
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

    /// <summary>How long RetryBackfillIfNeededAsync waits between checking whether any underlying
    /// still has zero history, and how many times it tries before giving up.</summary>
    private static readonly TimeSpan BackfillRetryInterval = TimeSpan.FromSeconds(20);
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

        await ResolveInstrumentsAsync(stoppingToken);
        await BackfillAsync(stoppingToken);

        _feedClient.TickReceived += OnTick;

        var tokenSegments = _bySecurityId.ToDictionary(kv => kv.Key, kv => kv.Value.Instrument!.DhanSegment);
        await _feedClient.SubscribeAsync(tokenSegments, stoppingToken);

        // Live ticks are already flowing by now regardless of whether backfill above actually got
        // any history - this runs alongside them, not blocking anything, so a slow/failed first
        // backfill attempt (auth still not ready, a transient Dhan hiccup) still ends up with real
        // history instead of being stuck at zero for the rest of the run.
        _ = RetryBackfillIfNeededAsync(stoppingToken);
    }

    /// <summary>Keeps retrying BackfillAsync, on an interval, for as long as ANY underlying still
    /// has zero candles - the actual fallback for "market's closed / Dhan was briefly unreachable /
    /// auth wasn't ready yet" instead of a single one-shot attempt with no second chance.</summary>
    private async Task RetryBackfillIfNeededAsync(CancellationToken stoppingToken)
    {
        for (var attempt = 0; attempt < MaxBackfillRetries && !stoppingToken.IsCancellationRequested; attempt++)
        {
            if (States.Values.All(s => s.GetCandles().Count > 0)) return;

            await Task.Delay(BackfillRetryInterval, stoppingToken);
            if (stoppingToken.IsCancellationRequested) return;

            _logger.LogInformation("Spot backfill retry {Attempt}/{Max}: at least one underlying still has no history.", attempt + 1, MaxBackfillRetries);
            await BackfillAsync(stoppingToken);
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
    /// in memory only, nothing persisted, so this runs fresh on every restart.</summary>
    private async Task BackfillAsync(CancellationToken cancellationToken)
    {
        var today = IstToday();
        var fromDay = today.AddDays(-HistoryLookbackCalendarDays);

        foreach (var state in States.Values)
        {
            if (state.Instrument is not { } instrument) continue;

            var candles = await _historicalData.GetIntradayCandlesAsync(instrument.SecurityId, instrument.DhanSegment, fromDay, today, 1, cancellationToken);

            var trimmed = TrimToRecentTradingDays(candles, HistoryTradingDays);
            state.SeedHistory(trimmed);

            var dayCount = trimmed.Select(c => IstDate(c.Time)).Distinct().Count();
            _logger.LogInformation("Backfilled {Count} candle(s) across {Days} trading day(s) for {Underlying}.", trimmed.Count, dayCount, state.Underlying);
        }
    }

    /// <summary>Keeps only the candles from the most recent <paramref name="maxDays"/> distinct
    /// IST calendar dates present in <paramref name="candles"/> - Dhan's range response may
    /// legitimately span more days than that (the lookback window is intentionally generous to
    /// survive holiday clusters), so this is what actually enforces "last 5 trading days".</summary>
    private static List<Candle> TrimToRecentTradingDays(IReadOnlyList<Candle> candles, int maxDays)
    {
        var recentDays = candles
            .Select(c => IstDate(c.Time))
            .Distinct()
            .OrderDescending()
            .Take(maxDays)
            .ToHashSet();

        return candles
            .Where(c => recentDays.Contains(IstDate(c.Time)))
            .OrderBy(c => c.Time)
            .ToList();
    }

    private static DateOnly IstDate(DateTimeOffset time) => DateOnly.FromDateTime(time.ToOffset(TimeSpan.FromHours(5.5)).DateTime);

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
            state.SeedHistory(TrimToRecentTradingDays(state.GetClosedCandles(), HistoryTradingDays));
    }

    private async Task BroadcastAsync(SpotUnderlyingState state)
    {
        try
        {
            await _hub.Clients.All.SendAsync("spotUpdate", state.ToSnapshot());
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Failed to broadcast a spot update for {Underlying}.", state.Underlying);
        }
    }

    /// <summary>Today's date in IST (UTC+5:30, a fixed offset - no DST, no tzdata lookup needed).</summary>
    private static DateOnly IstToday() => DateOnly.FromDateTime(DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(5.5)).DateTime);

    public override Task StopAsync(CancellationToken cancellationToken)
    {
        // DhanMarketFeedClient's connection lifecycle (including disposal) is owned by
        // DhanMarketFeedHostedService, which this service shares the client singleton with.
        _feedClient.TickReceived -= OnTick;
        return base.StopAsync(cancellationToken);
    }
}

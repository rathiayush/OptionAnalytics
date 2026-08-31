using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Hubs;
using OptionAnalytics.Server.Storage;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// The orchestrator: resolves NIFTY/BANKNIFTY's Dhan security ids, backfills today's (or the
/// previous trading day's, before the market opens) candles so the chart isn't empty on load,
/// then runs the live WS feed and folds every tick into the current 1-minute bar, pushing each
/// update to the dashboard over SignalR.
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

    private readonly DhanOptions _options;
    private readonly DhanSession _session;
    private readonly DhanSpotInstrumentMaster _instrumentMaster;
    private readonly DhanHistoricalDataService _historicalData;
    private readonly DhanMarketFeedClient _feedClient;
    private readonly CandleRepository _candleRepository;
    private readonly IHubContext<SpotHub> _hub;
    private readonly ILogger<SpotFeedHostedService> _logger;

    private readonly Dictionary<uint, SpotUnderlyingState> _bySecurityId = new();

    public SpotFeedHostedService(
        IOptions<DhanOptions> options,
        DhanSession session,
        DhanSpotInstrumentMaster instrumentMaster,
        DhanHistoricalDataService historicalData,
        DhanMarketFeedClient feedClient,
        CandleRepository candleRepository,
        IHubContext<SpotHub> hub,
        ILogger<SpotFeedHostedService> logger)
    {
        _options = options.Value;
        _session = session;
        _instrumentMaster = instrumentMaster;
        _historicalData = historicalData;
        _feedClient = feedClient;
        _candleRepository = candleRepository;
        _hub = hub;
        _logger = logger;

        States = Underlyings.ToDictionary(u => u.Underlying, u => new SpotUnderlyingState(u.Underlying, u.Step));
    }

    /// <summary>Read by SpotController for the REST endpoints - keyed by underlying name.</summary>
    public IReadOnlyDictionary<string, SpotUnderlyingState> States { get; }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.HasSession && !_options.HasTotpCredentials)
        {
            _logger.LogWarning("Neither Dhan:AccessToken nor Dhan:Pin/Dhan:TotpSecret are configured - the spot feed will not authenticate until one of them is set.");
        }
        else if (_options.HasTotpCredentials)
        {
            // TOTP auto-login runs concurrently in its own hosted service (see
            // DhanTotpAutoRenewalHostedService) - give it a short head start so the historical
            // backfill below has a live token on its very first attempt instead of always losing
            // that race on a fresh boot. Not fatal if it doesn't finish in time: the backfill just
            // logs "not authenticated" and the live WS feed (which polls the session in a loop)
            // still catches up moments later.
            for (var i = 0; i < 20 && !_session.IsAuthenticated && !stoppingToken.IsCancellationRequested; i++)
                await Task.Delay(500, stoppingToken);
        }

        await ResolveInstrumentsAsync(stoppingToken);
        await BackfillAsync(stoppingToken);

        _feedClient.TickReceived += OnTick;

        var tokenSegments = _bySecurityId.ToDictionary(kv => kv.Key, kv => kv.Value.Instrument!.DhanSegment);
        await _feedClient.SubscribeAsync(tokenSegments, stoppingToken);
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

    private async Task BackfillAsync(CancellationToken cancellationToken)
    {
        var today = IstToday();

        foreach (var state in States.Values)
        {
            if (state.Instrument is not { } instrument) continue;

            // Recovers today's already-seen bars from TimescaleDB first (near-instant, no Dhan
            // call) - useful after a restart mid-day, when CandlePersistenceService has already
            // written earlier bars this session. Empty on a fresh day/first-ever run (nothing
            // persisted yet), which falls through to the Dhan REST backfill below exactly as
            // before persistence existed - this is purely an optimization on top of it, not a
            // replacement.
            // Npgsql only accepts Offset=0 DateTimeOffset values for timestamptz - ToUniversalTime()
            // converts this IST midnight to the equivalent UTC instant rather than just relabeling it.
            var dayStartUtc = new DateTimeOffset(today.Year, today.Month, today.Day, 0, 0, 0, TimeSpan.FromHours(5.5)).ToUniversalTime();
            var candles = await _candleRepository.GetCandlesAsync(state.Underlying, dayStartUtc, dayStartUtc.AddDays(1), cancellationToken);
            if (candles.Count > 0)
            {
                state.SeedHistory(candles);
                _logger.LogInformation("Restored {Count} candle(s) for {Underlying} from storage.", candles.Count, state.Underlying);
                continue;
            }

            candles = await _historicalData.GetIntradayCandlesAsync(instrument.SecurityId, instrument.DhanSegment, today, 1, cancellationToken);

            if (candles.Count == 0)
            {
                // Before the market opens (or on a holiday) there is nothing for "today" yet - fall
                // back a few calendar days to the last day that actually has candles, so the chart
                // still opens with something on the screen instead of a blank panel.
                for (var back = 1; back <= 5 && candles.Count == 0; back++)
                {
                    var day = today.AddDays(-back);
                    if (day.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) continue;
                    candles = await _historicalData.GetIntradayCandlesAsync(instrument.SecurityId, instrument.DhanSegment, day, 1, cancellationToken);
                }
            }

            state.SeedHistory(candles);
            _logger.LogInformation("Backfilled {Count} candle(s) for {Underlying}.", candles.Count, state.Underlying);
        }
    }

    private void OnTick(SpotTick tick)
    {
        if (!_bySecurityId.TryGetValue(tick.SecurityId, out var state)) return;

        state.ApplyTick(tick);
        _ = BroadcastAsync(state);
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

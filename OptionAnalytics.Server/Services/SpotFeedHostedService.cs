using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Hubs;

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
    private readonly IHubContext<SpotHub> _hub;
    private readonly ILogger<SpotFeedHostedService> _logger;

    private readonly Dictionary<uint, SpotUnderlyingState> _bySecurityId = new();

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
        await _feedClient.RunAsync(tokenSegments, stoppingToken);
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

            var candles = await _historicalData.GetIntradayCandlesAsync(instrument.SecurityId, instrument.DhanSegment, today, 1, cancellationToken);

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

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        _feedClient.TickReceived -= OnTick;
        await _feedClient.DisposeAsync();
        await base.StopAsync(cancellationToken);
    }
}

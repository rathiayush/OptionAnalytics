using Microsoft.AspNetCore.SignalR;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Hubs;

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

    private readonly DhanOptionChainMaster _optionChainMaster;
    private readonly DhanMarketFeedClient _feedClient;
    private readonly SpotFeedHostedService _spotFeed;
    private readonly IHubContext<SpotHub> _hub;
    private readonly ILogger<CdvHostedService> _logger;

    private readonly Dictionary<uint, CdvUnderlyingState> _bySecurityId = new();
    private readonly Dictionary<string, HashSet<uint>> _subscribedTokens = new();

    public CdvHostedService(
        DhanOptionChainMaster optionChainMaster,
        DhanMarketFeedClient feedClient,
        SpotFeedHostedService spotFeed,
        IHubContext<SpotHub> hub,
        ILogger<CdvHostedService> logger)
    {
        _optionChainMaster = optionChainMaster;
        _feedClient = feedClient;
        _spotFeed = spotFeed;
        _hub = hub;
        _logger = logger;

        States = Underlyings.ToDictionary(u => u.Underlying, u => new CdvUnderlyingState(u.Underlying));
        foreach (var (underlying, _) in Underlyings) _subscribedTokens[underlying] = new HashSet<uint>();
    }

    /// <summary>Read by CdvController - keyed by underlying name.</summary>
    public IReadOnlyDictionary<string, CdvUnderlyingState> States { get; }

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

        var atm = (int)(Math.Round(spot / step) * step);
        var today = DateOnly.FromDateTime(DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(5.5)).DateTime);
        var expiry = _optionChainMaster.GetNearestExpiry(underlying, today);
        if (expiry is null)
        {
            _logger.LogWarning("CDV: {Underlying} - no listed option expiry found. Skipping.", underlying);
            return;
        }

        var state = States[underlying];
        state.AtmStrike = atm;
        state.Expiry = expiry;

        var strikes = Enumerable.Range(-StrikeRange, StrikeRange * 2 + 1).Select(i => atm + i * step).ToArray();

        var desiredTokens = new HashSet<uint>();
        var ceList = new List<int>();
        var peList = new List<int>();

        foreach (var strike in strikes)
        {
            foreach (var isCall in new[] { true, false })
            {
                var contract = _optionChainMaster.Find(underlying, expiry.Value, strike, isCall);
                if (contract is null) continue;

                state.EnsureTracked(contract.SecurityId, strike, isCall);
                _bySecurityId[contract.SecurityId] = state;
                desiredTokens.Add(contract.SecurityId);
                (isCall ? ceList : peList).Add(strike);
            }
        }

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

using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Hubs;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Keeps OI Replay's own "today, live" mode genuinely live: continuously tracks the ATM+-10 strike
/// band (same width as OiReplayService's own StrikeBandSteps) for every (underlying, expiryFlag)
/// combo the page supports - NIFTY+WEEK, NIFTY+MONTH, BANKNIFTY+MONTH (BANKNIFTY has no weekly
/// expiry - see ExpiredOptionBacktestService's own rejection of it) - over the SAME shared Dhan
/// market-feed WebSocket connection CdvHostedService/StrategyTriggerHostedService already use for
/// live trading, and pushes every tick straight to the browser over SignalR's existing SpotHub, so
/// the OI Replay page's ladder/chart keep updating in real time once today's initial REST snapshot
/// (see OiReplayService's own live-fallback doc comment) has loaded.
///
/// DELIBERATELY NEVER UNSUBSCRIBES a strike that drifts out of the recentered band - the shared
/// DhanMarketFeedClient's subscription registry has no reference counting across independent
/// consumers (see SubscribeAsync/UnsubscribeAsync's own doc comments), so unsubscribing a security
/// id CdvHostedService or StrategyTriggerHostedService still separately depend on would silently
/// kill live pricing for THEM too. A trading day's own ATM drift realistically adds well under a
/// hundred extra strikes across both underlyings over a full session - nowhere near Dhan's 5000-
/// per-connection cap - so simply letting the tracked set only ever grow, and filtering incoming
/// ticks down to "is this security id one of mine" at read time, is a far safer trade than touching
/// shared subscription state another live service also depends on.
///
/// NO IMPLIED VOLATILITY - Dhan's live tick feed carries price/volume/depth/open-interest (see
/// DhanTickPacketParser's own doc comment on the Full packet), but not IV - that only ever comes
/// back from a REST option-chain/rolling-option call (see DhanRollingOptionDataService's own doc
/// comment). A strike's IV shown on the OI Replay page while today is playing live is therefore
/// whatever OiReplayService's own initial REST fetch last saw, not something this service updates
/// continuously - deliberately not solved here by layering a periodic REST poll on top of the live
/// feed, since that would mean ~126 extra Dhan API calls every cycle against the SAME shared
/// account/rate budget the live trading pipeline depends on, for a figure the page's own Market
/// Read logic already only ever reads as a since-open TREND, not a per-tick value.
/// </summary>
public sealed class OiReplayLiveFeedService : BackgroundService
{
    private static readonly TimeSpan RecenterInterval = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan IncompleteRetryInterval = TimeSpan.FromSeconds(30);

    /// <summary>Same width as OiReplayService.StrikeBandSteps - the live band must match the
    /// historical band's own strikes, or a strike the ladder already shows from the initial REST
    /// fetch would never receive a live update once the day is being replayed live.</summary>
    private const int StrikeBandSteps = 10;

    private sealed record Combo(string Underlying, string ExpiryFlag);

    private static readonly Combo[] Combos =
    {
        new("NIFTY", "WEEK"),
        new("NIFTY", "MONTH"),
        new("BANKNIFTY", "MONTH"),
    };

    private sealed record LegInfo(string Underlying, string ExpiryFlag, decimal Strike, bool IsCall);

    private readonly SpotFeedHostedService _spotFeed;
    private readonly DhanOptionChainMaster _optionChainMaster;
    private readonly DhanMarketFeedClient _feedClient;
    private readonly IHubContext<SpotHub> _hub;
    private readonly ILogger<OiReplayLiveFeedService> _logger;

    /// <summary>Every leg this service has ever resolved and subscribed, across every recenter -
    /// see this class's own doc comment for why entries are never removed even after a strike
    /// drifts out of the currently-computed band.</summary>
    private readonly ConcurrentDictionary<uint, LegInfo> _legsBySecurityId = new();

    public OiReplayLiveFeedService(
        SpotFeedHostedService spotFeed, DhanOptionChainMaster optionChainMaster, DhanMarketFeedClient feedClient,
        IHubContext<SpotHub> hub, ILogger<OiReplayLiveFeedService> logger)
    {
        _spotFeed = spotFeed;
        _optionChainMaster = optionChainMaster;
        _feedClient = feedClient;
        _hub = hub;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _feedClient.TickReceived += OnTick;

        // Same "recenter, come back soon if anything's still missing" loop shape as CdvHostedService
        // - a fresh deploy routinely loses the race with SpotFeedHostedService's own scrip-master
        // download and spot backfill, so a short retry beats waiting out the full cadence.
        while (!stoppingToken.IsCancellationRequested)
        {
            var complete = true;
            foreach (var combo in Combos)
            {
                try
                {
                    if (!await RecenterComboAsync(combo, stoppingToken)) complete = false;
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.LogError(ex, "OI Replay live feed: {Underlying} {ExpiryFlag} re-center failed - its band is left as it was.", combo.Underlying, combo.ExpiryFlag);
                    complete = false;
                }
            }

            try { await Task.Delay(complete ? RecenterInterval : IncompleteRetryInterval, stoppingToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task<bool> RecenterComboAsync(Combo combo, CancellationToken cancellationToken)
    {
        if (!_spotFeed.States.TryGetValue(combo.Underlying, out var spotState) || spotState.LastPrice <= 0)
            return false;

        if (!ExpiredOptionBacktestService.StrikeStepByUnderlying.TryGetValue(combo.Underlying, out var step))
            return false;

        try
        {
            await _optionChainMaster.EnsureLoadedAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "OI Replay live feed: could not refresh the option chain for {Underlying} {ExpiryFlag} - keeping the previous band.", combo.Underlying, combo.ExpiryFlag);
        }

        var expiry = ResolveNearestExpiry(combo, IstClock.Today());
        if (expiry is null) return false;

        var atm = Math.Round(spotState.LastPrice / step) * step;
        var toSubscribe = new Dictionary<uint, string>();

        for (var steps = -StrikeBandSteps; steps <= StrikeBandSteps; steps++)
        {
            var strike = atm + steps * step;
            foreach (var isCall in new[] { true, false })
            {
                var contract = _optionChainMaster.Find(combo.Underlying, expiry.Value, strike, isCall);
                if (contract is null) continue;

                _legsBySecurityId[contract.SecurityId] = new LegInfo(combo.Underlying, combo.ExpiryFlag, strike, isCall);
                if (!_feedClient.IsSubscribed(contract.SecurityId))
                    toSubscribe[contract.SecurityId] = contract.DhanSegment;
            }
        }

        if (toSubscribe.Count > 0)
            await _feedClient.SubscribeAsync(toSubscribe, cancellationToken, full: true);

        return true;
    }

    /// <summary>The nearest real, currently-listed expiry matching combo's own WEEK/MONTH flag -
    /// derived directly from Dhan's own live scrip master (DhanOptionChainMaster.GetExpiries), not
    /// ExpiryCalendar's theoretical Tuesday math (which exists specifically for reasoning about an
    /// EXPIRED date the live scrip master no longer lists - irrelevant here, since every candidate
    /// considered is still currently listed and tradeable). A listed date counts as "monthly" if it
    /// is also the LAST listed expiry falling in its own calendar month - every other listed date is
    /// "weekly" - which matches NSE's real convention of exactly one monthly expiry per month with
    /// every other listed Tuesday in between being a weekly.</summary>
    private DateOnly? ResolveNearestExpiry(Combo combo, DateOnly today)
    {
        var listed = _optionChainMaster.GetExpiries(combo.Underlying).Where(e => e >= today).OrderBy(e => e).ToList();
        if (listed.Count == 0) return null;

        bool IsMonthly(DateOnly date) => listed.Where(e => e.Year == date.Year && e.Month == date.Month).Max() == date;

        if (combo.ExpiryFlag == "MONTH")
        {
            var monthly = listed.Where(IsMonthly).ToList();
            return monthly.Count > 0 ? monthly[0] : listed[0];
        }

        // Falls back to the nearest listed date at all if every remaining listed expiry happens to
        // double as its own month's monthly one (e.g. right at a weekly-less month boundary) -
        // still real, still tradeable, just not distinctly "weekly" this particular stretch.
        var weekly = listed.Where(e => !IsMonthly(e)).ToList();
        return weekly.Count > 0 ? weekly[0] : listed[0];
    }

    private void OnTick(SpotTick tick)
    {
        if (!_legsBySecurityId.TryGetValue(tick.SecurityId, out var leg)) return;
        if (tick.LastPrice <= 0 && tick.OpenInterest <= 0) return;

        var payload = new
        {
            underlying = leg.Underlying,
            expiryFlag = leg.ExpiryFlag,
            strike = leg.Strike,
            side = leg.IsCall ? "CE" : "PE",
            price = tick.LastPrice,
            openInterest = tick.OpenInterest,
            time = tick.ExchangeTimestamp,
        };

        _ = BroadcastAsync(payload);
    }

    /// <summary>Fire-and-forget from OnTick (a synchronous event handler) - same reasoning as
    /// SpotFeedHostedService's own BroadcastAsync: a slow or failed SignalR send must never block or
    /// crash the tick-handling path that every other live consumer of this same event also runs on.</summary>
    private async Task BroadcastAsync(object payload)
    {
        try
        {
            await _hub.Clients.All.SendAsync("oiReplayTick", payload);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "OI Replay live feed: failed to broadcast a tick.");
        }
    }
}

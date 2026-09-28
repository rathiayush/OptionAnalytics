using System.Collections.Concurrent;
using System.Linq;
using Microsoft.AspNetCore.SignalR;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Hubs;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Keeps OI Replay's own "today, live" mode genuinely live: continuously tracks the ATM+-10 strike
/// band (same width as OiReplayService's own StrikeBandSteps) for every (underlying, expiryFlag)
/// combo the page supports - NIFTY+WEEK, NIFTY+MONTH, BANKNIFTY+MONTH (BANKNIFTY has no weekly
/// expiry - see ExpiredOptionBacktestService's own rejection of it), SENSEX+WEEK, SENSEX+MONTH
/// (SENSEX has both, weekly on Thursday under BSE's own current single-weekly-expiry convention) -
/// over the SAME shared Dhan market-feed WebSocket connection CdvHostedService/
/// StrategyTriggerHostedService already use for live trading, and pushes every tick straight to the
/// browser over SignalR's existing SpotHub, so the OI Replay page's ladder/chart keep updating in
/// real time once today's initial REST snapshot (see OiReplayService's own live-fallback doc
/// comment) has loaded. SENSEX's own combos need no special handling here at all beyond being
/// listed - DhanOptionChainMaster/SpotFeedHostedService/DhanMarketFeedClient already resolve and
/// subscribe it correctly on BSE_FNO like every other live consumer in this app does.
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
///
/// ALSO keeps each underlying's own nearest FUTURES contract live (see RecenterFuturesAsync) -
/// broadcast as its own "futuresTick" event, separate from "oiReplayTick" - the page's Futures
/// section used to be a one-time REST snapshot from OiReplayService.GetFuturesAsync that never
/// updated again until the next full Load day/Go Live, unlike every other section on the page once
/// today is playing live.
/// </summary>
public sealed class OiReplayLiveFeedService : BackgroundService
{
    private static readonly TimeSpan RecenterInterval = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan IncompleteRetryInterval = TimeSpan.FromSeconds(30);

    /// <summary>How often the OPTIONAL REST-quote fallback (see RunRestQuoteLoopAsync) re-polls
    /// Dhan's own Option Chain snapshot endpoint per combo. Independent of RecenterInterval above -
    /// that loop is about keeping the SUBSCRIBED strike band/legs correct, this one is purely about
    /// OI/price freshness for whichever strikes are already tracked. 30 seconds comfortably clears
    /// DhanOptionChainQuotes' own "one call every 3.5s per underlying/expiry" self-throttle (one call
    /// per combo per cycle, 5 combos, nowhere near Dhan's account-wide 5/sec, 100k/day Data-API cap),
    /// so this always runs - there is no per-client toggle server-side; the frontend's own toggle
    /// only decides whether to PREFER this broadcast over the live tick feed's own OI, never whether
    /// the server bothers fetching it (broadcasting to Clients.All whether or not anyone is currently
    /// listening is the same "server doesn't track per-client interest" shape every other event on
    /// this hub already uses).</summary>
    private static readonly TimeSpan RestQuoteInterval = TimeSpan.FromSeconds(30);

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
        new("SENSEX", "WEEK"),
        new("SENSEX", "MONTH"),
    };

    /// <summary>Every underlying OiReplayService's own GetFuturesAsync supports - unlike the
    /// options Combos above, a future has no expiryFlag choice to multiply against (exactly one
    /// nearest contract per underlying), so this is just the plain underlying list.</summary>
    private static readonly string[] FuturesUnderlyings = { "NIFTY", "BANKNIFTY", "SENSEX" };

    private sealed record LegInfo(string Underlying, string ExpiryFlag, decimal Strike, bool IsCall);

    private readonly SpotFeedHostedService _spotFeed;
    private readonly DhanOptionChainMaster _optionChainMaster;
    private readonly DhanFuturesInstrumentMaster _futuresInstrumentMaster;
    private readonly DhanMarketFeedClient _feedClient;
    private readonly DhanOptionChainQuotes _chainQuotes;
    private readonly IHubContext<SpotHub> _hub;
    private readonly ILogger<OiReplayLiveFeedService> _logger;

    /// <summary>Every leg this service has ever resolved and subscribed, across every recenter -
    /// see this class's own doc comment for why entries are never removed even after a strike
    /// drifts out of the currently-computed band.</summary>
    private readonly ConcurrentDictionary<uint, LegInfo> _legsBySecurityId = new();

    /// <summary>Same "never remove" reasoning as _legsBySecurityId - a future's own nearest
    /// contract only changes at expiry (once every week/month), so in practice this dictionary
    /// almost never grows beyond one entry per underlying anyway.</summary>
    private readonly ConcurrentDictionary<uint, string> _futuresLegsBySecurityId = new();

    public OiReplayLiveFeedService(
        SpotFeedHostedService spotFeed, DhanOptionChainMaster optionChainMaster, DhanFuturesInstrumentMaster futuresInstrumentMaster,
        DhanMarketFeedClient feedClient, DhanOptionChainQuotes chainQuotes, IHubContext<SpotHub> hub, ILogger<OiReplayLiveFeedService> logger)
    {
        _spotFeed = spotFeed;
        _optionChainMaster = optionChainMaster;
        _futuresInstrumentMaster = futuresInstrumentMaster;
        _feedClient = feedClient;
        _chainQuotes = chainQuotes;
        _hub = hub;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _feedClient.TickReceived += OnTick;

        // Fire-and-forget, its own independent cadence (RestQuoteInterval, not RecenterInterval) -
        // see RestQuoteInterval's own doc comment for why this is safe to just always run rather
        // than gating it behind whether any client currently wants it.
        _ = RunRestQuoteLoopAsync(stoppingToken);

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

            foreach (var underlying in FuturesUnderlyings)
            {
                try
                {
                    if (!await RecenterFuturesAsync(underlying, stoppingToken)) complete = false;
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.LogError(ex, "OI Replay live feed: {Underlying} futures re-center failed - left as it was.", underlying);
                    complete = false;
                }
            }

            // Unconditionally re-affirm EVERY tracked leg/futures contract's subscription every
            // cycle, not just newly-entered ones - RecenterComboAsync/RecenterFuturesAsync only ever
            // subscribe a token NOT already in DhanMarketFeedClient's own tracked set (see their
            // IsSubscribed guards above), so a leg Dhan silently stopped ticking - its subscription
            // quietly dropped server-side, while every other leg keeps ticking completely normally -
            // would otherwise never be repaired: the shared connection-wide stall watchdog only
            // notices when NOTHING at all has arrived recently (see SpotFeedHostedService's own
            // identical fix and FeedStallDetector's doc comment). A per-leg staleness threshold isn't
            // safe here the way it is for spot - a deep OTM strike can legitimately go many minutes
            // between real trades, so "no tick recently" proves nothing on its own. Re-sending the
            // whole tracked set every cycle instead sidesteps that: cheap and harmless for a leg Dhan
            // already has right, silently repairs one it doesn't - no threshold to get wrong either
            // way.
            try
            {
                await _feedClient.ResendSubscriptionsForAsync(_legsBySecurityId.Keys.Concat(_futuresLegsBySecurityId.Keys), stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogWarning(ex, "OI Replay live feed: periodic re-subscribe of tracked legs failed.");
            }

            try { await Task.Delay(complete ? RecenterInterval : IncompleteRetryInterval, stoppingToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    /// <summary>Subscribes the underlying's own nearest futures contract if not already - mirrors
    /// RecenterComboAsync's own shape but far simpler (one contract, not a whole strike band).
    /// Re-resolving every cycle rather than caching the contract forever is deliberate: it is what
    /// picks up a fresh nearest contract automatically the moment the current one expires, with no
    /// separate "did it just expire" check needed.</summary>
    private async Task<bool> RecenterFuturesAsync(string underlying, CancellationToken cancellationToken)
    {
        try
        {
            await _futuresInstrumentMaster.EnsureLoadedAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "OI Replay live feed: could not refresh the futures instrument master for {Underlying} - keeping the previous contract.", underlying);
        }

        var contract = _futuresInstrumentMaster.GetNearestContract(underlying, IstClock.Today());
        if (contract is null) return false;

        _futuresLegsBySecurityId[contract.SecurityId] = underlying;
        if (!_feedClient.IsSubscribed(contract.SecurityId))
            await _feedClient.SubscribeAsync(new Dictionary<uint, string> { [contract.SecurityId] = contract.DhanSegment }, cancellationToken, full: true);

        return true;
    }

    /// <summary>The OPTIONAL REST fallback: every RestQuoteInterval, re-polls Dhan's Option Chain
    /// snapshot (the SAME endpoint DhanOptionChainQuotes already exists for - previously only ever
    /// used to decorate the dashboard's strike picker) for every combo, and broadcasts each one as
    /// its own "oiRestSnapshot" event. Exists because the live tick feed's own OI (Full packet,
    /// per-strike) and the historical /charts/rollingoption seed (day-open baseline) are two
    /// INDEPENDENT Dhan pipelines that can disagree (see OiLiveDashboardPage.jsx's own doc comment
    /// on SINCE_OPEN_SANITY_MULTIPLE) - this is a THIRD, independent source a client can opt into
    /// cross-checking against, or fully prefer, when it doesn't trust the tick feed's own number for
    /// a given strike. Never touches _legsBySecurityId/subscriptions - purely read-only decoration,
    /// same as the picker's own use of this endpoint.</summary>
    private async Task RunRestQuoteLoopAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            foreach (var combo in Combos)
            {
                try
                {
                    await BroadcastRestQuotesAsync(combo, stoppingToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.LogDebug(ex, "OI Replay live feed: REST-quote fallback failed for {Underlying} {ExpiryFlag} - will retry next cycle.", combo.Underlying, combo.ExpiryFlag);
                }
            }

            try { await Task.Delay(RestQuoteInterval, stoppingToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task BroadcastRestQuotesAsync(Combo combo, CancellationToken cancellationToken)
    {
        if (!_spotFeed.States.TryGetValue(combo.Underlying, out var spotState) || spotState.Instrument is null)
            return;

        var expiry = ResolveNearestExpiry(combo, IstClock.Today());
        if (expiry is null) return;

        var quotes = await _chainQuotes.GetQuotesAsync(
            spotState.Instrument.SecurityId, spotState.Instrument.DhanSegment, expiry.Value, cancellationToken, maxAge: RestQuoteInterval);
        if (quotes.Count == 0) return;

        var payload = new
        {
            underlying = combo.Underlying,
            expiryFlag = combo.ExpiryFlag,
            asOf = DateTimeOffset.UtcNow.ToOffset(IstClock.Offset),
            strikes = quotes.Select(q => new
            {
                strike = q.Strike,
                ceOi = q.CeOpenInterest,
                cePrice = q.CeLastPrice,
                peOi = q.PeOpenInterest,
                pePrice = q.PeLastPrice,
            }),
        };
        await BroadcastAsync($"c:{combo.Underlying}:{combo.ExpiryFlag}", "oiRestSnapshot", payload);
    }

    private async Task<bool> RecenterComboAsync(Combo combo, CancellationToken cancellationToken)
    {
        if (!_spotFeed.States.TryGetValue(combo.Underlying, out var spotState) || spotState.LastPrice <= 0)
            return false;

        if (!OiReplayService.StrikeStepByUnderlying.TryGetValue(combo.Underlying, out var step))
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
        if (_legsBySecurityId.TryGetValue(tick.SecurityId, out var leg) && (tick.LastPrice > 0 || tick.OpenInterest > 0))
        {
            var payload = new
            {
                underlying = leg.Underlying,
                expiryFlag = leg.ExpiryFlag,
                strike = leg.Strike,
                side = leg.IsCall ? "CE" : "PE",
                price = tick.LastPrice,
                openInterest = tick.OpenInterest,
                // ExchangeTimestamp is already the correct absolute instant (DhanTickPacketParser's
                // own IstOffset correction sees to that) - re-offsetting it to +05:30 here only
                // changes how it's ANNOTATED on the wire, not what instant it represents (every
                // consumer parses via new Date()/DateTimeOffset, which resolve to the identical
                // absolute instant regardless of which offset the string carries). Done purely so a
                // raw SignalR frame inspected directly (browser devtools, a saved WS capture) reads
                // as IST instead of requiring a +5:30 mental conversion.
                time = tick.ExchangeTimestamp.ToOffset(IstClock.Offset),
                // Everything else Dhan's own Full packet already carries for this leg (SpotTick
                // already parses all of it - see its own doc comment) - previously silently dropped
                // here rather than forwarded, per the user's own "add whatever is coming from Dhan's
                // options websocket" ask. Named dayOpen/dayHigh/dayLow (not open/high/low) deliberately:
                // these are the CONTRACT's cumulative day-so-far O/H/L as Dhan itself tracks them, not
                // a per-minute range - conflating the two would corrupt buildPremiumCandles' own
                // per-minute bucketing on the frontend, which reads a plain "open"/"high"/"low" to mean
                // exactly that bucket's own range. bestBidPrice/bestAskPrice are 0 until at least one
                // Full packet has arrived for this leg - see SpotTick's own doc comment.
                dayOpen = tick.Open,
                dayHigh = tick.High,
                dayLow = tick.Low,
                volume = tick.Volume,
                bestBidPrice = tick.BestBidPrice,
                bestAskPrice = tick.BestAskPrice,
            };
            _ = BroadcastAsync($"c:{leg.Underlying}:{leg.ExpiryFlag}", "oiReplayTick", payload);
        }

        if (_futuresLegsBySecurityId.TryGetValue(tick.SecurityId, out var futuresUnderlying) && tick.LastPrice > 0)
        {
            var payload = new
            {
                underlying = futuresUnderlying,
                price = tick.LastPrice,
                openInterest = tick.OpenInterest,
                volume = tick.Volume,
                // Same wire-annotation-only conversion as the options tick payload above.
                time = tick.ExchangeTimestamp.ToOffset(IstClock.Offset),
            };
            // Futures has no expiryFlag concept (see FuturesUnderlyings' own doc comment) - the
            // plain underlying group, same one spotUpdate/confluenceAlert/cdvUpdate use.
            _ = BroadcastAsync($"u:{futuresUnderlying}", "futuresTick", payload);
        }
    }

    /// <summary>Fire-and-forget from OnTick (a synchronous event handler) - same reasoning as
    /// SpotFeedHostedService's own BroadcastAsync: a slow or failed SignalR send must never block or
    /// crash the tick-handling path that every other live consumer of this same event also runs on.
    /// groupName is one of SpotHub's own two conventions (see its doc comment) - never Clients.All,
    /// so a client only ever receives a leg/underlying it actually joined.</summary>
    private async Task BroadcastAsync(string groupName, string eventName, object payload)
    {
        try
        {
            await _hub.Clients.Group(groupName).SendAsync(eventName, payload);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "OI Replay live feed: failed to broadcast a {Event} tick.", eventName);
        }
    }
}

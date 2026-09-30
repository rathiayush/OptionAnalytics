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

    /// <summary>How many of each underlying's own nearest currently-listed expiries get their own
    /// positional "N1".."N6" combo (see ResolveNearestExpiryCore's own doc comment on this flag
    /// shape) - the user's own explicit "list active expiry and select from there" request: WEEK/
    /// MONTH above only ever expose the SINGLE nearest weekly/monthly, with no way to explicitly
    /// track, say, the 3rd listed weekly out. N1 always duplicates whichever of WEEK/MONTH is that
    /// underlying's own index-0 listed date (WEEK for NIFTY/SENSEX, MONTH for BANKNIFTY, which lists
    /// no weeklies at all) - genuinely redundant tracking of the same real contract under two flags,
    /// accepted deliberately rather than special-cased away, so this stays a simple "just add more
    /// combos" extension instead of touching the WEEK/MONTH combos (and therefore OiReplayPage.jsx's
    /// own still-live "today" mode, which only ever requests WEEK/MONTH) at all.</summary>
    internal const int PositionalExpiriesPerUnderlying = 6;

    /// <summary>The underlyings a positional N-flag applies to - every underlying this service
    /// already tracks options for (excludes futures, which has no expiry choice at all - see
    /// FuturesUnderlyings' own doc comment).</summary>
    private static readonly string[] PositionalUnderlyings = { "NIFTY", "BANKNIFTY", "SENSEX" };

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
    /// drifts out of the currently-computed band. Keyed by flag (WEEK/MONTH/N1../N6) UNDER the
    /// security id, not a single LegInfo per id - the same real contract routinely belongs to more
    /// than one combo at once (N1 always duplicates WEEK or MONTH's own index-0 date, see
    /// PositionalExpiriesPerUnderlying's own doc comment), and each needs its own tick broadcast to
    /// its own group so a client that joined "c:NIFTY:N1" still gets ticks even though the identical
    /// contract is ALSO tracked under "c:NIFTY:WEEK" for OiReplayPage.jsx's sake.</summary>
    private readonly ConcurrentDictionary<uint, ConcurrentDictionary<string, LegInfo>> _legsBySecurityId = new();

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
            var allCombos = Combos.Concat(await BuildPositionalCombosAsync(stoppingToken)).ToList();
            foreach (var combo in allCombos)
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
    /// INDEPENDENT Dhan pipelines that can disagree - this is a THIRD, independent source a client
    /// can opt into cross-checking against, or fully prefer, when it doesn't trust the tick feed's
    /// own number for a given strike. Never touches _legsBySecurityId/subscriptions - purely
    /// read-only decoration, same as the picker's own use of this endpoint.</summary>
    private async Task RunRestQuoteLoopAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var allCombos = Combos.Concat(await BuildPositionalCombosAsync(stoppingToken)).ToList();
            foreach (var combo in allCombos)
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

    /// <summary>Freshly recomputed every call (both loops above call this every cycle, never cache
    /// it) - a listed date can drop off (expired) or a new one can appear exactly like RecenterFuturesAsync's
    /// own "re-resolve every cycle rather than cache" reasoning. EnsureLoadedAsync is cheap once the
    /// scrip master has actually loaded (an in-memory dictionary read), so paying for it here even
    /// when RecenterComboAsync's own callers already called it moments ago for the SAME cycle is a
    /// non-issue.</summary>
    private async Task<List<Combo>> BuildPositionalCombosAsync(CancellationToken cancellationToken)
    {
        try
        {
            await _optionChainMaster.EnsureLoadedAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "OI Replay live feed: could not refresh the option chain for positional expiry combos - using whatever was last loaded.");
        }

        var today = IstClock.Today();
        var combos = new List<Combo>();
        foreach (var underlying in PositionalUnderlyings)
        {
            var listed = _optionChainMaster.GetExpiries(underlying).Where(e => e >= today).OrderBy(e => e).Take(PositionalExpiriesPerUnderlying).ToList();
            for (var i = 0; i < listed.Count; i++)
                combos.Add(new Combo(underlying, $"N{i + 1}"));
        }
        return combos;
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

                var legsForSecurity = _legsBySecurityId.GetOrAdd(contract.SecurityId, _ => new ConcurrentDictionary<string, LegInfo>());
                legsForSecurity[combo.ExpiryFlag] = new LegInfo(combo.Underlying, combo.ExpiryFlag, strike, isCall);
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
    /// "weekly" - which matches NSE's real convention of exactly one monthly expiry per month.
    ///
    /// WEEK is simply the single nearest listed date, full stop - it is NEVER filtered to exclude a
    /// date IsMonthly classifies as "the month's own monthly" (a previous version here did exactly
    /// that, on the reasoning "weekly and monthly are different dates"). That reasoning breaks down
    /// during the final week before a month's own monthly expiry: NSE lists no SEPARATE, closer
    /// weekly for that week at all - the monthly contract IS that week's nearest expiry, the same
    /// real contract both a weekly and a monthly trader are looking at. The old code instead skipped
    /// straight past it to NEXT MONTH's first weekly - confirmed for real: a live report of a
    /// strike's own tracked premium abruptly jumping mid-session to a wildly different value ("this
    /// premium is from next expiry") traced back to exactly this, since the live tick feed (this
    /// method) and the initial REST seed (OiReplayService, which hands expiryFlag/expiryCode
    /// straight to Dhan's own /charts/rollingoption rather than re-deriving a date here) disagreed on
    /// which contract "this week" even meant, in exactly this final-week window.</summary>
    private DateOnly? ResolveNearestExpiry(Combo combo, DateOnly today)
    {
        var listed = _optionChainMaster.GetExpiries(combo.Underlying).Where(e => e >= today).OrderBy(e => e).ToList();
        return ResolveNearestExpiryCore(listed, combo.ExpiryFlag);
    }

    /// <summary>The pure decision itself, pulled out of ResolveNearestExpiry so a test can exercise
    /// the exact final-week scenario its own doc comment describes without standing up this whole
    /// service and its Dhan-backed dependencies - same reasoning as
    /// DhanRollingOptionDataService.ClipToRange's own internal static split.
    ///
    /// ALSO handles the positional "N1".."N6" flags (see PositionalExpiriesPerUnderlying's own doc
    /// comment) - "N{k}" (1-indexed) is simply listedFromToday[k-1], the SAME unfiltered population
    /// WEEK itself already indexes into at position 0 (confirmed correct there) - not a separate rule,
    /// just WEEK's own existing behavior generalized to an explicit position instead of always 0. Null
    /// (not listedFromToday[0]) when the list is shorter than k - a client that asked for "the 5th
    /// listed expiry" when only 3 are currently listed should see "not currently available", never
    /// silently fall back to some other contract it did not ask for.</summary>
    internal static DateOnly? ResolveNearestExpiryCore(IReadOnlyList<DateOnly> listedFromToday, string expiryFlag)
    {
        if (listedFromToday.Count == 0) return null;

        if (expiryFlag.Length >= 2 && expiryFlag[0] == 'N' && int.TryParse(expiryFlag.AsSpan(1), out var position) && position >= 1)
            return position <= listedFromToday.Count ? listedFromToday[position - 1] : null;

        if (expiryFlag != "MONTH") return listedFromToday[0];

        bool IsMonthly(DateOnly date) => listedFromToday.Where(e => e.Year == date.Year && e.Month == date.Month).Max() == date;
        var monthly = listedFromToday.Where(IsMonthly).ToList();
        return monthly.Count > 0 ? monthly[0] : listedFromToday[0];
    }

    private void OnTick(SpotTick tick)
    {
        if (!_legsBySecurityId.TryGetValue(tick.SecurityId, out var legsByFlag) || !(tick.LastPrice > 0 || tick.OpenInterest > 0))
            return;

        // `time` is when this reading was OBSERVED, not Dhan's own ExchangeTimestamp - that field is
        // the contract's LAST TRADE time, which for a quiet strike can be minutes old while its OI,
        // depth and bid/ask keep updating (and every periodic re-subscribe replays each leg's snapshot
        // stamped with that same old trade time). Stamping with it filed fresh OI into long-past
        // buckets and left the current one empty - the scattered live heatmap. The trade time is still
        // forwarded as lastTradeTime for anything that genuinely wants it.
        var observedAt = DateTimeOffset.UtcNow.ToOffset(IstClock.Offset);
        var lastTradeTime = tick.ExchangeTimestamp.ToOffset(IstClock.Offset);

        foreach (var leg in legsByFlag.Values)
        {
            var payload = new
            {
                underlying = leg.Underlying,
                expiryFlag = leg.ExpiryFlag,
                strike = leg.Strike,
                side = leg.IsCall ? "CE" : "PE",
                price = tick.LastPrice,
                openInterest = tick.OpenInterest,
                // +05:30 offset is annotation only (same absolute instant) - it just makes a raw
                // SignalR frame read as IST in devtools.
                time = observedAt,
                lastTradeTime,
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
                // Observed-at, same reasoning as the options payload above.
                time = observedAt,
                lastTradeTime,
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

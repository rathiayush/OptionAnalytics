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
    /// per combo per cycle). Only for a combo a page is watching, in market hours (see ShouldPollChain) -
    /// the page reads just the IV from it (the live tick feed has none); price and OI come from the feed.</summary>
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

    internal sealed record LegInfo(string Underlying, string ExpiryFlag, decimal Strike, bool IsCall, DateOnly Expiry);

    internal sealed record FuturesLeg(string Underlying, DateOnly Expiry);

    private readonly LiveOptionLegStore? _legStore;
    private readonly SpotFeedHostedService _spotFeed;
    private readonly DhanOptionChainMaster _optionChainMaster;
    private readonly DhanFuturesInstrumentMaster _futuresInstrumentMaster;
    private readonly DhanMarketFeedClient _feedClient;
    private IDisposable? _tickSubscription;
    private readonly DhanOptionChainQuotes _chainQuotes;
    private readonly IHubContext<SpotHub> _hub;
    private readonly LiveBroadcastBatcher _batcher;
    private readonly ILogger<OiReplayLiveFeedService> _logger;
    private readonly OiDivergenceMonitor? _divergence;

    /// <summary>Every leg this service has resolved and subscribed, across every recenter - see this
    /// class's own doc comment for why entries are never removed when a strike merely drifts out of
    /// the currently-computed band. They ARE removed once their expiry has passed, or once their
    /// flag resolves to a different expiry (N2 becoming N1 after a rollover) - see PruneLegs. Keyed by flag (WEEK/MONTH/N1../N6) UNDER the
    /// security id, not a single LegInfo per id - the same real contract routinely belongs to more
    /// than one combo at once (N1 always duplicates WEEK or MONTH's own index-0 date, see
    /// PositionalExpiriesPerUnderlying's own doc comment), and each needs its own tick broadcast to
    /// its own group so a client that joined "c:NIFTY:N1" still gets ticks even though the identical
    /// contract is ALSO tracked under "c:NIFTY:WEEK" for OiReplayPage.jsx's sake.</summary>
    private readonly ConcurrentDictionary<uint, ConcurrentDictionary<string, LegInfo>> _legsBySecurityId = new();

    /// <summary>Each underlying's nearest futures contract. The previous contract is dropped (and,
    /// being expired, unsubscribed) when RecenterFuturesAsync resolves the next one.</summary>
    private readonly ConcurrentDictionary<uint, FuturesLeg> _futuresLegsBySecurityId = new();
    /// <summary>For the tests: the futures contracts being tracked, by security id.</summary>
    internal ConcurrentDictionary<uint, FuturesLeg> FuturesLegs => _futuresLegsBySecurityId;

    public OiReplayLiveFeedService(
        SpotFeedHostedService spotFeed, DhanOptionChainMaster optionChainMaster, DhanFuturesInstrumentMaster futuresInstrumentMaster,
        DhanMarketFeedClient feedClient, DhanOptionChainQuotes chainQuotes, IHubContext<SpotHub> hub, LiveBroadcastBatcher batcher,
        ILogger<OiReplayLiveFeedService> logger, OiDivergenceMonitor? divergence = null, LiveOptionLegStore? legStore = null)
    {
        _divergence = divergence;
        _legStore = legStore;
        _batcher = batcher;
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
        // Background work: its Dhan calls are not sent outside market hours (MarketHours).
        using var background = MarketHours.BackgroundScope();
        _tickSubscription ??= _feedClient.AddTickConsumer("OI Replay", OnTick);

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
            var resolvedExpiries = new Dictionary<(string Underlying, string ExpiryFlag), DateOnly>();
            var allCombos = Combos.Concat(await BuildPositionalCombosAsync(stoppingToken)).ToList();
            foreach (var combo in allCombos)
            {
                try
                {
                    if (!await RecenterComboAsync(combo, resolvedExpiries, stoppingToken)) complete = false;
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

            // Without this a server that stays up across expiries would keep every contract it ever
            // tracked: re-sent to Dhan every cycle below, creeping toward the per-connection cap, and
            // - worse - a contract that moved from N2 to N1 would keep broadcasting under N2 too.
            try
            {
                var expired = PruneLegs(_legsBySecurityId, resolvedExpiries, IstClock.Today());
                if (expired.Count > 0)
                {
                    _logger.LogInformation("OI Replay live feed: dropped {Count} expired option legs.", expired.Count);
                    await _feedClient.UnsubscribeAsync(expired, stoppingToken);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogWarning(ex, "OI Replay live feed: pruning expired legs failed.");
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

        var today = IstClock.Today();
        var rolledOff = _futuresLegsBySecurityId
            .Where(kv => kv.Key != contract.SecurityId && kv.Value.Underlying == underlying)
            .ToList();
        foreach (var (id, _) in rolledOff) _futuresLegsBySecurityId.TryRemove(id, out _);
        // Only an expired contract is unsubscribed - the shared feed has no reference counting (see
        // this class's own doc comment), and nothing can still need a contract that no longer trades.
        var expired = rolledOff.Where(kv => kv.Value.Expiry < today).Select(kv => kv.Key).ToList();
        if (expired.Count > 0) await _feedClient.UnsubscribeAsync(expired, cancellationToken);

        _futuresLegsBySecurityId[contract.SecurityId] = new FuturesLeg(underlying, contract.Expiry);
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

    /// <summary>Whether the IV snapshot (Dhan's Option Chain API) is worth asking for one combo now: only in market hours
    /// (IST weekdays 09:15 - 15:30 - outside them IV does not move and Dhan answers nothing new) and only while a page is
    /// watching that combo (its "c:" group has a member) - the snapshot only feeds an open page's IV. It used to be asked
    /// for every index and expiry (~18 chains) all day and night, one call every 3.5 s without end.</summary>
    internal static bool ShouldPollChain(DateTimeOffset now, bool watched)
    {
        if (!watched) return false;
        var ist = now.ToOffset(IstClock.Offset);
        if (ist.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) return false;
        return ist.TimeOfDay >= new TimeSpan(9, 15, 0) && ist.TimeOfDay <= new TimeSpan(15, 30, 0);
    }

    private async Task BroadcastRestQuotesAsync(Combo combo, CancellationToken cancellationToken)
    {
        if (!ShouldPollChain(DateTimeOffset.UtcNow, _batcher.HasMembers($"c:{combo.Underlying}:{combo.ExpiryFlag}")))
            return;
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
                ceIv = q.CeImpliedVolatility,
                peOi = q.PeOpenInterest,
                pePrice = q.PeLastPrice,
                peIv = q.PeImpliedVolatility,
            }),
        };
        await BroadcastAsync($"c:{combo.Underlying}:{combo.ExpiryFlag}", "oiRestSnapshot", payload);
    }

    /// <summary>Drops every leg whose contract has expired, or whose flag now resolves to a different
    /// expiry than the one it was tracked for (resolvedExpiries holds this cycle's resolution; a combo
    /// that failed to resolve is only pruned by date). Returns the security ids no flag tracks any
    /// more whose contracts have expired - safe to unsubscribe, since nothing can still need them.
    /// A contract merely dropped from a flag, still trading, stays subscribed (see this class's own
    /// doc comment on the shared feed's lack of reference counting).</summary>
    internal static IReadOnlyList<uint> PruneLegs(
        ConcurrentDictionary<uint, ConcurrentDictionary<string, LegInfo>> legsBySecurityId,
        IReadOnlyDictionary<(string Underlying, string ExpiryFlag), DateOnly> resolvedExpiries,
        DateOnly today)
    {
        var expired = new List<uint>();
        foreach (var (securityId, legsByFlag) in legsBySecurityId)
        {
            var anyExpired = false;
            foreach (var (flag, leg) in legsByFlag)
            {
                var isExpired = leg.Expiry < today;
                var moved = resolvedExpiries.TryGetValue((leg.Underlying, flag), out var current) && current != leg.Expiry;
                if (!isExpired && !moved) continue;
                legsByFlag.TryRemove(flag, out _);
                anyExpired |= isExpired;
            }
            if (legsByFlag.IsEmpty && legsBySecurityId.TryRemove(KeyValuePair.Create(securityId, legsByFlag)) && anyExpired)
                expired.Add(securityId);
        }
        return expired;
    }

    private async Task<bool> RecenterComboAsync(
        Combo combo, Dictionary<(string Underlying, string ExpiryFlag), DateOnly> resolvedExpiries, CancellationToken cancellationToken)
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
        resolvedExpiries[(combo.Underlying, combo.ExpiryFlag)] = expiry.Value;

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
                legsForSecurity[combo.ExpiryFlag] = new LegInfo(combo.Underlying, combo.ExpiryFlag, strike, isCall, expiry.Value);
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

    internal void OnTick(SpotTick tick)
    {
        // The shared feed carries every subscriber's instruments - only this service's legs and futures go further.
        _futuresLegsBySecurityId.TryGetValue(tick.SecurityId, out var futuresLeg);
        if (futuresLeg is null && !_legsBySecurityId.ContainsKey(tick.SecurityId)) return;

        // `time` is when this reading was OBSERVED, not Dhan's own ExchangeTimestamp - that field is
        // the contract's LAST TRADE time, which for a quiet strike can be minutes old while its OI,
        // depth and bid/ask keep updating (and every periodic re-subscribe replays each leg's snapshot
        // stamped with that same old trade time). Stamping with it filed fresh OI into long-past
        // buckets and left the current one empty - the scattered live heatmap. The trade time is still
        // forwarded as lastTradeTime for anything that genuinely wants it.
        var observedAt = DateTimeOffset.UtcNow.ToOffset(IstClock.Offset);
        var lastTradeTime = tick.ExchangeTimestamp.ToOffset(IstClock.Offset);

        var minuteKey = observedAt.ToUnixTimeSeconds() / 60;

        // The near futures first: they are not option legs, and the legs' early return below used to drop every
        // futures tick - the page's futures chart never ticked and today's futures bars (LiveOptionLegStore) stayed
        // empty, so a reload showed them frozen at the morning's backfill.
        if (futuresLeg is not null && tick.LastPrice > 0)
        {
            var futuresUnderlying = futuresLeg.Underlying;
            // Futures has no expiryFlag concept (see FuturesUnderlyings' own doc comment) - the plain
            // underlying group spotUpdate also uses. Same per-minute conflation as the option legs.
            _batcher.Accumulate($"u:{futuresUnderlying}", "futuresTicks", minuteKey.ToString(), new LiveFuturesTick(
                futuresUnderlying,
                Open: tick.LastPrice, High: tick.LastPrice, Low: tick.LastPrice, Price: tick.LastPrice,
                OpenInterest: tick.OpenInterest, Time: observedAt, DayVolume: tick.Volume));
            _legStore?.RecordFutures(futuresUnderlying, tick.LastPrice, tick.OpenInterest, tick.Volume, observedAt);
        }

        if (!_legsBySecurityId.TryGetValue(tick.SecurityId, out var legsByFlag) || !(tick.LastPrice > 0 || tick.OpenInterest > 0))
            return;

        foreach (var leg in legsByFlag.Values)
        {
            var side = leg.IsCall ? "CE" : "PE";
            var group = $"c:{leg.Underlying}:{leg.ExpiryFlag}";

            // The nearest listed expiry's OI feeds the price-vs-OI divergence alert (OiDivergenceMonitor).
            if (leg.ExpiryFlag == "N1") _divergence?.RecordOi(leg.Underlying, side, leg.Strike, observedAt, tick.OpenInterest);

            // Conflated for the charts (see LiveBroadcastBatcher): the newest reading per leg per
            // minute, folded with any earlier ticks the browser hasn't received yet (keeps their
            // open and widens high/low). Keyed by minute so a candle never absorbs the previous
            // minute's range.
            var optionTick = new LiveOptionTick(
                leg.Underlying, leg.ExpiryFlag, leg.Strike, side,
                Open: tick.LastPrice, Price: tick.LastPrice, High: tick.LastPrice, Low: tick.LastPrice,
                OpenInterest: tick.OpenInterest, Time: observedAt, DayVolume: tick.Volume);
            _batcher.Accumulate(group, "oiReplayTicks", $"{leg.Strike}:{side}:{minuteKey}", optionTick);
            // Each leg's newest reading, in memory - a page reads an index's current option prices from it, no Dhan call.
            // Bars for the WEEK / MONTH chains (what today's run serves - OiReplayService); the newest reading for every leg.
            if (tick.LastPrice > 0) _legStore?.Record(optionTick, tick.Volume, keepBars: leg.ExpiryFlag is "WEEK" or "MONTH");

            // The raw per-tick tape, on its own "t:" group, for the Live Strike Data page - its whole
            // purpose is to show every individual tick, so only a page that joined it pays for that
            // volume (skipped outright when nobody has). dayOpen/dayHigh/dayLow are the CONTRACT's
            // day-so-far O/H/L as Dhan tracks them, not a per-minute range.
            var tapeGroup = $"t:{leg.Underlying}:{leg.ExpiryFlag}";
            if (!_batcher.HasMembers(tapeGroup)) continue;
            _ = BroadcastAsync(tapeGroup, "oiReplayTick", new
            {
                underlying = leg.Underlying,
                expiryFlag = leg.ExpiryFlag,
                strike = leg.Strike,
                side,
                price = tick.LastPrice,
                openInterest = tick.OpenInterest,
                time = observedAt,
                lastTradeTime,
                dayOpen = tick.Open,
                dayHigh = tick.High,
                dayLow = tick.Low,
                volume = tick.Volume,
                bestBidPrice = tick.BestBidPrice,
                bestAskPrice = tick.BestAskPrice,
            });
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

/// <summary>One option leg's conflated live state - the newest reading, plus the open/high/low of
/// every tick folded into it since the browser last received this leg (see LiveBroadcastBatcher).
/// Only what the charts use; the full Dhan packet stays on the raw "t:" tape. DayVolume: Dhan's cumulative volume for
/// the day (0 unknown) - the page turns its rise within a minute into that minute's volume (option CDV / OBV).</summary>
public sealed record LiveOptionTick(
    string Underlying, string ExpiryFlag, decimal Strike, string Side,
    decimal Open, decimal Price, decimal High, decimal Low, long OpenInterest, DateTimeOffset Time, long DayVolume = 0) : ILiveMergeable
{
    public ILiveMergeable MergeAfter(ILiveMergeable older) => older is LiveOptionTick o
        ? this with { Open = o.Open, High = Math.Max(o.High, High), Low = Math.Min(o.Low, Low) }
        : this;
}

/// <summary>The underlying's nearest futures contract, conflated the same way. DayVolume: Dhan's
/// cumulative volume for the day - the page turns its rise within a minute into that minute's volume
/// (for the futures volume profile).</summary>
public sealed record LiveFuturesTick(
    string Underlying, decimal Open, decimal High, decimal Low, decimal Price, long OpenInterest, DateTimeOffset Time, long DayVolume = 0) : ILiveMergeable
{
    public ILiveMergeable MergeAfter(ILiveMergeable older) => older is LiveFuturesTick o
        ? this with { Open = o.Open, High = Math.Max(o.High, High), Low = Math.Min(o.Low, Low) }
        : this;
}

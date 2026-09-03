using System.Collections.Concurrent;
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
    /// <summary>Each underlying, its strike step, and HOW MANY of the nearest listed expiries this
    /// app tracks live at once.
    ///
    /// NIFTY lists weeklies, so 3 covers the current week plus the next two - which, near a monthly
    /// roll, is what "current + next two" has to mean to include the month itself. BANKNIFTY lists
    /// monthlies only, so 2 is the current month plus the next.
    ///
    /// Every tracked expiry costs its own ATM+-8 window: 17 strikes x CE/PE = up to 34 live
    /// contracts and 34 backfill calls each. That is the whole price of this - 102 contracts for
    /// NIFTY and 68 for BANKNIFTY rather than 34 apiece - and the reason this is a small fixed
    /// number per underlying rather than "every listed expiry".</summary>
    private static readonly (string Underlying, int Step, int TrackedExpiries)[] Underlyings =
    {
        ("NIFTY", 50, 3),
        ("BANKNIFTY", 100, 2),
    };

    /// <summary>8 ITM + 8 OTM strikes around ATM (so 17 strikes total, ATM included), for both CE
    /// and PE.</summary>
    private const int StrikeRange = 8;

    private static readonly TimeSpan AtmRecenterInterval = TimeSpan.FromMinutes(30);

    /// <summary>How soon to retry when a recenter left something without data - no ATM resolved, or
    /// a tracked expiry with nothing subscribed. Short, because that state means a page or a trigger
    /// is looking at an empty chain RIGHT NOW; the full 30-minute cadence resumes as soon as
    /// everything is live again.</summary>
    private static readonly TimeSpan IncompleteRetryInterval = TimeSpan.FromSeconds(30);

    /// <summary>Matches SpotFeedHostedService's own backfill window exactly - the option premium
    /// charts and CDV's reconstructed history need to cover the same trading days the spot chart
    /// does, or the charts would visibly disagree on how far back "history" goes. Both read the
    /// same HistoryWindow constants so they cannot drift apart.</summary>
    private const int HistoryTradingDays = HistoryWindow.TradingDays;
    private const int HistoryLookbackCalendarDays = HistoryWindow.LookbackCalendarDays;

    /// <summary>Dhan gives no documented rate limit for this endpoint, but a recenter can mean
    /// backfilling up to ~34 contracts (17 strikes x CE/PE) back to back on first startup - a small
    /// gap between calls is cheap insurance against tripping one anyway.</summary>
    private static readonly TimeSpan BackfillCallDelay = TimeSpan.FromMilliseconds(200);

    /// <summary>How long an on-demand (untracked) strike's fetched candles are reused before going
    /// back to Dhan - long enough that flipping between strikes in the picker doesn't re-fetch, short
    /// enough that a chart left open during the session still catches up on a refresh.</summary>
    private static readonly TimeSpan OnDemandCandleLifetime = TimeSpan.FromMinutes(2);

    /// <summary>The same, once the session has closed for the day: today's candles are then FINAL,
    /// so re-fetching them can only ever return the identical series. A Backtrack run can reference
    /// dozens of untracked strikes (see BacktestService.FillMissingStrikesAsync) and every one is a
    /// Dhan call, so an evening of re-running the same window would otherwise pay for the same data
    /// over and over. Safe to hold this long precisely BECAUSE nothing can change until the next
    /// session, and the day-keyed sweep below drops the whole lot the moment the IST date rolls
    /// over - a stale entry can never survive into a day whose bars are still forming.</summary>
    private static readonly TimeSpan OnDemandCandleLifetimeAfterClose = TimeSpan.FromHours(2);

    /// <summary>IST time the session ends. After this, the day's candles cannot change.</summary>
    private static readonly TimeOnly SessionClose = new(15, 30);

    private readonly DhanOptionChainMaster _optionChainMaster;
    private readonly DhanOptionChainQuotes _chainQuotes;
    private readonly DhanMarketFeedClient _feedClient;
    private readonly SpotFeedHostedService _spotFeed;
    private readonly DhanHistoricalDataService _historicalData;
    private readonly IHubContext<SpotHub> _hub;
    private readonly ILogger<CdvHostedService> _logger;

    /// <summary>Which state a live tick belongs to. Already state-valued rather than
    /// underlying-valued, which is what lets one underlying now own several states at once: a
    /// contract's securityId is unique per (strike, side, EXPIRY), so this routes NIFTY's 25-Feb
    /// 24000CE tick to the 25-Feb state and its 26-Mar sibling to the 26-Mar one with no ambiguity.</summary>
    /// Concurrent because the recenter loop adds and removes entries while the feed thread reads
    /// them on every tick - and with several expiries per underlying this churns far more than it
    /// used to, since each expiry's window moves on its own.
    private readonly ConcurrentDictionary<uint, CdvUnderlyingState> _bySecurityId = new();

    /// <summary>The live subscription set per (underlying, expiry) - each tracked expiry has its own
    /// ATM+-8 window that moves independently, so the subscribe/unsubscribe diff has to be computed
    /// per expiry or one expiry's recenter would unsubscribe another's contracts.</summary>
    /// Concurrent for the same reason: keys now come and go as expiries roll on and off the tracked
    /// set, and GET /strikes reads this from a request thread while a recenter may be rewriting it.
    private readonly ConcurrentDictionary<(string Underlying, DateOnly Expiry), HashSet<uint>> _subscribedTokens = new();

    /// <summary>Every tracked expiry's own CDV/OBV/strike state. THE change this whole design turns
    /// on: an expiry is no longer something the app switches BETWEEN (wiping everything each time),
    /// it is something the app holds several of at once. Switching what a page looks at is then a
    /// pointer move rather than a full unsubscribe/wipe/re-backfill, and a trigger armed on one
    /// expiry is untouched by what any page is looking at.</summary>
    private readonly ConcurrentDictionary<(string Underlying, DateOnly Expiry), CdvUnderlyingState> _byExpiry = new();

    /// <summary>Which tracked expiry the always-on consumers read - the SignalR broadcast and the
    /// live alert services, which have no page to ask. Re-pointed by SelectExpiryAsync; exposed as
    /// States so every existing caller keeps working unchanged.</summary>
    private readonly ConcurrentDictionary<string, CdvUnderlyingState> _selected = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>The expiries actually being tracked right now, per underlying, in date order - what
    /// the pages' expiry pickers offer, since those are the ones with real live data behind them.
    /// Refreshed by each recenter.</summary>
    private readonly ConcurrentDictionary<string, IReadOnlyList<DateOnly>> _trackedExpiries = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>A manually-picked expiry per underlying, set via SelectExpiryAsync (the dashboard/
    /// Backtrack expiry selector) - overrides RecenterAsync's default "nearest unexpired listed
    /// expiry" pick. Absent (or holding a now-past date, cleared lazily by RecenterAsync) means
    /// "auto: track the nearest expiry", the behavior this app always had before the selector
    /// existed. Concurrent because SelectExpiryAsync runs on an HTTP request thread while
    /// RecenterAsync reads it from the background recenter loop - a plain Dictionary is not safe to
    /// read on one thread while another resizes it.</summary>
    private readonly ConcurrentDictionary<string, DateOnly> _expiryOverride = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>Serializes every full recenter/reset sequence - the scheduled 30-minute recenter,
    /// the startup catch-up loop, and an on-demand SelectExpiryAsync call - so two of them can never
    /// interleave their subscribe/unsubscribe/backfill bookkeeping for the same underlying. Without
    /// this, a manual expiry switch racing the scheduled timer could unsubscribe a token the other
    /// had just resubscribed, or backfill a strike the other was mid-reset on.</summary>
    private readonly SemaphoreSlim _recenterLock = new(1, 1);

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
    private readonly HashSet<(string Underlying, DateOnly Expiry)> _cdvHistorySeeded = new();

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

        // A placeholder per underlying so States is never empty before the first recenter has
        // resolved any expiry - callers see an empty state with no ATM, exactly what they saw at
        // this point before, rather than a missing key that reads as "unknown underlying".
        foreach (var (underlying, _, _) in Underlyings) _selected[underlying] = new CdvUnderlyingState(underlying);
    }

    /// <summary>The state each underlying's always-on consumers read - the currently SELECTED
    /// expiry (see _selected). Anything that wants a specific expiry uses StateFor instead.</summary>
    public IReadOnlyDictionary<string, CdvUnderlyingState> States => _selected;

    /// <summary>The state for one specific tracked expiry, or the selected one when
    /// <paramref name="expiry"/> is null. Null when the underlying is unknown, or when that expiry
    /// is not currently tracked - callers must treat that as "no data for this expiry" rather than
    /// silently falling back to a different expiry's numbers, which would be wrong in exactly the
    /// way this whole change exists to prevent.</summary>
    public CdvUnderlyingState? StateFor(string underlying, DateOnly? expiry)
    {
        underlying = underlying.ToUpperInvariant();
        if (expiry is not { } value) return _selected.TryGetValue(underlying, out var selected) ? selected : null;
        return _byExpiry.TryGetValue((underlying, value), out var state) ? state : null;
    }

    /// <summary>The expiries this app is holding live data for right now, in date order.</summary>
    public IReadOnlyList<DateOnly> TrackedExpiries(string underlying) =>
        _trackedExpiries.TryGetValue(underlying.ToUpperInvariant(), out var list) ? list : Array.Empty<DateOnly>();

    /// <summary>The strike/side verification list for GET /api/cdv/{underlying}/strikes - see
    /// CdvUnderlyingState.GetTrackedStrikes. _subscribedTokens (this service's own bookkeeping, not
    /// the state's) is what tells that method which strikes are the CURRENTLY active ATM+-8 window
    /// versus ones that rolled out earlier today.</summary>
    public IReadOnlyList<CdvStrikeInfo> GetTrackedStrikes(string underlying, DateOnly? expiry = null)
    {
        var state = StateFor(underlying, expiry);
        if (state is null) return Array.Empty<CdvStrikeInfo>();

        var key = (underlying.ToUpperInvariant(), state.Expiry ?? default);
        var active = _subscribedTokens.TryGetValue(key, out var tokens) ? tokens : new HashSet<uint>();
        return state.GetTrackedStrikes(active);
    }

    /// <summary>This underlying's strike step (50 for NIFTY, 100 for BANKNIFTY), or 0 if unknown.</summary>
    public int StepFor(string underlying) =>
        Underlyings.FirstOrDefault(u => string.Equals(u.Underlying, underlying, StringComparison.OrdinalIgnoreCase)).Step;

    /// <summary>How many of the nearest listed expiries this underlying tracks at once - see the
    /// Underlyings table.</summary>
    private static int TrackedExpiryCountFor(string underlying) =>
        Math.Max(1, Underlyings.FirstOrDefault(u => string.Equals(u.Underlying, underlying, StringComparison.OrdinalIgnoreCase)).TrackedExpiries);

    /// <summary>Every expiry the scrip master lists for this underlying, plus whichever one CDV is
    /// currently tracking - the dashboard/Backtrack expiry selector's payload. "Currently tracking"
    /// mirrors RecenterAsync's own resolution exactly (a manual override if one is set and hasn't
    /// lapsed, otherwise the nearest unexpired expiry), so the selector never shows a value that
    /// disagrees with what CdvUnderlyingState.Expiry will read on the next tick.</summary>
    public ExpiryOptions GetExpiryOptions(string underlying)
    {
        underlying = underlying.ToUpperInvariant();
        var today = IstToday();

        // The TRACKED expiries, not every listed one. A picker offering an expiry with no live
        // subscription behind it would be offering an empty chart, and (on the Triggers page) an
        // order priced off a rate-limited snapshot instead of the feed. Falls back to the listed
        // set only before the first recenter has resolved anything, so the picker is never empty
        // while the app is still starting up.
        var tracked = TrackedExpiries(underlying);
        var expiries = tracked.Count > 0 ? tracked : ResolveTrackedExpiries(underlying, today);

        var isManual = _expiryOverride.TryGetValue(underlying, out var overrideExpiry) && expiries.Contains(overrideExpiry);
        var selected = isManual ? overrideExpiry : expiries.FirstOrDefault(e => e >= today, expiries.Count > 0 ? expiries[0] : default);

        return new ExpiryOptions(underlying, expiries, expiries.Count > 0 ? selected : null, isManual);
    }

    /// <summary>The nearest N unexpired listed expiries for this underlying, N from the Underlyings
    /// table. This is the whole tracking policy in one place.</summary>
    private IReadOnlyList<DateOnly> ResolveTrackedExpiries(string underlying, DateOnly today) =>
        _optionChainMaster.GetExpiries(underlying)
            .Where(e => e >= today)
            .OrderBy(e => e)
            .Take(TrackedExpiryCountFor(underlying))
            .ToList();

    private static DateOnly IstToday() => DateOnly.FromDateTime(DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(5.5)).DateTime);

    /// <summary>Points this underlying's always-on consumers - the SignalR broadcast and the live
    /// alert services, which have no page to ask - at a different tracked expiry.
    ///
    /// This used to unsubscribe everything, wipe the state and re-backfill, because the app held
    /// exactly one expiry and switching meant replacing it. Every tracked expiry now has its own
    /// state (see _byExpiry), so this is a pointer move: instant, and it destroys nothing. Switching
    /// away and back costs nothing, and an armed trigger reading its OWN expiry is unaffected either
    /// way.
    ///
    /// A null <paramref name="expiry"/> clears the manual pick and reverts to the nearest tracked
    /// expiry.
    ///
    /// Returns null on success, or a user-facing reason it was refused (unknown underlying, or an
    /// expiry that is not currently tracked - the picker only offers tracked ones, so this is a
    /// stale page rather than a real choice).</summary>
    public async Task<string?> SelectExpiryAsync(string underlying, DateOnly? expiry, CancellationToken cancellationToken)
    {
        underlying = underlying.ToUpperInvariant();
        if (StepFor(underlying) <= 0) return $"Unknown underlying '{underlying}'.";

        if (expiry is { } picked)
        {
            try
            {
                await _optionChainMaster.EnsureLoadedAsync(cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogWarning(ex, "Could not refresh the option chain master while selecting an expiry for {Underlying}.", underlying);
            }

            if (!_byExpiry.TryGetValue((underlying, picked), out var pickedState))
                return $"{picked:yyyy-MM-dd} is not currently tracked for {underlying}.";

            _expiryOverride[underlying] = picked;
            _selected[underlying] = pickedState;
        }
        else
        {
            _expiryOverride.TryRemove(underlying, out _);
            var nearest = TrackedExpiries(underlying).FirstOrDefault();
            if (nearest != default && _byExpiry.TryGetValue((underlying, nearest), out var nearestState))
                _selected[underlying] = nearestState;
        }

        _logger.LogInformation("CDV: {Underlying} selection switched to {Expiry}.",
            underlying, expiry is { } e ? e.ToString("yyyy-MM-dd") : "auto (nearest tracked)");
        return null;
    }

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
    public async Task<OptionChainResponse?> GetChainAsync(string underlying, int spanSteps, CancellationToken cancellationToken, DateOnly? expiryFilter = null)
    {
        var state = StateFor(underlying, expiryFilter);
        if (state is null) return null;

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

    /// <summary>Every contract the scrip master lists for one underlying/expiry, with what this app
    /// currently knows about each: whether the feed is subscribed to it, whether CDV tracks it, and
    /// its latest tick. Powers the Contracts page.
    ///
    /// The point of it is to separate three failures that all used to surface as one unhelpful "no
    /// data", each with a different fix:
    ///   - the master lists NOTHING (a bad scrip-master refresh - the failure that silently stopped
    ///     every order being placed);
    ///   - listed but not subscribed (outside the ATM+-8 window, or an expiry not tracked);
    ///   - subscribed but never ticked (a feed or authorisation problem).
    /// A null expiry means the nearest tracked one.</summary>
    public ContractsResponse GetContracts(string underlying, DateOnly? expiry)
    {
        underlying = underlying.ToUpperInvariant();

        var listed = _optionChainMaster.GetExpiries(underlying);
        var tracked = TrackedExpiries(underlying);
        var status = _optionChainMaster.Status();

        var resolved = expiry ?? (tracked.Count > 0 ? tracked[0] : listed.FirstOrDefault(e => e >= IstToday()));
        var state = resolved == default ? null : StateFor(underlying, tracked.Contains(resolved) ? resolved : null);

        var rows = new List<ContractRow>();
        if (resolved != default)
        {
            foreach (var contract in _optionChainMaster.GetContracts(underlying, resolved))
            {
                var tick = _feedClient.LastTickFor(contract.SecurityId);
                rows.Add(new ContractRow(
                    contract.SecurityId,
                    contract.TradingSymbol,
                    contract.Strike,
                    contract.IsCall ? "CE" : "PE",
                    contract.LotSize,
                    contract.TickSize,
                    Subscribed: _feedClient.IsSubscribed(contract.SecurityId),
                    // Tracked means THIS expiry's own state holds it - only meaningful when the
                    // expiry being viewed is one the app tracks.
                    Tracked: state is not null && state.Expiry == resolved && state.IsTracked(contract.SecurityId),
                    LastPrice: tick?.LastPrice,
                    Volume: tick?.Volume,
                    LastTickUtc: tick?.ExchangeTimestamp));
            }
        }

        return new ContractsResponse(
            underlying,
            resolved == default ? null : resolved,
            listed,
            tracked,
            status.ContractCount,
            status.LoadedAt,
            _feedClient.SubscribedCount,
            rows);
    }

    /// <summary>One strike's LIVE premium on any listed expiry, from Dhan's Option Chain API -
    /// what a live order needs when it is being placed in an expiry this app is not tracking (see
    /// StrategyTrigger.OrderExpiry). The websocket feed only carries the tracked expiry's ATM+-8
    /// contracts, so for anything else this snapshot is the only live price available.
    ///
    /// Null when there is no quote: no session, the rate limiter refusing, outside market hours, or
    /// that strike simply not being in the chain. A caller pricing an order must treat that as "do
    /// not place" rather than falling back to some other contract's price.
    ///
    /// <paramref name="maxAge"/> is passed straight through to DhanOptionChainQuotes - order
    /// pricing wants a fresher snapshot than the strike picker does.</summary>
    public async Task<decimal?> GetChainPremiumAsync(
        string underlying, DateOnly expiry, decimal strike, bool isCall, CancellationToken cancellationToken, TimeSpan? maxAge = null)
    {
        // A tracked expiry has a live feed behind it, which beats any snapshot - only fall through
        // to the rate-limited Option Chain API for one this app is not subscribed to.
        if (_byExpiry.TryGetValue((underlying.ToUpperInvariant(), expiry), out var tracked)
            && tracked.GetStrikeCandles(strike, isCall) is { Count: > 0 } live)
            return live[^1].Close;

        var instrument = _spotFeed.States.TryGetValue(underlying, out var spotState) ? spotState.Instrument : null;
        if (instrument is null) return null;

        var quotes = await _chainQuotes.GetQuotesAsync(instrument.SecurityId, instrument.DhanSegment, expiry, cancellationToken, maxAge);
        var quote = quotes.FirstOrDefault(q => q.Strike == strike);
        if (quote is null) return null;

        var price = isCall ? quote.CeLastPrice : quote.PeLastPrice;
        return price > 0 ? price : null;
    }

    /// <summary>
    /// One strike's premium candles for the dashboard chart. Tracked strikes (inside, or previously
    /// inside today, the CDV ATM+-8 window) answer straight from memory including the still-forming
    /// bar, exactly as the ATM charts do. Any other listed strike is fetched from Dhan's intraday
    /// history on demand and cached briefly - that history is complete but static, so such a chart
    /// shows the same days as the tracked ones but only advances when re-fetched, which is the
    /// trade-off for being able to look at a strike this app never subscribed to.
    /// </summary>
    public async Task<IReadOnlyList<Candle>> GetStrikeCandlesAsync(
        string underlying, decimal strike, bool isCall, CancellationToken cancellationToken, DateOnly? expiryFilter = null)
    {
        var state = StateFor(underlying, expiryFilter);
        if (state is null) return Array.Empty<Candle>();

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
            // cacheKey.Day is always TODAY (built fresh above), so any entry under a different day
            // can never be looked up again - it just sits there forever otherwise, one leaked entry
            // per distinct strike ever viewed through the picker for the lifetime of the process.
            // Sweeping them out here (rather than on a timer) means the dictionary self-cleans the
            // moment anyone actually uses this endpoint again, with no extra background work needed
            // on a quiet day.
            if (_onDemandCandles.Count > 0)
            {
                foreach (var key in _onDemandCandles.Keys.Where(k => k.Day != cacheKey.Item2).ToList())
                    _onDemandCandles.Remove(key);
            }

            // Deliberately keyed off the CURRENT time rather than when the entry was fetched: an
            // entry cached at 15:29 becomes reusable-for-hours at 15:31, because what makes it safe
            // is that the session is over now, not when the fetch happened. The reverse case (an
            // entry cached after close, read the next morning) cannot arise - the sweep above
            // removes it the moment the IST date changes.
            var lifetime = TimeOnly.FromDateTime(DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(5.5)).DateTime) >= SessionClose
                ? OnDemandCandleLifetimeAfterClose
                : OnDemandCandleLifetime;

            if (_onDemandCandles.TryGetValue(cacheKey, out var cached) && DateTimeOffset.UtcNow - cached.FetchedAt < lifetime)
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

        // One loop rather than a startup phase and then a steady phase, because they want the same
        // thing: recenter, and come back SOON if anything is still missing.
        //
        // "Missing" means an underlying with no ATM resolved, or a tracked expiry with nothing
        // subscribed. Both are ordinary startup states - the first recenter routinely loses the race
        // with SpotFeedHostedService's own scrip-master download and backfill - and both are also
        // what a transient failure looks like afterwards (a scrip master that briefly parsed to
        // nothing, a Dhan call that failed). Retrying those in 30 seconds rather than waiting out
        // the full 30-minute cadence is the difference between a gap and an outage: an underlying
        // that failed its recenter used to have no strikes, no CDV and no option candles for half an
        // hour, and every trigger on it went quiet for that whole time.
        while (!stoppingToken.IsCancellationRequested)
        {
            var complete = await RecenterAllAsync(stoppingToken);

            try
            {
                await Task.Delay(complete ? AtmRecenterInterval : IncompleteRetryInterval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    /// <summary>Recenters every underlying - NIFTY and BANKNIFTY alike, each on every expiry it
    /// tracks. Returns true only when every underlying has an ATM and every tracked expiry has at
    /// least one live subscription, i.e. when there is nothing to come back early for.
    ///
    /// Deliberately swallows a per-underlying failure. This loop is the ONLY thing keeping the
    /// strike windows current, so letting one underlying's exception escape would end it for good
    /// and freeze both: NIFTY and BANKNIFTY share this loop, and a BANKNIFTY-only fault must never
    /// take NIFTY's data down with it.</summary>
    private async Task<bool> RecenterAllAsync(CancellationToken cancellationToken)
    {
        try
        {
            await _optionChainMaster.EnsureLoadedAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Could not refresh the Dhan option chain for this re-center - keeping the previous strike window.");
        }

        var complete = true;

        foreach (var (underlying, step, _) in Underlyings)
        {
            if (cancellationToken.IsCancellationRequested) return false;

            await _recenterLock.WaitAsync(cancellationToken);
            try
            {
                await RecenterAsync(underlying, step, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                return false;
            }
            catch (Exception ex)
            {
                complete = false;
                _logger.LogError(ex, "CDV: {Underlying} re-center failed - retrying shortly. Its existing strike window is left exactly as it was.", underlying);
            }
            finally
            {
                _recenterLock.Release();
            }

            complete &= IsUnderlyingLive(underlying);
        }

        return complete;
    }

    /// <summary>Whether this underlying has everything it needs to be producing data right now: an
    /// ATM resolved, at least one tracked expiry, and a live subscription on every one of them.
    /// Anything else means some page or trigger is looking at an empty chain.</summary>
    private bool IsUnderlyingLive(string underlying)
    {
        if (!_selected.TryGetValue(underlying, out var selected) || selected.AtmStrike is null) return false;

        var tracked = TrackedExpiries(underlying);
        if (tracked.Count == 0) return false;

        return tracked.All(e => _subscribedTokens.TryGetValue((underlying, e), out var tokens) && tokens.Count > 0);
    }

    /// <summary>Caller must hold _recenterLock for this underlying's whole reset/recenter sequence -
    /// see that field's doc comment. Both call sites (RecenterAllAsync's loop and SelectExpiryAsync)
    /// already do.
    ///
    /// Resolves which expiries this underlying should be tracking right now, recenters EACH of them
    /// onto its own ATM+-8 window, and drops any expiry that has rolled off the list (it expired, or
    /// a nearer one appeared) - unsubscribing its contracts and forgetting its state, since nothing
    /// can read it any more.</summary>
    private async Task RecenterAsync(string underlying, int step, CancellationToken cancellationToken)
    {
        var spot = _spotFeed.States.TryGetValue(underlying, out var spotState) ? spotState.LastPrice : 0;
        if (spot <= 0)
        {
            _logger.LogInformation("CDV: {Underlying} has no spot price yet - skipping this re-center.", underlying);
            return;
        }

        var today = IstToday();
        var wanted = ResolveTrackedExpiries(underlying, today);
        if (wanted.Count == 0)
        {
            _logger.LogWarning("CDV: {Underlying} - no listed option expiry found. Skipping.", underlying);
            return;
        }

        // Per expiry, because they are independent: one expiry failing (a contract the master
        // cannot resolve, a backfill call that threw) must not cost the others their recenter, nor
        // skip the bookkeeping below that keeps the tracked set and the selection honest.
        foreach (var expiry in wanted)
        {
            try
            {
                await RecenterExpiryAsync(underlying, step, expiry, spot, today, cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "CDV: {Underlying} {Expiry} re-center failed - its window is left as it was, the other expiries continue.", underlying, expiry);
            }
        }

        await DropUntrackedExpiriesAsync(underlying, wanted, cancellationToken);
        _trackedExpiries[underlying] = wanted;

        // One line saying what is live per expiry, so "is every expiry actually subscribed?" is a
        // thing to READ rather than assume. Each expiry carries its own full ATM+-8 window (17
        // strikes x CE/PE), so a number well below ~34 here means contracts the scrip master could
        // not resolve - which is exactly the failure that reads as a strike "not listed" later.
        _logger.LogInformation("CDV: {Underlying} tracking {Count} expiry/expiries - {Detail}.",
            underlying, wanted.Count,
            string.Join(", ", wanted.Select(e =>
                $"{e:yyyy-MM-dd}: {(_subscribedTokens.TryGetValue((underlying, e), out var t) ? t.Count : 0)} contract(s)")));

        // Keep the always-on consumers pointed at something real: the manual pick while it is still
        // tracked, otherwise the nearest. A manual pick that has rolled off the list is dropped here
        // rather than left pointing at a state that no longer exists.
        var chosen = _expiryOverride.TryGetValue(underlying, out var manual) && wanted.Contains(manual) ? manual : wanted[0];
        if (chosen != manual) _expiryOverride.TryRemove(underlying, out _);
        if (_byExpiry.TryGetValue((underlying, chosen), out var chosenState)) _selected[underlying] = chosenState;
    }

    /// <summary>One expiry's own recenter: the exact sequence this method always ran for the single
    /// tracked expiry, now scoped to one of several. Each expiry keeps its own state, its own
    /// subscription set and its own backfill bookkeeping, so their windows move independently.</summary>
    private async Task RecenterExpiryAsync(
        string underlying, int step, DateOnly expiry, decimal spot, DateOnly today, CancellationToken cancellationToken)
    {
        var key = (underlying, expiry);
        var state = _byExpiry.GetOrAdd(key, _ => new CdvUnderlyingState(underlying));
        if (!_subscribedTokens.ContainsKey(key)) _subscribedTokens[key] = new HashSet<uint>();

        // CDV is a SESSION indicator (see CdvUnderlyingState.TradingDay's doc comment) - the moment
        // the IST calendar date rolls over, yesterday's whole strike chain and running totals are no
        // longer meaningful and must start clean, exactly like LiveSpreadCalculator's own CDV port
        // does on its "freshDay" check.
        if (state.TradingDay is { } lastTradingDay && lastTradingDay != today)
            await ResetForNewDayAsync(underlying, expiry, state, cancellationToken);
        state.TradingDay = today;

        var atm = (int)(Math.Round(spot / step) * step);
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
                var contract = _optionChainMaster.Find(underlying, expiry, strike, isCall);
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
        // at once, per tracked expiry - a one-time cost, not repeated once everything has succeeded.
        if (needsBackfill.Count > 0)
            await BackfillStrikesAsync(underlying, expiry, state, needsBackfill, spot, cancellationToken);

        var currentlySubscribed = _subscribedTokens[key];
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
            foreach (var token in toUnsubscribe) _bySecurityId.TryRemove(token, out _);
        }

        _subscribedTokens[key] = desiredTokens;

        _logger.LogInformation(
            "CDV: {Underlying} {Expiry} spot={Spot} -> ATM={Atm}. Tracking CE strikes [{Ce}] and PE strikes [{Pe}].",
            underlying, expiry, spot, atm, string.Join(", ", ceList.OrderBy(v => v)), string.Join(", ", peList.OrderBy(v => v)));
    }

    /// <summary>Forgets every expiry this underlying is holding that is no longer in the tracked
    /// set - it expired, or a nearer one was listed and pushed it off the end. Unsubscribes its
    /// contracts (they would otherwise keep streaming into a state nothing reads) and drops its
    /// state and bookkeeping.</summary>
    private async Task DropUntrackedExpiriesAsync(string underlying, IReadOnlyList<DateOnly> wanted, CancellationToken cancellationToken)
    {
        var stale = _byExpiry.Keys
            .Where(k => string.Equals(k.Underlying, underlying, StringComparison.OrdinalIgnoreCase) && !wanted.Contains(k.Expiry))
            .ToList();

        foreach (var key in stale)
        {
            if (_subscribedTokens.TryGetValue(key, out var tokens) && tokens.Count > 0)
            {
                await _feedClient.UnsubscribeAsync(tokens, cancellationToken);
                foreach (var token in tokens) _bySecurityId.TryRemove(token, out _);
            }
            _subscribedTokens.TryRemove(key, out _);
            _cdvHistorySeeded.Remove(key);
            _byExpiry.TryRemove(key, out _);
            _logger.LogInformation("CDV: {Underlying} {Expiry} is no longer tracked - unsubscribed and dropped.", underlying, key.Expiry);
        }
    }

    /// <summary>Unsubscribes one (underlying, expiry)'s currently-live tokens, drops the
    /// bookkeeping pointing at its about-to-be-wiped CdvUnderlyingState, and calls Reset(). Now a
    /// day-rollover path only: switching expiry no longer wipes anything (see SelectExpiryAsync).
    /// After this returns, RecenterExpiryAsync's normal EnsureTracked/backfill/subscribe flow runs
    /// exactly as it would for a brand-new state.</summary>
    private async Task ResetForNewDayAsync(string underlying, DateOnly expiry, CdvUnderlyingState state, CancellationToken cancellationToken)
    {
        var key = (underlying, expiry);
        if (_subscribedTokens.TryGetValue(key, out var tokens) && tokens.Count > 0)
        {
            await _feedClient.UnsubscribeAsync(tokens, cancellationToken);
            foreach (var token in tokens) _bySecurityId.TryRemove(token, out _);
        }
        _subscribedTokens[key] = new HashSet<uint>();
        _cdvHistorySeeded.Remove(key);
        state.Reset();
        _logger.LogInformation("CDV: {Underlying} {Expiry} - new trading day, resetting CDV state.", underlying, expiry);
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
    private async Task BackfillStrikesAsync(string underlying, DateOnly expiry, CdvUnderlyingState state, IReadOnlyList<uint> securityIds, decimal currentSpot, CancellationToken cancellationToken)
    {
        var today = DateOnly.FromDateTime(DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(5.5)).DateTime);
        var fromDay = today.AddDays(-HistoryLookbackCalendarDays);
        var seededCount = 0;

        // The underlying's own 1-minute spot history, so each historical option bar can be weighted
        // by the moneyness that ACTUALLY applied when it traded rather than by today's spot. Over a
        // 15-day window that difference is large: a strike at ATM two weeks ago can be far OTM now,
        // and today's spot would score its volume at nearly nothing. Empty (a spot backfill that
        // hasn't landed yet) simply falls back to currentSpot per bar, which is the behaviour this
        // replaces.
        var spotByTime = _spotFeed.States.TryGetValue(underlying, out var spotState)
            ? spotState.GetClosedCandles().GroupBy(c => c.Time).ToDictionary(g => g.Key, g => g.Last().Close)
            : new Dictionary<DateTimeOffset, decimal>();

        // Only the underlying's very first backfill batch feeds the combined CDV reconstruction -
        // see CdvUnderlyingState.SeedStrikeHistory's includeInCdvHistory doc comment for why a later
        // batch (ATM rolled onto a strike never tracked before) can't retroactively merge into it.
        // Every batch still seeds each strike's own price/volume history regardless, which is what
        // backs that strike's ATM CE/PE chart once it becomes the ATM contract.
        var includeInCdvHistory = _cdvHistorySeeded.Add((underlying, expiry));

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

            // trimmed spans up to HistoryTradingDays. Today's own slice feeds the LIVE running
            // total that ticks then continue from; the earlier days are reconstructed separately
            // just below, each restarting at its own zero (CDV is a session indicator - see
            // CdvUnderlyingState.TradingDay).
            var todayBars = trimmed.Where(b => IstDate(b.Time) == today).ToList();
            state.SeedStrikeHistory(securityId, trimmed, todayBars, currentSpot, includeInCdvHistory);

            if (includeInCdvHistory)
            {
                // EVERY past day in the window, not just yesterday - CDV still restarts at zero for
                // each of them (see CdvUnderlyingState.FinalizeHistory), it is simply retained now
                // rather than discarded, so a backtest can ask a CDV question about any day.
                var pastBars = trimmed.Where(b => IstDate(b.Time) != today).ToList();
                state.SeedHistoricalDayStrike(securityId, pastBars, spotByTime, currentSpot);
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
                _cdvHistorySeeded.Remove((underlying, expiry));
            }
            else
            {
                state.FinalizeCdvBackfill();
                state.FinalizeHistory();
            }
        }
        _logger.LogInformation("CDV: backfilled {Seeded}/{Total} contract(s) for {Underlying} {Expiry} (CDV history {Included}).",
            seededCount, securityIds.Count, underlying, expiry,
            includeInCdvHistory ? (seededCount > 0 ? "included" : "failed - will retry") : "not included - later batch");
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

        // Every tracked expiry updates its own state, but only the SELECTED one is broadcast: the
        // snapshot names its underlying and not its expiry, so pushing all of them would interleave
        // three different chains into one chart. The others are read on demand instead, by a caller
        // that names the expiry it wants.
        if (_selected.TryGetValue(state.Underlying, out var selected) && ReferenceEquals(selected, state))
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

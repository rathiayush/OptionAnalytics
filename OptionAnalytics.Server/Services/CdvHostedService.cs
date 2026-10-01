using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Hubs;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Computes CE/PE cumulative delta volume (CDV) for NIFTY/BANKNIFTY/SENSEX's near-the-money option
/// chain: every 30 minutes, re-centers on the current ATM strike (spot rounded to the nearest
/// strike step) and tracks the 16-ITM + 16-OTM window around it for both CE and PE (33 strikes x 2
/// sides = up to 66 contracts), subscribing/unsubscribing on the shared DhanMarketFeedClient as
/// the window moves. Every option tick is folded into its underlying's CdvUnderlyingState (tick
/// rule + sigmoid moneyness delta-weighting - see that class) and the resulting CE/PE totals are
/// pushed to the dashboard over the same SpotHub the spot chart uses.
/// </summary>
public sealed class CdvHostedService : BackgroundService
{
    /// <summary>Each underlying, its strike step, and HOW MANY of the nearest listed expiries this
    /// app tracks live at once.
    ///
    /// NIFTY and SENSEX both list weeklies, so 3 covers the current week plus the next two - which,
    /// near a monthly roll, is what "current + next two" has to mean to include the month itself.
    /// BANKNIFTY lists monthlies only (SEBI's 2024 rule keeps a single weekly index derivative per
    /// exchange - NIFTY holds that slot on NSE, SENSEX holds it on BSE), so 2 is the current month
    /// plus the next.
    ///
    /// Every tracked expiry costs its own ATM+-16 window: 33 strikes x CE/PE = up to 66 live
    /// contracts and 66 backfill calls each. That is the whole price of this - 198 contracts for
    /// NIFTY/SENSEX and 132 for BANKNIFTY rather than 66 apiece - and the reason this is a small
    /// fixed number per underlying rather than "every listed expiry". Comfortably inside Dhan's own
    /// feed limit (DhanMarketFeedClient.MaxInstrumentsPerConnection, 5000) with room to spare for
    /// spot and every other underlying's own window.</summary>
    private static readonly (string Underlying, int Step, int TrackedExpiries)[] Underlyings =
    {
        ("NIFTY", 50, 3),
        ("BANKNIFTY", 100, 2),
        ("SENSEX", 100, 3),
    };

    /// <summary>16 ITM + 16 OTM strikes around ATM (so 33 strikes total, ATM included), for both CE
    /// and PE - wide enough that a strategy's own otmSteps (up to +-8 today) never comes close to
    /// the edge of what is actually tracked, live, and backfilled.</summary>
    private const int StrikeRange = 16;

    private static readonly TimeSpan AtmRecenterInterval = TimeSpan.FromMinutes(30);

    /// <summary>How soon to retry when a recenter left something without data - no ATM resolved, or
    /// a tracked expiry with nothing subscribed. Short, because that state means a page or a trigger
    /// is looking at an empty chain RIGHT NOW; the full 30-minute cadence resumes as soon as
    /// everything is live again.</summary>
    private static readonly TimeSpan IncompleteRetryInterval = TimeSpan.FromSeconds(30);

    /// <summary>How long before a strike whose backfill came back EMPTY is asked for again: this
    /// long after the first failure, doubling per failure up to EmptyStrikeMaxRetryInterval.
    ///
    /// Starts SHORT because the usual reason a fetch returns nothing is that the data is not there
    /// yet rather than never - the app started before the open, or this underlying is simply last in
    /// the backfill queue (three underlyings x up to three expiries x 66 contracts, paced by
    /// BackfillCallDelay, is minutes of calls) and its turn came round before Dhan had anything to
    /// give. Those fill as soon as they can. It grows because a strike still empty after a dozen
    /// tries is not waiting on anything, and at 66 strikes per expiry those retries are what spends
    /// the shared Dhan history rate limit the working underlyings need.</summary>
    private static readonly TimeSpan EmptyStrikeRetryInterval = TimeSpan.FromSeconds(45);
    private static readonly TimeSpan EmptyStrikeMaxRetryInterval = TimeSpan.FromMinutes(30);

    /// <summary>Matches SpotFeedHostedService's own backfill window exactly - the option premium
    /// charts and CDV's reconstructed history need to cover the same trading days the spot chart
    /// does, or the charts would visibly disagree on how far back "history" goes. Both read the
    /// same HistoryWindow constants so they cannot drift apart.</summary>
    private const int HistoryTradingDays = HistoryWindow.TradingDays;
    private const int HistoryLookbackCalendarDays = HistoryWindow.LookbackCalendarDays;

    /// <summary>Dhan gives no documented rate limit for this endpoint, but a recenter can mean
    /// backfilling up to ~66 contracts (33 strikes x CE/PE) back to back on first startup - a small
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

    /// <summary>IST time a forced scrip-master re-download happens once per day, ahead of the
    /// 09:15 open - independent of EnsureLoadedAsync's own 12-hour cache (a process that has been
    /// running continuously since yesterday would otherwise still read as "fresh" going into a new
    /// trading day on data that is up to a day old). See _lastDailyMasterRefreshIstDate.</summary>
    private static readonly TimeOnly DailyMasterRefreshTime = new(6, 0);

    private readonly DhanOptionChainMaster _optionChainMaster;
    private readonly DhanOptionChainQuotes _chainQuotes;
    private readonly DhanMarketFeedClient _feedClient;
    private IDisposable? _tickSubscription;
    private readonly SpotFeedHostedService _spotFeed;
    private readonly DhanHistoricalDataService _historicalData;
    private readonly IHubContext<SpotHub> _hub;
    private readonly LiveBroadcastBatcher _batcher;
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
    /// ATM+-16 window that moves independently, so the subscribe/unsubscribe diff has to be computed
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

    /// <summary>The IST date the daily 06:00 forced scrip-master refresh last ran, so
    /// RecenterAllAsync fires it once per day rather than on every recenter after 06:00. Only
    /// written from that loop, so no lock needed.</summary>
    private DateOnly? _lastDailyMasterRefreshIstDate;

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
        LiveBroadcastBatcher batcher,
        ILogger<CdvHostedService> logger,
        IConfiguration? configuration = null)
    {
        _enabled = configuration?.GetValue("Cdv:Enabled", true) ?? true;
        _batcher = batcher;
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
    /// the state's) is what tells that method which strikes are the CURRENTLY active ATM+-16 window
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
    /// <summary>Per underlying/expiry: how many strikes are tracked, and how many of them actually
    /// hold candles. The one number that separates "this underlying's option history is missing"
    /// from "these particular strikes didn't trade" - a tracked strike with zero candles got no
    /// backfill, and a whole expiry of them means the fetch is failing rather than the market being
    /// quiet. Read by SpotController's diagnostics endpoint.</summary>
    public IReadOnlyList<(string Underlying, DateOnly Expiry, int TrackedStrikes, int StrikesWithCandles)> GetOptionCoverage()
    {
        var coverage = new List<(string, DateOnly, int, int)>();

        foreach (var (underlying, _, _) in Underlyings)
        {
            foreach (var expiry in TrackedExpiries(underlying))
            {
                if (StateFor(underlying, expiry) is not { } state) continue;

                var strikes = GetTrackedStrikes(underlying, expiry);
                var withCandles = strikes.Count(s => state.GetStrikeCandles(s.Strike, s.IsCall) is { Count: > 0 });
                coverage.Add((underlying, expiry, strikes.Count, withCandles));
            }
        }

        return coverage;
    }

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

    private static DateOnly IstToday() => IstClock.Today();

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
    /// in the scrip master. Wider than the ATM+-16 window CDV subscribes to, deliberately - a chart
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
    ///   - listed but not subscribed (outside the ATM+-16 window, or an expiry not tracked);
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

    /// <summary>Forces the scrip master to re-download right now (see
    /// DhanOptionChainMaster.ForceRefreshAsync) and then immediately re-centers every underlying, so
    /// any contract the master could not resolve before is subscribed and backfilled straight away
    /// rather than waiting for the next scheduled recenter (up to 30 minutes) or the automatic
    /// empty-retry cadence (up to a minute) to get there. This is what the Contracts page's
    /// "Refresh master" button calls - the self-serve fix for exactly the failure that page exists
    /// to surface: the master reads as empty right now.
    ///
    /// Recenter runs even when the master refresh itself failed or came back empty - if the
    /// download genuinely failed, recenter will find the same 0 contracts and change nothing, which
    /// is harmless; if it succeeded, this is what turns "the master has contracts again" into
    /// "these contracts are actually subscribed and backfilled" without the caller needing a second
    /// step.</summary>
    public async Task<(int ContractCount, DateTimeOffset? LoadedAt, string? Error)> ForceRefreshMasterAsync(CancellationToken cancellationToken)
    {
        var result = await _optionChainMaster.ForceRefreshAsync(cancellationToken);
        await RecenterAllAsync(cancellationToken);
        return result;
    }

    /// <summary>One strike's LIVE premium on any listed expiry, from Dhan's Option Chain API -
    /// what a live order needs when it is being placed in an expiry this app is not tracking (see
    /// StrategyTrigger.OrderExpiry). The websocket feed only carries the tracked expiry's ATM+-16
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

    /// <summary>Every strike's OPEN INTEREST on one expiry/side, from Dhan's Option Chain API -
    /// what StrategyTriggerHostedService needs to tell a real hedge strike from a listed-but-dead
    /// one (see StrategyTrigger.HedgeMinOpenInterestPercent).
    ///
    /// The chain snapshot, not the websocket feed, is the only possible source here: a hedge sits
    /// HedgeOtmSteps beyond an already-OTM sold strike, which routinely puts it outside the ATM+-16
    /// window this service actually subscribes, and SpotTick carries no OI field even for the
    /// strikes it does cover. This one call answers for the whole chain at once, however far out
    /// the hedge lands.
    ///
    /// EMPTY whenever the call isn't available - no session, the rate limiter refusing, outside
    /// market hours - never an exception. The caller treats empty as "no liquidity opinion" and
    /// falls back to its other guards rather than refusing to trade.</summary>
    public async Task<IReadOnlyDictionary<decimal, long>> GetChainOpenInterestAsync(
        string underlying, DateOnly expiry, bool isCall, CancellationToken cancellationToken, TimeSpan? maxAge = null)
    {
        var instrument = _spotFeed.States.TryGetValue(underlying, out var spotState) ? spotState.Instrument : null;
        if (instrument is null) return new Dictionary<decimal, long>();

        var quotes = await _chainQuotes.GetQuotesAsync(instrument.SecurityId, instrument.DhanSegment, expiry, cancellationToken, maxAge);

        var byStrike = new Dictionary<decimal, long>();
        foreach (var quote in quotes)
        {
            var oi = isCall ? quote.CeOpenInterest : quote.PeOpenInterest;
            if (oi is { } value) byStrike[quote.Strike] = value;
        }
        return byStrike;
    }

    /// <summary>
    /// One strike's premium candles for the dashboard chart. A strike still INSIDE the CDV ATM+-16
    /// window right now answers straight from memory including the still-forming bar, exactly as
    /// the ATM charts do. Any other strike - never tracked, or one that WAS tracked earlier but has
    /// since fallen out of the window - is fetched from Dhan's intraday history on demand and
    /// cached briefly: a strike that dropped out stops receiving ticks altogether and is never
    /// re-backfilled even if it later re-enters (EnsureTracked is a no-op on an already-tracked
    /// strike), so its own in-memory series would otherwise sit frozen at whatever day it dropped
    /// out on FOREVER rather than merely being a bit stale - "tracked" alone does not mean
    /// "current". The on-demand history is complete but static, so such a chart shows the same days
    /// as a currently-tracked one but only advances when re-fetched, which is the trade-off for
    /// being able to look at a strike this app isn't (or is no longer) live-subscribed to.
    /// </summary>
    public async Task<IReadOnlyList<Candle>> GetStrikeCandlesAsync(
        string underlying, decimal strike, bool isCall, CancellationToken cancellationToken, DateOnly? expiryFilter = null)
    {
        var state = StateFor(underlying, expiryFilter);
        if (state is null) return Array.Empty<Candle>();

        // Trusted outright only while it actually reaches today - a series that stops short of
        // that has fallen out of the live window (see this method's own doc comment) rather than
        // merely being "tracked seconds ago, nothing seeded yet" (which is also Count == 0, so it
        // falls through to the same on-demand fetch below, exactly as it always did).
        var tracked = state.GetStrikeCandles(strike, isCall);
        if (tracked is { Count: > 0 } && IstClock.IstDate(tracked[^1].Time) >= IstClock.Today()) return tracked;

        var expiry = state.Expiry;
        if (expiry is null) return Array.Empty<Candle>();

        var contract = _optionChainMaster.Find(underlying, expiry.Value, strike, isCall);
        if (contract is null) return Array.Empty<Candle>();

        var cacheKey = (contract.SecurityId, IstClock.Today());
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
            var lifetime = TimeOnly.FromDateTime(DateTimeOffset.UtcNow.ToOffset(IstClock.Offset).DateTime) >= SessionClose
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
            var (fetched, error) = await _historicalData.GetIntradayOptionCandlesAsync(contract.SecurityId, contract.DhanSegment, fromDay, today, 1, cancellationToken);
            bars = fetched;
            if (error is not null)
                _logger.LogWarning("On-demand candle fetch failed for {Underlying} {Strike}{Type} ({Segment}:{Id}) - {Error}",
                    underlying, strike, isCall ? "CE" : "PE", contract.DhanSegment, contract.SecurityId, error);
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

    /// <summary>Cdv:Enabled (env Cdv__Enabled) - false turns CDV/OBV off entirely: no option strikes
    /// subscribed for it, no tick processing, no pushes. An emergency switch, should it ever be the
    /// thing holding the live feed back; the Dashboard's CDV/OBV cards then simply stay empty.</summary>
    private readonly bool _enabled;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_enabled)
        {
            _logger.LogWarning("CDV/OBV is turned off (Cdv:Enabled = false) - not tracking or processing any CDV strikes.");
            return;
        }

        try
        {
            await _optionChainMaster.EnsureLoadedAsync(stoppingToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "Could not load the Dhan option chain - CDV cannot resolve strikes yet. Will retry on the next re-center.");
        }

        _tickSubscription ??= _feedClient.AddTickConsumer("CDV", OnTick);

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
        await RefreshMasterForThisRecenterAsync(cancellationToken);

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

    /// <summary>The scrip master refresh this recenter opens with: a normal EnsureLoadedAsync
    /// (no-op once fresh) every time, plus - once per IST calendar day, the first recenter at or
    /// after 06:00 - a FORCED re-download regardless of the 12-hour cache. That cache alone would
    /// let a process that has been running continuously since yesterday go into a brand new trading
    /// day still reading as "fresh" on data that is, in the worst case, nearly a day old (new
    /// contracts listed overnight, lot-size revisions, whatever else Dhan's own file picked up
    /// before today's open). A restart already forces a fresh download on its own (a cold-started
    /// master always starts empty, so EnsureLoadedAsync's very first call downloads unconditionally)
    /// - this is for the case where the process ISN'T restarted across a day boundary.</summary>
    private async Task RefreshMasterForThisRecenterAsync(CancellationToken cancellationToken)
    {
        var nowIst = DateTimeOffset.UtcNow.ToOffset(IstClock.Offset);
        var todayIst = DateOnly.FromDateTime(nowIst.DateTime);
        var dueForDailyRefresh = TimeOnly.FromDateTime(nowIst.DateTime) >= DailyMasterRefreshTime && _lastDailyMasterRefreshIstDate != todayIst;

        if (dueForDailyRefresh)
        {
            var (count, _, error) = await _optionChainMaster.ForceRefreshAsync(cancellationToken);
            _lastDailyMasterRefreshIstDate = todayIst; // once attempted, not retried again today even on failure - EnsureLoadedAsync's own retry/backoff covers a failed download from here
            if (error is not null)
                _logger.LogError("Daily 06:00 IST scrip-master refresh failed: {Error}. Falling back to whatever was already loaded ({Count} contract(s)).", error, count);
            else
                _logger.LogInformation("Daily 06:00 IST scrip-master refresh: {Count} contract(s) loaded.", count);
            return;
        }

        try
        {
            await _optionChainMaster.EnsureLoadedAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Could not refresh the Dhan option chain for this re-center - keeping the previous strike window.");
        }
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
    /// onto its own ATM+-16 window, and drops any expiry that has rolled off the list (it expired, or
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
        // thing to READ rather than assume. Each expiry carries its own full ATM+-16 window (33
        // strikes x CE/PE), so a number well below ~66 here means contracts the scrip master could
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
        var state = _byExpiry.GetOrAdd(key, _ =>
        {
            var created = new CdvUnderlyingState(underlying);
            // Subscribed once, right here, rather than at every recenter - GetOrAdd's factory only
            // ever runs for a brand-new state, so this can never double-subscribe an existing one.
            created.AggregateBarClosed += () => OnAggregateBarClosed(underlying, created);
            return created;
        });
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
        // Which Dhan segment each desired token actually subscribes under - NSE_FNO for NIFTY/
        // BANKNIFTY, BSE_FNO for SENSEX (see DhanOptionInstrument.DhanSegment) - rather than one
        // segment assumed for every token below, now that this app spans two exchanges.
        var desiredSegments = new Dictionary<uint, string>();
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
                //
                // Rate-limited, because not every failure is transient. A contract that has simply
                // never traded - or every contract on an exchange this account has no data
                // entitlement for - comes back empty every single time and so never sets Backfilled.
                // This loop runs every 30 SECONDS rather than 30 minutes whenever any underlying is
                // not fully live (see RecenterAllAsync), so without a floor on retries one dead
                // exchange re-requests its entire strike window a hundred-odd times an hour,
                // spending the shared Dhan history rate limit that the underlyings which DO work
                // need for their own backfills.
                if (isNewlyTracked || state.NeedsBackfill(contract.SecurityId, EmptyStrikeRetryInterval, EmptyStrikeMaxRetryInterval))
                    needsBackfill.Add(contract.SecurityId);
                _bySecurityId[contract.SecurityId] = state;
                desiredTokens.Add(contract.SecurityId);
                desiredSegments[contract.SecurityId] = contract.DhanSegment;
                (isCall ? ceList : peList).Add(strike);
            }
        }

        // Backfill every strike that needs it BEFORE subscribing it live - otherwise a live tick
        // could arrive and start building a bar while the backfill for that same strike is still in
        // flight, corrupting SeedHistory's "nothing live yet" assumption. Cheap for a routine
        // 30-minute recenter (usually just a handful of strikes as the window shifts by one step,
        // plus any earlier failures still needing a retry); the one expensive case is the very
        // first recenter after startup, where the whole ATM+-16 window (up to 66 contracts) needs it
        // at once, per tracked expiry - a one-time cost, not repeated once everything has succeeded.
        if (needsBackfill.Count > 0)
            await BackfillStrikesAsync(underlying, expiry, state, needsBackfill, spot, cancellationToken);

        var currentlySubscribed = _subscribedTokens[key];
        var toSubscribe = desiredTokens.Where(t => !currentlySubscribed.Contains(t)).ToArray();
        var toUnsubscribe = currentlySubscribed.Where(t => !desiredTokens.Contains(t)).ToArray();

        if (toSubscribe.Length > 0)
        {
            var segments = toSubscribe.ToDictionary(t => t, t => desiredSegments[t]);
            // Full mode, not the default Quote - option strikes have a real order book, and this is
            // what gives StrategyTriggerHostedService a live best bid/ask to re-price an unfilled
            // order retry against instead of only the last traded price (see DhanMarketFeedClient's
            // own doc comment on the two modes).
            await _feedClient.SubscribeAsync(segments, cancellationToken, full: true);
        }
        if (toUnsubscribe.Length > 0)
            await UnsubscribeAndForgetAsync(toUnsubscribe, cancellationToken);

        _subscribedTokens[key] = desiredTokens;

        // Unconditionally re-affirm EVERY currently-desired token's subscription, not just the ones
        // newly added above (toSubscribe) - SubscribeAsync is a deliberate no-op for a token already
        // in DhanMarketFeedClient's own tracked set (see its own doc comment), so a strike Dhan
        // silently stopped ticking - its subscription quietly dropped server-side, while every other
        // strike (and spot, options elsewhere) keeps ticking completely normally - would otherwise
        // never be repaired: the shared connection-wide stall watchdog only notices when NOTHING at
        // all has arrived recently (see SpotFeedHostedService's own identical fix and
        // FeedStallDetector's doc comment). A per-strike staleness threshold isn't safe here the way
        // it is for spot - a deep OTM strike can legitimately go many minutes between real trades, so
        // "no tick recently" proves nothing on its own for an option. Re-sending the whole desired
        // set every recenter instead sidesteps that entirely: cheap and harmless for a token Dhan
        // already has right (StrategyTriggerHostedService's own live trading depends on this exact
        // set staying genuinely live), silently repairs one it doesn't - no threshold to get wrong
        // either way.
        try
        {
            await _feedClient.ResendSubscriptionsForAsync(desiredTokens, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "CDV: {Underlying} {Expiry} periodic re-subscribe of tracked strikes failed.", underlying, expiry);
        }

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
                await UnsubscribeAndForgetAsync(tokens, cancellationToken);

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
            await UnsubscribeAndForgetAsync(tokens, cancellationToken);

        _subscribedTokens[key] = new HashSet<uint>();
        _cdvHistorySeeded.Remove(key);
        state.Reset();
        _logger.LogInformation("CDV: {Underlying} {Expiry} - new trading day, resetting CDV state.", underlying, expiry);
    }

    /// <summary>Unsubscribes the given tokens from the shared feed and drops their SecurityId-&gt;
    /// state routing (_bySecurityId) together - a token left in one without the other is either a
    /// leak (still routed to a state but no longer actually subscribed) or a live tick with nowhere
    /// to go (subscribed but not routed), so the two must always change as one unit. Shared by every
    /// place that stops tracking a set of contracts: the routine ATM-window diff, dropping a whole
    /// stale expiry, and a day-rollover reset.</summary>
    private async Task UnsubscribeAndForgetAsync(IEnumerable<uint> tokens, CancellationToken cancellationToken)
    {
        await _feedClient.UnsubscribeAsync(tokens, cancellationToken);
        foreach (var token in tokens) _bySecurityId.TryRemove(token, out _);
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
        var today = IstClock.Today();
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

        // Counted so a batch that returns NOTHING can say so once, with Dhan's own reason, instead
        // of disappearing into per-strike Debug lines. "No option history for this underlying at
        // all" and "these particular strikes didn't trade" look identical from the dashboard and
        // from the logs, but the first is a broken exchange/entitlement/segment and the second is
        // ordinary - and only the aggregate can tell them apart.
        var withData = 0;
        var failed = 0;
        string? lastError = null;
        string? failedSegment = null;

        for (var i = 0; i < securityIds.Count; i++)
        {
            if (i > 0) await Task.Delay(BackfillCallDelay, cancellationToken);

            var securityId = securityIds[i];
            var dhanSegment = _optionChainMaster.FindBySecurityId(securityId)?.DhanSegment ?? "NSE_FNO";

            // Stamped BEFORE the call, so a request that throws or is cancelled still counts as an
            // attempt - otherwise exactly the strikes that fail hardest would be the ones retried
            // most often, which is backwards.
            state.MarkBackfillAttempted(securityId);

            IReadOnlyList<CandleWithVolume> bars;
            try
            {
                var (fetched, error) = await _historicalData.GetIntradayOptionCandlesAsync(securityId, dhanSegment, fromDay, today, 1, cancellationToken, interactive: false);
                bars = fetched;
                if (error is not null)
                {
                    failed++;
                    lastError = error;
                    failedSegment = dhanSegment;
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogDebug(ex, "CDV backfill: request threw for {Underlying} security {SecurityId}", underlying, securityId);
                failed++;
                lastError = ex.Message;
                failedSegment = dhanSegment;
                continue;
            }

            if (bars.Count == 0) continue;
            withData++;

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

        // One line, once per batch, and only when the whole batch came back with nothing - loud
        // enough to find a broken exchange/entitlement, quiet enough not to fire on the ordinary
        // case of some strikes not having traded.
        if (withData == 0 && securityIds.Count > 0)
        {
            _logger.LogWarning(
                "CDV backfill got NO option history for {Underlying} {Expiry} on segment {Segment}: {Failed} of {Total} request(s) failed. {Reason} " +
                "Backtests on this underlying will find no option premiums until this resolves.",
                underlying, expiry, failedSegment ?? "?", failed, securityIds.Count,
                lastError is null
                    ? "Dhan returned no candles rather than an error, so these contracts exist but have no intraday history in the requested window."
                    : $"Last error from Dhan: {lastError}.");
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

    private static DateOnly IstDate(DateTimeOffset time) => IstClock.IstDate(time);

    private void OnTick(SpotTick tick)
    {
        if (!_bySecurityId.TryGetValue(tick.SecurityId, out var state)) return;
        if (!state.IsTracked(tick.SecurityId)) return;

        var spot = _spotFeed.States.TryGetValue(state.Underlying, out var spotState) ? spotState.LastPrice : 0;
        state.ApplyTick(tick, spot);

        // Coalesced to one push per LiveBroadcastBatcher flush (the snapshot is cumulative state, so
        // the newest one loses nothing) and built at flush time rather than per tick. The SELECTED
        // expiry keeps its "cdvUpdate" event exactly as before; every other tracked expiry goes out
        // as "cdvExpiryUpdate" instead, which names its Expiry - so a page pinned to a non-default
        // expiry stays live too, and nothing listening to cdvUpdate can mix two chains together.
        //
        // Own "cdv:" groups rather than "u:" - only the Dashboard wants CDV, so OI Replay (which joins
        // u: for spot/futures) never receives it, and a non-default expiry's snapshot only reaches a
        // Dashboard actually pinned to that expiry.
        if (_selected.TryGetValue(state.Underlying, out var selected) && ReferenceEquals(selected, state))
            _batcher.SetLatest($"cdv:{state.Underlying}", "cdvUpdate", "selected", state.ToSnapshot);
        else if (state.Expiry is { } expiry)
        {
            var expiryKey = expiry.ToString("yyyy-MM-dd");
            _batcher.SetLatest($"cdv:{state.Underlying}:{expiryKey}", "cdvExpiryUpdate", expiryKey, state.ToSnapshot);
        }
    }

    /// <summary>Fires on every CdvUnderlyingState the moment its aggregate CE/PE bar closes - see
    /// CdvUnderlyingState.AggregateBarClosed. Pushes that bar's already-smoothed CDV value over
    /// SignalR so the dashboard's lookback table can append it instead of re-fetching
    /// GET .../lookback on every bar close (see the "cdvBarClosed" event). Only the currently
    /// SELECTED expiry is pushed - same rule OnTick's own cdvUpdate broadcast uses, for the same
    /// reason: the push names only its underlying, not its expiry, so a page pinned to a different
    /// expiry must never receive it.</summary>
    private void OnAggregateBarClosed(string underlying, CdvUnderlyingState state)
    {
        if (!_selected.TryGetValue(underlying, out var selected) || !ReferenceEquals(selected, state)) return;

        // This fires from inside a tick, on the Dhan receive thread every live consumer shares, and
        // the OBV series is recomputed from the full multi-day history - off-thread, so it can never
        // hold up the next tick. At most one recompute per underlying at a time: it reads the state
        // under the lock every tick needs, so a burst of closes must not queue up a pile of them.
        if (!_barClosedPushInFlight.TryAdd(underlying, 0)) return;
        _ = Task.Run(() =>
        {
            try { PushAggregateBarClosed(underlying, state); }
            finally { _barClosedPushInFlight.TryRemove(underlying, out _); }
        });
    }

    private readonly ConcurrentDictionary<string, byte> _barClosedPushInFlight = new(StringComparer.OrdinalIgnoreCase);

    private void PushAggregateBarClosed(string underlying, CdvUnderlyingState state)
    {
        var ce = state.GetSmoothedCdvSeries(true);
        var pe = state.GetSmoothedCdvSeries(false);
        if (ce.Count == 0 || pe.Count == 0) return;

        var obvCe = state.GetObvSeries(true);
        var obvPe = state.GetObvSeries(false);

        _ = BroadcastAggregateBarClosedAsync(new CdvBarClosedPush(
            underlying, ce[^1].Time, ce[^1].Obv, pe[^1].Obv,
            obvCe.Count > 0 ? obvCe[^1].Obv : null,
            obvPe.Count > 0 ? obvPe[^1].Obv : null));
    }

    private async Task BroadcastAggregateBarClosedAsync(CdvBarClosedPush push)
    {
        try
        {
            await _hub.Clients.Group($"u:{push.Underlying}").SendAsync("cdvBarClosed", push);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Failed to broadcast a CDV bar-closed push for {Underlying}.", push.Underlying);
        }
    }

    public override Task StopAsync(CancellationToken cancellationToken)
    {
        _tickSubscription?.Dispose();
        _tickSubscription = null;
        return base.StopAsync(cancellationToken);
    }
}

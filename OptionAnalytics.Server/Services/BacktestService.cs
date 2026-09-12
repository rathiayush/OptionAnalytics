using System.Collections.Concurrent;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// The "backtrack" page's engine. Two independent things:
///
///   1. Replay: reproduces ConfluenceAlertService's exact individual-leg-flip + three-way-
///      confluence logic offline over whatever spot/ATM CE/PE candle history is currently held in
///      memory (up to SpotFeedHostedService/CdvUnderlyingState's HistoryTradingDays), instead of
///      reacting to live bar closes.
///
///   2. RunStrategy: hands that same replay's Confluence signals (plus aggregated spot bars and a
///      way to fetch any strike's own premium history) to a pluggable IBacktestStrategy - see that
///      interface for how to add a new strategy. This class owns none of the trading logic itself
///      any more; it only does the shared, strategy-agnostic setup work every strategy would
///      otherwise have to repeat (timeframe aggregation, signal detection).
///
/// Both take a timeframeMinutes parameter - the underlying 1-minute bars are bucketed up front
/// (BacktestUtil.AggregateCandles, the server-side counterpart to the dashboard's own client-side
/// aggregateCandles) so a coarser timeframe genuinely recomputes EMA9/21 off fewer, smoother bars
/// rather than just changing how the existing signals are displayed.
///
/// Stateless and computed on demand per request - there's nothing to keep updated between
/// requests, since it only ever reads the two hosted services' already-live in-memory state.
///
/// Replay is faithful to ConfluenceAlertService's live behavior:
///   - a leg's direction is tracked per closed bar (EmaCrossoverDetector.ConfirmedDirectionSeries,
///     the whole-series counterpart to ConfirmedDirection - requiring the bar's close to have
///     actually finished beyond both EMAs, not just their relationship flipping, so a flat/choppy
///     stretch doesn't replay signals live alerts would never have sent), and an individual signal
///     fires the instant a leg's direction changes from what it was on its own previous bar.
///   - a Confluence signal fires the instant all three legs align (spot+ATM CE both Bullish and ATM
///     PE Bearish, or the bearish mirror) within ConfluenceWindow of each other, staying quiet on
///     every later bar where the same alignment still holds, and re-arming the moment any leg
///     changes (mirrors ConfluenceAlertState's ConfluenceAlerted flag).
///
/// The three legs' bars are walked in one merged, time-ascending pass (rather than replaying each
/// leg independently) so a Confluence check only ever runs after all bars closing at that instant
/// have already updated their leg - the same ordering EvaluateConfluence relies on live.
/// </summary>
public sealed class BacktestService
{
    /// <summary>How many DISTINCT strikes one RunStrategyAsync call will fetch from Dhan on demand
    /// (see FillMissingStrikesAsync), across ALL rounds combined. A backtest reaching back
    /// HistoryTradingDays over a session where spot trended hard can legitimately reference dozens
    /// of strikes that never entered the ATM+-8 window, and every one of them is a separate Dhan
    /// call - this is now a sanity backstop rather than the thing that actually bounds one page
    /// load's length (see MaxOnDemandDuration for that): high enough that a normal backtest, however
    /// many strikes it touches, clears every "No Data" row in the SAME click that revealed them,
    /// instead of needing the user to press Run again for each round the old fixed round-count cap
    /// would have cut off early.</summary>
    private const int MaxOnDemandStrikesPerRun = 600;

    /// <summary>Wall-clock ceiling on one RunStrategyAsync call's fill-then-re-run loop. Filling a
    /// strike can change which trades happen (a trade that used to be "No Data" now occupies the
    /// simulator's one-position-at-a-time window, so LATER signals resolve differently and can
    /// reference strikes the first pass never asked about) - which is why one pass was never enough
    /// to clear the table, and why a fixed round COUNT was the wrong backstop: however many rounds
    /// convergence actually takes, the user asked for it done now, in this click, not spread across
    /// as many "Re-run" clicks as there happen to be rounds. Bounding by time instead means the loop
    /// keeps going, round after round, for as long as it is still making progress and there is time
    /// left - it only gives up because the page load itself has to end somewhere.</summary>
    private static readonly TimeSpan MaxOnDemandDuration = TimeSpan.FromSeconds(25);

    /// <summary>Spacing between on-demand fetches, same as CdvHostedService's own backfill uses.
    /// With a 60-strike budget these are no longer a handful of calls, and Dhan's data API is rate
    /// limited - pacing them costs a few seconds and avoids being throttled into empty results,
    /// which would look exactly like the "No Data" this is trying to remove.</summary>
    private static readonly TimeSpan OnDemandCallDelay = TimeSpan.FromMilliseconds(200);

    /// <summary>How long the BACKGROUND continuation gets after a request has already returned (see
    /// ContinueFillingInBackground). Far longer than MaxOnDemandDuration because nobody is waiting
    /// on it - the point is that the strikes this click could not reach are cached before the next
    /// one asks, instead of the user having to press Run repeatedly to walk through them a
    /// deadline's worth at a time.</summary>
    private static readonly TimeSpan BackgroundFillDuration = TimeSpan.FromMinutes(3);

    private readonly SpotFeedHostedService _spotFeed;
    private readonly CdvHostedService _cdv;
    private readonly IReadOnlyDictionary<string, IBacktestStrategy> _strategies;
    private readonly ILogger<BacktestService> _logger;

    /// <summary>One background fill at a time per underlying/expiry. Without this, every Run click
    /// while a fill is already running would start another one over the same strikes - multiplying
    /// calls into a rate-limited Dhan endpoint to do work that is already in progress.</summary>
    private readonly ConcurrentDictionary<(string Underlying, DateOnly? Expiry), byte> _backgroundFills = new();

    public BacktestService(SpotFeedHostedService spotFeed, CdvHostedService cdv, IEnumerable<IBacktestStrategy> strategies, ILogger<BacktestService> logger)
    {
        _spotFeed = spotFeed;
        _cdv = cdv;
        _strategies = strategies.ToDictionary(s => s.Key);
        _logger = logger;
    }

    /// <summary>Every signal that would have fired across the underlying's currently-held history
    /// at the given timeframe, most recent first. Empty if the underlying isn't recognized or has
    /// no history backfilled yet.</summary>
    public IReadOnlyList<BacktestSignal> Replay(string underlying, int timeframeMinutes = 1, DateOnly? expiry = null)
    {
        var cdvState = _cdv.StateFor(underlying, expiry);
        if (!_spotFeed.States.TryGetValue(underlying, out var spotState) || cdvState is null)
            return Array.Empty<BacktestSignal>();

        return ReplayCore(underlying, spotState, cdvState, timeframeMinutes).Signals;
    }

    /// <summary>Every registered IBacktestStrategy's metadata (key/name/description/parameters) -
    /// what the Backtrack page needs to populate its strategy dropdown and render each one's own
    /// parameter controls generically. Ordered by Name for a stable, readable dropdown.</summary>
    public IReadOnlyList<BacktestStrategyInfo> GetStrategies() =>
        _strategies.Values
            .Select(s => new BacktestStrategyInfo(s.Key, s.Name, s.Description, s.Parameters))
            .OrderBy(s => s.Name)
            .ToList();

    /// <summary>Runs one registered strategy (by IBacktestStrategy.Key) over the underlying's
    /// current in-memory history at the given timeframe. Any parameter the caller didn't supply is
    /// filled from that strategy's own declared default, so a strategy implementation can always
    /// assume <paramref name="parameters"/> is complete. Empty if the underlying or strategy key
    /// isn't recognized, or there's no history backfilled yet.</summary>
    public IReadOnlyList<BacktestTrade> RunStrategy(string underlying, string strategyKey, int timeframeMinutes, IReadOnlyDictionary<string, decimal> parameters, DateOnly? expiry = null)
    {
        var prepared = Prepare(underlying, strategyKey, timeframeMinutes, parameters, expiry);
        return prepared is not { } p ? Array.Empty<BacktestTrade>() : p.Strategy.Simulate(p.Context, p.Parameters);
    }

    /// <summary>RunStrategy, plus a second pass that fills in the strikes the first pass found no
    /// history for. A strike only has in-memory candles if it was inside the ATM+-8 window at some
    /// point today (see CdvUnderlyingState.GetStrikeClosedCandles) - a signal on any other strike
    /// otherwise resolves to BacktestTrade.NoData purely because nothing was ever subscribed to it,
    /// which reads as a broken row rather than the "this strike was never tracked" it actually is.
    ///
    /// So: run once, note which strikes came back empty, fetch exactly those from Dhan's intraday
    /// history (CdvHostedService.GetStrikeCandlesAsync - the same on-demand path the dashboard's
    /// strike picker already uses for untracked strikes, with the same short-lived cache behind it),
    /// then run again with them available. The strategy code itself is untouched and still fully
    /// synchronous; it simply sees a richer GetOptionBars on the second pass.
    ///
    /// Two passes rather than pre-fetching because which strikes a strategy asks for is its own
    /// business (it depends on its signals and its otmSteps), and only running it reveals them.
    /// Simulation is pure in-memory arithmetic, so the repeat costs far less than the fetches do.
    ///
    /// Deliberately NOT used by StrategyTriggerHostedService, which stays on the synchronous
    /// in-memory RunStrategy: this changes which signals resolve into trades, and a live trigger
    /// placing REAL orders should not start firing on strikes it never had price history for as a
    /// side effect of a Backtrack-page improvement.</summary>
    public async Task<IReadOnlyList<BacktestTrade>> RunStrategyAsync(
        string underlying, string strategyKey, int timeframeMinutes,
        IReadOnlyDictionary<string, decimal> parameters, CancellationToken cancellationToken, DateOnly? expiry = null)
    {
        var prepared = Prepare(underlying, strategyKey, timeframeMinutes, parameters, expiry);
        if (prepared is not { } p) return Array.Empty<BacktestTrade>();

        var trades = p.Strategy.Simulate(p.Context, p.Parameters);

        // Keep filling and re-running until the strategy stops asking for strikes it has no history
        // for - one round only clears the misses that round happened to reveal, and filling a strike
        // can reveal MORE of them (see the doc comments on MaxOnDemandDuration/MaxOnDemandStrikesPerRun),
        // so this can take several rounds to fully converge. Bounded by wall-clock time rather than a
        // round count, so the loop keeps going for as long as it is actually making progress within
        // one click instead of stopping after an arbitrary number of rounds and leaving the rest for
        // the user to trigger by clicking Run again.
        var budget = MaxOnDemandStrikesPerRun;
        var deadline = DateTime.UtcNow + MaxOnDemandDuration;
        while (budget > 0 && DateTime.UtcNow < deadline)
        {
            var attempted = await FillMissingStrikesAsync(underlying, p.OnDemand, budget, expiry, cancellationToken);
            if (attempted == 0) break; // nothing was missing - the table is as full as it can get

            budget -= attempted;

            // Re-run even when every fetch came back empty: those strikes are now ANSWERED (an
            // empty answer is still an answer - see OnDemandStrikes.Add), so this pass is what
            // stops them being asked for again, and it is also what surfaces the next round's
            // misses.
            trades = p.Strategy.Simulate(p.Context, p.Parameters);
        }

        // Whatever the deadline cut off is still on the miss list. Warming those into the on-demand
        // cache now - after the response goes out, so it costs this click nothing - is what turns
        // "press Run again for each deadline's worth of strikes" into "it fills itself". A backtest
        // over 45 trading days of a trending underlying can reference far more distinct strikes than
        // 25 seconds of paced calls covers, so without this the user is the retry loop.
        ContinueFillingInBackground(underlying, p.OnDemand, expiry);

        return trades;
    }

    /// <summary>Fetches the strikes the foreground loop ran out of time for, after the response has
    /// already been sent, so they are cached by the time anything asks again.
    ///
    /// Deliberately fire-and-forget with its OWN cancellation token: the token passed to
    /// RunStrategyAsync is the request's, which is cancelled the moment the response completes - so
    /// continuing on it would cancel this instantly, every time. Bounded by BackgroundFillDuration
    /// and by one-at-a-time-per-underlying, and it only ever populates a cache - nothing waits on
    /// its result, and a failure leaves exactly the "No Data" that was already there.</summary>
    private void ContinueFillingInBackground(string underlying, OnDemandStrikes onDemand, DateOnly? expiry)
    {
        var remaining = onDemand.DrainMisses();
        if (remaining.Count == 0) return;

        var key = (underlying, expiry);
        if (!_backgroundFills.TryAdd(key, 0)) return; // one already working through these strikes

        _ = Task.Run(async () =>
        {
            using var cts = new CancellationTokenSource(BackgroundFillDuration);
            var filled = 0;

            try
            {
                foreach (var (strike, isCall) in remaining)
                {
                    if (cts.IsCancellationRequested) break;
                    if (filled > 0) await Task.Delay(OnDemandCallDelay, cts.Token);

                    await _cdv.GetStrikeCandlesAsync(underlying, strike, isCall, cts.Token, expiry);
                    filled++;
                }

                _logger.LogInformation("Backtest background fill: cached {Filled} of {Total} remaining {Underlying} strike(s) for the next run.",
                    filled, remaining.Count, underlying);
            }
            catch (OperationCanceledException)
            {
                _logger.LogDebug("Backtest background fill for {Underlying} stopped after {Filled} of {Total} strike(s).", underlying, filled, remaining.Count);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Backtest background fill for {Underlying} failed after {Filled} of {Total} strike(s).", underlying, filled, remaining.Count);
            }
            finally
            {
                _backgroundFills.TryRemove(key, out _);
            }
        });
    }

    /// <summary>Fetches every strike the just-completed pass found nothing for, up to
    /// <paramref name="budget"/> of them. Returns HOW MANY it attempted - zero means nothing was
    /// missing, which is the signal to stop rounds; any other number means the strategy should be
    /// re-run, whether or not the fetches found candles.</summary>
    private async Task<int> FillMissingStrikesAsync(string underlying, OnDemandStrikes onDemand, int budget, DateOnly? expiry, CancellationToken cancellationToken)
    {
        var missing = onDemand.DrainMisses();
        if (missing.Count == 0) return 0;

        var attempted = 0;
        foreach (var (strike, isCall) in missing.Take(budget))
        {
            if (attempted > 0) await Task.Delay(OnDemandCallDelay, cancellationToken);

            var bars = await _cdv.GetStrikeCandlesAsync(underlying, strike, isCall, cancellationToken, expiry);
            var closed = DropFormingBar(bars);

            // Recorded even when empty (an unlisted strike, or Dhan simply having nothing) so the
            // next pass treats it as answered rather than recording the same miss all over again.
            onDemand.Add(strike, isCall, closed);
            attempted++;
        }

        // Anything the budget could not cover goes back on the miss list, so it is not silently
        // forgotten: the next pass records it again and the NEXT request picks it up, by which time
        // this run's fetches are all cached.
        foreach (var (strike, isCall) in missing.Skip(budget)) onDemand.RecordMiss(strike, isCall);

        return attempted;
    }

    /// <summary>CdvUnderlyingState.GetAtmClosedVolumeBars' own (Candle, long) tuple shape, converted
    /// to the CandleWithVolume record BacktestUtil.AggregateCandlesWithVolume actually takes.</summary>
    private static List<CandleWithVolume> ToCandlesWithVolume(IReadOnlyList<(Candle Bar, long Volume)> bars) =>
        bars.Select(b => new CandleWithVolume(b.Bar.Time, b.Bar.Open, b.Bar.High, b.Bar.Low, b.Bar.Close, b.Volume)).ToList();

    /// <summary>Whether a strike's own tracked (live-fed) candle series can be trusted outright, or
    /// needs a real Dhan fetch to see if there is more. A strike still INSIDE the ATM+-16 window
    /// right now has a complete series - nothing more to ask Dhan for. But once a strike falls OUT
    /// of that window it stops receiving ticks altogether (CdvStrikeRuntime's own doc comment on
    /// RunningCdv) and is never re-backfilled even if it later re-enters - EnsureTracked is a no-op
    /// on an already-tracked strike, by design - so its own ticks-derived candles simply stop
    /// advancing on whatever day/time it dropped out and never resume. From the caller's side,
    /// "has some candles" and "has every candle a signal might need" then look identical: a strike
    /// that stopped tracking a month before a large spot move would otherwise keep returning that
    /// same frozen, incomplete series to every later signal as if it were the whole story, reading
    /// as "No Data" forever for anything after the drop-out point - no matter how large
    /// MaxOnDemandStrikesPerRun/MaxOnDemandDuration get, because a miss is never even recorded for
    /// it. Comparing the tracked series' own last bar's day against <paramref name="latestHeldBars"/>
    /// own last bar's day (this backtest's SpotBars - the latest trading day this run holds ANY
    /// data through) catches exactly that: a series that stops short of "as recent as this app's
    /// data gets" is presumed incomplete and gets a real Dhan fetch instead of being trusted
    /// outright.</summary>
    internal static bool IsTrackedSeriesComplete(IReadOnlyList<Candle> tracked, IReadOnlyList<Candle> latestHeldBars) =>
        tracked.Count > 0 && latestHeldBars.Count > 0
        && BacktestUtil.IstDate(tracked[^1].Time) >= BacktestUtil.IstDate(latestHeldBars[^1].Time);

    /// <summary>Drops a still-forming final bar. GetStrikeCandlesAsync deliberately includes the
    /// in-progress minute (a chart wants it), but every backtest in this app runs strictly on CLOSED
    /// bars - letting a partial bar through here would let a strategy "fill" at a price the minute
    /// had not finished printing, which is exactly the staleness the close-confirmation rule exists
    /// to prevent.</summary>
    private static IReadOnlyList<Candle> DropFormingBar(IReadOnlyList<Candle> bars)
    {
        if (bars.Count == 0) return bars;

        var now = DateTimeOffset.UtcNow;
        var currentMinute = new DateTimeOffset(now.Year, now.Month, now.Day, now.Hour, now.Minute, 0, now.Offset);
        return bars[^1].Time >= currentMinute ? bars.Take(bars.Count - 1).ToList() : bars;
    }

    /// <summary>The signals the given strategy itself reasons about (see
    /// IBacktestStrategy.EntrySignals) - so the Backtrack page's signal table always describes the
    /// strategy currently selected rather than one fixed rule. Falls back to the plain confluence
    /// replay when the strategy key isn't recognized, which is what the page shows before a
    /// strategy has loaded.</summary>
    public IReadOnlyList<BacktestSignal> ReplayForStrategy(string underlying, string strategyKey, int timeframeMinutes, IReadOnlyDictionary<string, decimal> parameters, DateOnly? expiry = null)
    {
        var prepared = Prepare(underlying, strategyKey, timeframeMinutes, parameters, expiry);
        return prepared is not { } p ? Replay(underlying, timeframeMinutes, expiry) : p.Strategy.EntrySignals(p.Context, p.Parameters);
    }

    /// <summary>Resolves the strategy, does the shared replay/aggregation work once and merges the
    /// caller's parameters over that strategy's declared defaults - everything both RunStrategy and
    /// ReplayForStrategy need, so neither can drift from the other.</summary>
    private (IBacktestStrategy Strategy, BacktestStrategyContext Context, IReadOnlyDictionary<string, decimal> Parameters, OnDemandStrikes OnDemand)? Prepare(
        string underlying, string strategyKey, int timeframeMinutes, IReadOnlyDictionary<string, decimal> parameters, DateOnly? expiry)
    {
        if (!_strategies.TryGetValue(strategyKey, out var strategy)) return null;

        // A named expiry reads THAT expiry's own tracked state; null reads the selected one, which
        // is what every caller did before expiries could be held several at a time. An expiry that
        // is not tracked returns nothing rather than quietly answering from a different chain.
        var cdvState = _cdv.StateFor(underlying, expiry);
        if (!_spotFeed.States.TryGetValue(underlying, out var spotState) || cdvState is null)
            return null;

        var timeframe = Math.Max(1, timeframeMinutes);
        var onDemand = new OnDemandStrikes();
        var (allSignals, spotBars, confluenceAscending, ceBars, peBars) = ReplayCore(underlying, spotState, cdvState, timeframe);

        var context = new BacktestStrategyContext
        {
            Underlying = underlying,
            TimeframeMinutes = timeframe,
            Step = spotState.Step,
            SpotBars = spotBars,
            SpotBarsOneMinute = spotState.GetClosedCandles(),
            ConfluenceSignalsAscending = confluenceAscending,
            AllSignals = allSignals,
            AtmCeBars = ceBars,
            AtmPeBars = peBars,
            AtmCeVolumeBars = BacktestUtil.AggregateCandlesWithVolume(ToCandlesWithVolume(cdvState.GetAtmClosedVolumeBars(true)), timeframe),
            AtmPeVolumeBars = BacktestUtil.AggregateCandlesWithVolume(ToCandlesWithVolume(cdvState.GetAtmClosedVolumeBars(false)), timeframe),
            AtmStrike = cdvState.AtmStrike,
            ObvCeSeries = BacktestUtil.AggregateLine(cdvState.GetObvSeries(true), timeframe),
            ObvPeSeries = BacktestUtil.AggregateLine(cdvState.GetObvSeries(false), timeframe),
            CdvCeSeries = BacktestUtil.AggregateLine(cdvState.GetSmoothedCdvSeries(true), timeframe),
            CdvPeSeries = BacktestUtil.AggregateLine(cdvState.GetSmoothedCdvSeries(false), timeframe),
            // A previous on-demand fetch this run always wins (it is the authoritative, complete
            // series - see the closure body). Otherwise a tracked strike answers from memory only
            // if that memory is actually complete through this backtest's latest held day; anything
            // short of that records the miss so RunStrategyAsync can go and get it - see that
            // method. The synchronous callers (RunStrategy, and through it StrategyTriggerHostedService)
            // simply never drain those misses, so for them this behaves exactly as it always did:
            // in-memory (however complete that happens to be) or empty.
            //
            // includeTrailingPartial: true - see AggregateCandles' own doc comment. OptionTradeSimulator
            // is the only consumer of GetOptionBars, and only ever reads an entry bar's Open, so the
            // still-forming trailing bucket is safe here specifically: its Open is already final the
            // moment its first native minute closes, letting a signal's entry resolve up to
            // (timeframe - 1) minutes sooner than waiting for the whole bucket, with the EXACT same
            // number either way. This is what makes a live-trading trigger's entry match what
            // Backtrack itself would show for the same signal, without the extra wait.
            GetOptionBars = (strike, isCall) => OptionBarsAt(strike, isCall, timeframe),
            // Same series, same on-demand behaviour, just un-bucketed - see
            // BacktestStrategyContext.GetOptionBarsOneMinute.
            GetOptionBarsOneMinute = (strike, isCall) => OptionBarsAt(strike, isCall, 1),
        };

        IReadOnlyList<Candle> OptionBarsAt(decimal strike, bool isCall, int bucketMinutes)
        {
            if (onDemand.TryGet(strike, isCall) is { } fetched)
                return BacktestUtil.AggregateCandles(fetched, bucketMinutes, includeTrailingPartial: true);

            var tracked = cdvState.GetStrikeClosedCandles(strike, isCall);
            if (IsTrackedSeriesComplete(tracked, spotBars))
                return BacktestUtil.AggregateCandles(tracked, bucketMinutes, includeTrailingPartial: true);

            onDemand.RecordMiss(strike, isCall);
            // Still returned as an interim value while the fetch is pending (this round) or if
            // it never lands (budget/deadline exhausted) - a possibly-incomplete series is
            // strictly better than none, and RunStrategyAsync's re-run after a successful fetch
            // replaces it with the authoritative one via the onDemand.TryGet check above.
            return tracked.Count > 0 ? BacktestUtil.AggregateCandles(tracked, bucketMinutes, includeTrailingPartial: true) : Array.Empty<Candle>();
        }

        var mergedParameters = strategy.Parameters.ToDictionary(p => p.Key, p => parameters.TryGetValue(p.Key, out var v) ? v : p.Default);

        return (strategy, context, mergedParameters, onDemand);
    }

    /// <summary>Per-run scratch space for strikes that had no in-memory history: which ones a pass
    /// asked for and found nothing for, and what a subsequent fetch turned up for them. Lives for
    /// one RunStrategyAsync call only - the durable caching sits behind
    /// CdvHostedService.GetStrikeCandlesAsync.</summary>
    private sealed class OnDemandStrikes
    {
        private readonly Dictionary<(decimal Strike, bool IsCall), IReadOnlyList<Candle>> _fetched = new();
        private readonly HashSet<(decimal Strike, bool IsCall)> _misses = new();

        public IReadOnlyList<Candle>? TryGet(decimal strike, bool isCall) =>
            _fetched.TryGetValue((strike, isCall), out var bars) ? bars : null;

        public void RecordMiss(decimal strike, bool isCall) => _misses.Add((strike, isCall));

        public void Add(decimal strike, bool isCall, IReadOnlyList<Candle> bars)
        {
            _fetched[(strike, isCall)] = bars;
            _misses.Remove((strike, isCall));
        }

        public IReadOnlyList<(decimal Strike, bool IsCall)> DrainMisses()
        {
            var drained = _misses.ToList();
            _misses.Clear();
            return drained;
        }
    }

    /// <summary>Shared by Replay and RunStrategy - aggregates all three legs to the requested
    /// timeframe once and replays the same leg-flip/confluence state machine, returning both the
    /// full signal list and (for strategies' strike-selection math) the aggregated spot bars, the
    /// Confluence-only subset in time-ascending order, and the same aggregated ATM CE/PE bars (so a
    /// strategy that wants its own ATM CE/PE crossover check doesn't need a second CDV-aware code
    /// path - see BacktestStrategyContext.AtmCeBars/AtmPeBars).</summary>
    private static (IReadOnlyList<BacktestSignal> Signals, List<Candle> SpotBars, List<BacktestSignal> ConfluenceAscending, List<Candle> CeBars, List<Candle> PeBars) ReplayCore(
        string underlying, SpotUnderlyingState spotState, CdvUnderlyingState cdvState, int timeframeMinutes)
    {
        var timeframe = Math.Max(1, timeframeMinutes);
        var confluenceWindow = TimeSpan.FromMinutes(Math.Max(5, timeframe));

        var spotBars = BacktestUtil.AggregateCandles(spotState.GetClosedCandles(), timeframe);
        var ceBars = BacktestUtil.AggregateCandles(cdvState.GetAtmClosedCandles(true), timeframe);
        var peBars = BacktestUtil.AggregateCandles(cdvState.GetAtmClosedCandles(false), timeframe);

        // ConfirmedDirectionSeries, not the plain DirectionSeries - see its own doc comment. This
        // replay exists to reproduce EXACTLY what EmaCrossoverAlertService/ConfluenceAlertService
        // would alert on live (both use ConfirmedDirection), so Backtrack and every Strategy
        // Trigger built off a Confluence/Entry signal need the same close-confirmation rule, not
        // the raw EMA9-vs-EMA21 relationship - otherwise a backtest could show signals live alerts
        // would never have sent.
        var spotSeries = EmaCrossoverDetector.ConfirmedDirectionSeries(spotBars);
        var ceSeries = EmaCrossoverDetector.ConfirmedDirectionSeries(ceBars);
        var peSeries = EmaCrossoverDetector.ConfirmedDirectionSeries(peBars);

        var spotByTime = ToLookup(spotSeries);
        var ceByTime = ToLookup(ceSeries);
        var peByTime = ToLookup(peSeries);

        var timeline = spotByTime.Keys.Concat(ceByTime.Keys).Concat(peByTime.Keys).Distinct().OrderBy(t => t).ToList();

        (string Direction, DateTimeOffset BarTime)? spot = null, ce = null, pe = null;
        var confluenceAlerted = false;
        var signals = new List<BacktestSignal>();
        var confluenceAscending = new List<BacktestSignal>();

        foreach (var t in timeline)
        {
            var changed = false;
            changed |= TryUpdateLeg(spotByTime, t, ref spot, underlying, "Spot", "Spot EMA9/21 turned {0}", signals);
            changed |= TryUpdateLeg(ceByTime, t, ref ce, underlying, "AtmCe", "ATM CE EMA9/21 turned {0}", signals);
            changed |= TryUpdateLeg(peByTime, t, ref pe, underlying, "AtmPe", "ATM PE EMA9/21 turned {0}", signals);

            if (changed) confluenceAlerted = false; // a leg just moved - a fresh alignment can alert again

            if (spot is not { } s || ce is not { } c || pe is not { } p) continue;

            var withinWindow = (s.BarTime - c.BarTime).Duration() <= confluenceWindow && (s.BarTime - p.BarTime).Duration() <= confluenceWindow;
            var isBullish = withinWindow && s.Direction == "Bullish" && c.Direction == "Bullish" && p.Direction == "Bearish";
            var isBearish = withinWindow && s.Direction == "Bearish" && p.Direction == "Bullish" && c.Direction == "Bearish";

            if (!isBullish && !isBearish) { confluenceAlerted = false; continue; }
            if (confluenceAlerted) continue;

            confluenceAlerted = true;
            var direction = isBullish ? "Bullish" : "Bearish";
            var summary = direction == "Bullish"
                ? "Spot breakup + ATM CE breakup + ATM PE breakdown"
                : "Spot breakdown + ATM PE breakup + ATM CE breakdown";
            var confluenceSignal = new BacktestSignal(underlying, s.BarTime, "Confluence", direction, summary);
            signals.Add(confluenceSignal);
            confluenceAscending.Add(confluenceSignal);
        }

        return (signals.OrderByDescending(s => s.TimeUtc).ToList(), spotBars, confluenceAscending, ceBars, peBars);
    }

    private static Dictionary<DateTimeOffset, string?> ToLookup(IReadOnlyList<(DateTimeOffset Time, string? Direction)> series)
    {
        // A trimmed multi-day range call can occasionally hand back the same minute twice (see
        // SpotFeedHostedService's own duplicate-minute handling) - last one wins, same tolerance.
        var lookup = new Dictionary<DateTimeOffset, string?>();
        foreach (var (time, direction) in series) lookup[time] = direction;
        return lookup;
    }

    /// <summary>Updates one leg's tracked (direction, barTime) if it has a bar at <paramref
    /// name="t"/> with a known direction, recording an individual signal when that direction
    /// differs from the leg's own previous bar. Returns whether the leg actually changed.</summary>
    private static bool TryUpdateLeg(
        Dictionary<DateTimeOffset, string?> byTime, DateTimeOffset t,
        ref (string Direction, DateTimeOffset BarTime)? leg,
        string underlying, string kind, string summaryFormat, List<BacktestSignal> signals)
    {
        if (!byTime.TryGetValue(t, out var direction) || direction is null) return false;

        var changed = leg is not { } prev || prev.Direction != direction;
        if (changed) signals.Add(new BacktestSignal(underlying, t, kind, direction, string.Format(summaryFormat, direction)));
        leg = (direction, t);
        return changed;
    }
}

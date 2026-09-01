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
///   - a leg's direction is tracked per closed bar (EmaCrossoverDetector.DirectionSeries, the
///     whole-series counterpart to CurrentDirection), and an individual signal fires the instant a
///     leg's direction changes from what it was on its own previous bar.
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
    private readonly SpotFeedHostedService _spotFeed;
    private readonly CdvHostedService _cdv;
    private readonly IReadOnlyDictionary<string, IBacktestStrategy> _strategies;

    public BacktestService(SpotFeedHostedService spotFeed, CdvHostedService cdv, IEnumerable<IBacktestStrategy> strategies)
    {
        _spotFeed = spotFeed;
        _cdv = cdv;
        _strategies = strategies.ToDictionary(s => s.Key);
    }

    /// <summary>Every signal that would have fired across the underlying's currently-held history
    /// at the given timeframe, most recent first. Empty if the underlying isn't recognized or has
    /// no history backfilled yet.</summary>
    public IReadOnlyList<BacktestSignal> Replay(string underlying, int timeframeMinutes = 1)
    {
        if (!_spotFeed.States.TryGetValue(underlying, out var spotState) || !_cdv.States.TryGetValue(underlying, out var cdvState))
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
    public IReadOnlyList<BacktestTrade> RunStrategy(string underlying, string strategyKey, int timeframeMinutes, IReadOnlyDictionary<string, decimal> parameters)
    {
        if (!_strategies.TryGetValue(strategyKey, out var strategy)) return Array.Empty<BacktestTrade>();
        if (!_spotFeed.States.TryGetValue(underlying, out var spotState) || !_cdv.States.TryGetValue(underlying, out var cdvState))
            return Array.Empty<BacktestTrade>();

        var timeframe = Math.Max(1, timeframeMinutes);
        var (_, spotBars, confluenceAscending) = ReplayCore(underlying, spotState, cdvState, timeframe);

        var context = new BacktestStrategyContext
        {
            Underlying = underlying,
            TimeframeMinutes = timeframe,
            Step = spotState.Step,
            SpotBars = spotBars,
            ConfluenceSignalsAscending = confluenceAscending,
            GetOptionBars = (strike, isCall) => BacktestUtil.AggregateCandles(cdvState.GetStrikeClosedCandles(strike, isCall), timeframe),
        };

        var mergedParameters = strategy.Parameters.ToDictionary(p => p.Key, p => parameters.TryGetValue(p.Key, out var v) ? v : p.Default);

        return strategy.Simulate(context, mergedParameters);
    }

    /// <summary>Shared by Replay and RunStrategy - aggregates all three legs to the requested
    /// timeframe once and replays the same leg-flip/confluence state machine, returning both the
    /// full signal list and (for strategies' strike-selection math) the aggregated spot bars and
    /// the Confluence-only subset in time-ascending order.</summary>
    private static (IReadOnlyList<BacktestSignal> Signals, List<Candle> SpotBars, List<BacktestSignal> ConfluenceAscending) ReplayCore(
        string underlying, SpotUnderlyingState spotState, CdvUnderlyingState cdvState, int timeframeMinutes)
    {
        var timeframe = Math.Max(1, timeframeMinutes);
        var confluenceWindow = TimeSpan.FromMinutes(Math.Max(5, timeframe));

        var spotBars = BacktestUtil.AggregateCandles(spotState.GetClosedCandles(), timeframe);
        var ceBars = BacktestUtil.AggregateCandles(cdvState.GetAtmClosedCandles(true), timeframe);
        var peBars = BacktestUtil.AggregateCandles(cdvState.GetAtmClosedCandles(false), timeframe);

        var spotSeries = EmaCrossoverDetector.DirectionSeries(spotBars);
        var ceSeries = EmaCrossoverDetector.DirectionSeries(ceBars);
        var peSeries = EmaCrossoverDetector.DirectionSeries(peBars);

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

        return (signals.OrderByDescending(s => s.TimeUtc).ToList(), spotBars, confluenceAscending);
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

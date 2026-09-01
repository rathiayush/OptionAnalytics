using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// The "backtrack" page's engine: replays ConfluenceAlertService's exact individual-leg-flip +
/// three-way-confluence logic offline over whatever spot/ATM CE/PE candle history is currently
/// held in memory (up to SpotFeedHostedService/CdvUnderlyingState's HistoryTradingDays), instead of
/// reacting to live bar closes, and can go one step further and simulate a simple OTM-option trade
/// off each Confluence signal (see SimulateTrades). Stateless and computed on demand per request -
/// there's nothing to keep updated between requests, since it only ever reads the two hosted
/// services' already-live in-memory state.
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
///
/// Both Replay and SimulateTrades take a timeframeMinutes parameter - the underlying 1-minute bars
/// are bucketed up front (AggregateCandles, the server-side counterpart to the dashboard's own
/// client-side aggregateCandles) so a coarser timeframe genuinely recomputes EMA9/21 off fewer,
/// smoother bars rather than just changing how the existing signals are displayed.
/// </summary>
public sealed class BacktestService
{
    private readonly SpotFeedHostedService _spotFeed;
    private readonly CdvHostedService _cdv;

    public BacktestService(SpotFeedHostedService spotFeed, CdvHostedService cdv)
    {
        _spotFeed = spotFeed;
        _cdv = cdv;
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

    /// <summary>Simulates one long-only option trade per Confluence signal: buy the CE (Bullish) or
    /// PE (Bearish) that was <paramref name="otmSteps"/> strikes OTM from ATM at the moment of the
    /// signal - not whatever is ATM right now, so an old signal is judged against the strike it
    /// actually pointed at - entered at that contract's own NEXT bar's open (the signal bar's own
    /// close is never tradeable in real time, so entering on it would be look-ahead bias), then
    /// walked forward bar by bar against a percentage stop-loss/take-profit off the entry premium
    /// until one hits or the trading day ends (index option intraday strategies don't carry
    /// overnight - held past a day boundary they lose most of their remaining time value to theta
    /// decay by next morning, so "still open at day close" exits at that last bar rather than
    /// riding into the next day). At most one trade is open at a time - a signal that arrives while
    /// an earlier trade is still open is skipped, same as a trader who can't take a second position
    /// until the first is closed.
    ///
    /// A signal whose target strike was never tracked (fell outside the ATM+-8 window for this
    /// underlying's whole in-memory history - only possible with a large otmSteps or a very wide
    /// intraday move) produces a BacktestTrade.NoData entry instead of being silently dropped, so
    /// the page can show it was skipped and why.</summary>
    public IReadOnlyList<BacktestTrade> SimulateTrades(string underlying, int timeframeMinutes, int otmSteps, decimal slPercent, decimal tpPercent)
    {
        if (!_spotFeed.States.TryGetValue(underlying, out var spotState) || !_cdv.States.TryGetValue(underlying, out var cdvState))
            return Array.Empty<BacktestTrade>();

        var (_, spotBars, confluenceSignals) = ReplayCore(underlying, spotState, cdvState, timeframeMinutes);
        if (confluenceSignals.Count == 0) return Array.Empty<BacktestTrade>();

        var step = spotState.Step;
        var spotByTime = spotBars.ToDictionary(b => b.Time, b => b);
        var strikeCandleCache = new Dictionary<(decimal Strike, bool IsCall), List<Candle>>();

        var trades = new List<BacktestTrade>();
        DateTimeOffset? busyUntil = null;

        foreach (var signal in confluenceSignals)
        {
            if (busyUntil is { } bu && signal.TimeUtc <= bu) continue; // still in an earlier trade

            var isCall = signal.Direction == "Bullish";
            var optionType = isCall ? "CE" : "PE";

            if (!spotByTime.TryGetValue(signal.TimeUtc, out var signalSpotBar))
            {
                trades.Add(BacktestTrade.NoData(underlying, signal.TimeUtc, signal.Direction, optionType, 0));
                continue;
            }

            var atmAtSignal = step > 0 ? Math.Round(signalSpotBar.Close / step) * step : signalSpotBar.Close;
            var strike = isCall ? atmAtSignal + otmSteps * step : atmAtSignal - otmSteps * step;

            if (!strikeCandleCache.TryGetValue((strike, isCall), out var optionBars))
            {
                optionBars = AggregateCandles(cdvState.GetStrikeClosedCandles(strike, isCall), timeframeMinutes);
                strikeCandleCache[(strike, isCall)] = optionBars;
            }

            var entryIndex = optionBars.FindIndex(b => b.Time > signal.TimeUtc);
            if (entryIndex < 0)
            {
                trades.Add(BacktestTrade.NoData(underlying, signal.TimeUtc, signal.Direction, optionType, strike));
                continue;
            }

            var entryBar = optionBars[entryIndex];
            if (entryBar.Open <= 0)
            {
                trades.Add(BacktestTrade.NoData(underlying, signal.TimeUtc, signal.Direction, optionType, strike));
                continue;
            }

            var entryPrice = entryBar.Open;
            var takeProfitPrice = entryPrice * (1 + tpPercent / 100m);
            var stopLossPrice = entryPrice * (1 - slPercent / 100m);
            var entryDay = IstDate(entryBar.Time);

            var exitTime = entryBar.Time;
            var exitPrice = entryBar.Close;
            var exitReason = "EndOfDay";

            for (var i = entryIndex; i < optionBars.Count && IstDate(optionBars[i].Time) == entryDay; i++)
            {
                var bar = optionBars[i];
                // Conservative when a single bar's range spans both thresholds (a volatile bar
                // right after entry, most likely): assume the worse outcome for the trade rather
                // than guessing which was actually touched first intra-bar.
                if (bar.Low <= stopLossPrice) { exitTime = bar.Time; exitPrice = stopLossPrice; exitReason = "StopLoss"; break; }
                if (bar.High >= takeProfitPrice) { exitTime = bar.Time; exitPrice = takeProfitPrice; exitReason = "TakeProfit"; break; }
                exitTime = bar.Time;
                exitPrice = bar.Close;
            }

            busyUntil = exitTime;
            var pnlPoints = exitPrice - entryPrice;
            var pnlPercent = entryPrice != 0 ? pnlPoints / entryPrice * 100m : 0;

            trades.Add(new BacktestTrade(
                underlying, signal.TimeUtc, signal.Direction, optionType, strike,
                entryBar.Time, entryPrice, exitTime, exitPrice, exitReason, pnlPercent, pnlPoints));
        }

        return trades.OrderByDescending(t => t.SignalTimeUtc).ToList();
    }

    /// <summary>Shared by Replay and SimulateTrades - aggregates all three legs to the requested
    /// timeframe once and replays the same leg-flip/confluence state machine, returning both the
    /// full signal list and (for SimulateTrades' strike-selection math) the aggregated spot bars
    /// and the Confluence-only subset in time-ascending order.</summary>
    private static (IReadOnlyList<BacktestSignal> Signals, List<Candle> SpotBars, List<BacktestSignal> ConfluenceAscending) ReplayCore(
        string underlying, SpotUnderlyingState spotState, CdvUnderlyingState cdvState, int timeframeMinutes)
    {
        var timeframe = Math.Max(1, timeframeMinutes);
        var confluenceWindow = TimeSpan.FromMinutes(Math.Max(5, timeframe));

        var spotBars = AggregateCandles(spotState.GetClosedCandles(), timeframe);
        var ceBars = AggregateCandles(cdvState.GetAtmClosedCandles(true), timeframe);
        var peBars = AggregateCandles(cdvState.GetAtmClosedCandles(false), timeframe);

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

    /// <summary>Buckets native 1-minute closed bars into <paramref name="minutes"/>-minute OHLC
    /// bars - the server-side counterpart to the dashboard's client-side aggregateCandles, needed
    /// here because EMA9/21 has to be recomputed off the coarser bars themselves, not just
    /// redrawn from the same 1-minute signals.</summary>
    private static List<Candle> AggregateCandles(IReadOnlyList<Candle> bars, int minutes)
    {
        if (minutes <= 1 || bars.Count == 0) return bars.ToList();

        var bucketSeconds = minutes * 60;
        var buckets = new SortedDictionary<long, Candle>();
        foreach (var bar in bars)
        {
            var bucketEpoch = bar.Time.ToUnixTimeSeconds() / bucketSeconds * bucketSeconds;
            var bucketTime = DateTimeOffset.FromUnixTimeSeconds(bucketEpoch);
            buckets[bucketEpoch] = buckets.TryGetValue(bucketEpoch, out var existing)
                ? existing with { High = Math.Max(existing.High, bar.High), Low = Math.Min(existing.Low, bar.Low), Close = bar.Close }
                : new Candle(bucketTime, bar.Open, bar.High, bar.Low, bar.Close);
        }
        return buckets.Values.ToList();
    }

    private static DateOnly IstDate(DateTimeOffset time) => DateOnly.FromDateTime(time.ToOffset(TimeSpan.FromHours(5.5)).DateTime);

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

using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// The "backtrack" page's engine: replays ConfluenceAlertService's exact individual-leg-flip +
/// three-way-confluence logic offline over whatever spot/ATM CE/PE candle history is currently
/// held in memory (up to SpotFeedHostedService/CdvUnderlyingState's HistoryTradingDays), instead of
/// reacting to live bar closes. Stateless and computed on demand per request - there's nothing to
/// keep updated between requests, since it only ever reads the two hosted services' already-live
/// in-memory state.
///
/// Faithful to ConfluenceAlertService's live behavior:
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
    private static readonly TimeSpan ConfluenceWindow = TimeSpan.FromMinutes(5);

    private readonly SpotFeedHostedService _spotFeed;
    private readonly CdvHostedService _cdv;

    public BacktestService(SpotFeedHostedService spotFeed, CdvHostedService cdv)
    {
        _spotFeed = spotFeed;
        _cdv = cdv;
    }

    /// <summary>Every signal that would have fired across the underlying's currently-held history,
    /// most recent first. Empty if the underlying isn't recognized or has no history backfilled
    /// yet.</summary>
    public IReadOnlyList<BacktestSignal> Replay(string underlying)
    {
        if (!_spotFeed.States.TryGetValue(underlying, out var spotState) || !_cdv.States.TryGetValue(underlying, out var cdvState))
            return Array.Empty<BacktestSignal>();

        var spotSeries = EmaCrossoverDetector.DirectionSeries(spotState.GetClosedCandles());
        var ceSeries = EmaCrossoverDetector.DirectionSeries(cdvState.GetAtmClosedCandles(true));
        var peSeries = EmaCrossoverDetector.DirectionSeries(cdvState.GetAtmClosedCandles(false));

        var spotByTime = ToLookup(spotSeries);
        var ceByTime = ToLookup(ceSeries);
        var peByTime = ToLookup(peSeries);

        var timeline = spotByTime.Keys.Concat(ceByTime.Keys).Concat(peByTime.Keys).Distinct().OrderBy(t => t).ToList();

        (string Direction, DateTimeOffset BarTime)? spot = null, ce = null, pe = null;
        var confluenceAlerted = false;
        var signals = new List<BacktestSignal>();

        foreach (var t in timeline)
        {
            var changed = false;
            changed |= TryUpdateLeg(spotByTime, t, ref spot, underlying, "Spot", "Spot EMA9/21 turned {0}", signals);
            changed |= TryUpdateLeg(ceByTime, t, ref ce, underlying, "AtmCe", "ATM CE EMA9/21 turned {0}", signals);
            changed |= TryUpdateLeg(peByTime, t, ref pe, underlying, "AtmPe", "ATM PE EMA9/21 turned {0}", signals);

            if (changed) confluenceAlerted = false; // a leg just moved - a fresh alignment can alert again

            if (spot is not { } s || ce is not { } c || pe is not { } p) continue;

            var withinWindow = (s.BarTime - c.BarTime).Duration() <= ConfluenceWindow && (s.BarTime - p.BarTime).Duration() <= ConfluenceWindow;
            var isBullish = withinWindow && s.Direction == "Bullish" && c.Direction == "Bullish" && p.Direction == "Bearish";
            var isBearish = withinWindow && s.Direction == "Bearish" && p.Direction == "Bullish" && c.Direction == "Bearish";

            if (!isBullish && !isBearish) { confluenceAlerted = false; continue; }
            if (confluenceAlerted) continue;

            confluenceAlerted = true;
            var direction = isBullish ? "Bullish" : "Bearish";
            var summary = direction == "Bullish"
                ? "Spot breakup + ATM CE breakup + ATM PE breakdown"
                : "Spot breakdown + ATM PE breakup + ATM CE breakdown";
            signals.Add(new BacktestSignal(underlying, s.BarTime, "Confluence", direction, summary));
        }

        return signals.OrderByDescending(s => s.TimeUtc).ToList();
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

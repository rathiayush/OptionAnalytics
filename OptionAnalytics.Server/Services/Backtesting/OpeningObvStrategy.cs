using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// One trade a day, taken a few minutes into the session, in whichever direction the CE/PE
/// delta-weighted OBV has ALREADY committed to since the open.
///
/// The idea: by a few minutes in, the two legs' OBV have moved off the day's open, and a real
/// directional move shows up as them moving OPPOSITE ways - CE accumulating while PE distributes
/// (bullish), or the mirror (bearish). Both legs rising, or both falling, is not direction, it is
/// just volume; this only takes the one-sided case.
///
/// The condition, measured at the first bar at or after EntryTime on each trading day:
///
///   ceChange = CE OBV now - CE OBV at this day's first bar
///   peChange = PE OBV now - PE OBV at this day's first bar
///   oneSidedness% = (ceChange - peChange) / (|ceChange| + |peChange|) x 100
///
///   BULLISH when ceChange > 0 AND peChange &lt; 0 AND oneSidedness% >= threshold
///   BEARISH when ceChange &lt; 0 AND peChange > 0 AND oneSidedness% &lt;= -threshold
///
/// oneSidedness% runs +100 (CE up, PE down, perfectly one-sided) through 0 (both legs moved the
/// same way, no direction) to -100. The explicit sign checks are what make it unambiguous: the
/// ratio alone can look strong when both legs move together by different amounts, which is exactly
/// the case this setup is meant to reject.
///
/// WHY OBV AND NOT CDV, since the two are usually quoted together: CDV is day-scoped - it resets
/// every trading day and only the CURRENT day is ever held in memory (see CdvUnderlyingState.Reset
/// and BacktestStrategyContext.CdvCeSeries). A strategy requiring it could therefore only ever
/// produce ONE backtestable signal - today's - and could never be measured over the app's 15 days
/// of history. OBV carries its full multi-day history, so this is measurable before it is armed.
///
/// A known characteristic of reading OBV this early in the session: BacktestStrategyContext's
/// series is day-baselined and THEN EMA-smoothed, and that EMA runs continuously across days
/// rather than restarting - so a value a couple of bars into the session still carries a good deal
/// of yesterday's tail. Subtracting this day's own first bar (rather than reading the level) is
/// what normalises that out, and is why the condition is written as a CHANGE since the open rather
/// than an absolute reading.
///
/// One signal per day by construction, so the simulator's one-position-at-a-time rule never has
/// anything to collapse: the day's trade runs to its stop, target, or the day's close.
///
/// Covers both of the setups this was asked for through EntryTime, rather than as two near-
/// identical strategies: the 1-minute version is timeframe 1 with EntryTime 917, and the 3-minute
/// version is timeframe 3 with EntryTime 922. Timeframe is the page's own control in this app, so
/// splitting on it would have duplicated the whole file to change one default.
/// </summary>
public sealed class OpeningObvStrategy : IBacktestStrategy
{
    public string Key => "opening-obv";
    public string Name => "Opening OBV one-sidedness";
    public string Description => "Once a day, a few minutes after the open, takes the direction the CE/PE OBV has already committed to: CE rising while PE falls is bullish, the mirror is bearish, and both moving the same way is rejected as volume rather than direction. The 1-minute setup is timeframe 1 with entry 917; the 3-minute one is timeframe 3 with entry 922.";

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.StopLossParameter(),
        OptionTradeSimulator.TakeProfitParameter(),

        // HHMM in IST, as one field rather than two - 917 reads as 9:17 and 922 as 9:22, which is
        // exactly how the two setups this serves are described.
        new BacktestParameterSpec("entryTime", "Entry time (HHMM IST)", Default: 917, Min: 900, Max: 1530, Step: 1),

        new BacktestParameterSpec("thresholdPercent", "One-sidedness threshold (%)", Default: 60, Min: 0, Max: 100, Step: 5),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        OptionTradeSimulator.Run(context, Evaluate(context, parameters).Entries, parameters);

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private static (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var entryTime = (int)parameters["entryTime"];
        var threshold = parameters["thresholdPercent"];
        var entryHour = entryTime / 100;
        var entryMinute = entryTime % 100;

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        // OBV keyed by bar time so the value AT the entry bar can be read directly - the series is
        // already aggregated to this run's timeframe, so its times line up with SpotBars.
        var ceByTime = context.ObvCeSeries.ToDictionary(p => p.Time, p => p.Obv);
        var peByTime = context.ObvPeSeries.ToDictionary(p => p.Time, p => p.Obv);

        foreach (var day in context.SpotBars.GroupBy(b => BacktestUtil.IstDate(b.Time)).OrderBy(g => g.Key))
        {
            var dayBars = day.OrderBy(b => b.Time).ToList();

            // This day's own baseline - the first bar it actually traded, whenever that was, rather
            // than an assumed session-open time.
            var firstBar = dayBars[0];
            if (!ceByTime.TryGetValue(firstBar.Time, out var ceOpen) || !peByTime.TryGetValue(firstBar.Time, out var peOpen))
                continue;

            var entryBar = dayBars.FirstOrDefault(b => IsAtOrAfter(b.Time, entryHour, entryMinute));
            if (entryBar.Time == default) continue; // this day never reached the entry time

            if (!ceByTime.TryGetValue(entryBar.Time, out var ceNow) || !peByTime.TryGetValue(entryBar.Time, out var peNow))
                continue;

            var ceChange = ceNow - ceOpen;
            var peChange = peNow - peOpen;
            var magnitude = Math.Abs(ceChange) + Math.Abs(peChange);
            if (magnitude == 0) continue; // neither leg moved at all - nothing to read, and the ratio is undefined

            var oneSidedness = (ceChange - peChange) / magnitude * 100m;

            var isBullish = ceChange > 0 && peChange < 0 && oneSidedness >= threshold;
            var isBearish = ceChange < 0 && peChange > 0 && oneSidedness <= -threshold;

            var summary =
                $"At {entryHour:00}:{entryMinute:00} CE OBV {(ceChange >= 0 ? "+" : "")}{ceChange:0.##} and PE OBV " +
                $"{(peChange >= 0 ? "+" : "")}{peChange:0.##} since the open - {oneSidedness:0.#}% one-sided " +
                $"(threshold {threshold:0.#}%)";

            if (isBullish || isBearish)
            {
                var directionName = isBullish ? "Bullish" : "Bearish";
                signals.Add(new BacktestSignal(context.Underlying, entryBar.Time, "Entry", directionName, summary));
                entries.Add((entryBar.Time, directionName));
            }
            else
            {
                // Reported rather than skipped silently, so a day with no trade explains itself -
                // the two reasons look very different and it matters which one it was.
                var why = ceChange > 0 == peChange > 0
                    ? "both legs moved the same way, so this is volume rather than direction"
                    : "the legs diverged but not strongly enough for the threshold";
                signals.Add(new BacktestSignal(context.Underlying, entryBar.Time, "Rejected", "Neutral", $"{summary} - no trade, {why}"));
            }
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }

    private static bool IsAtOrAfter(DateTimeOffset barTime, int hour, int minute)
    {
        var ist = barTime.ToOffset(TimeSpan.FromHours(5.5));
        return ist.Hour > hour || (ist.Hour == hour && ist.Minute >= minute);
    }
}

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
/// Both OBV and CDV can answer this, and Source picks which. CDV used to be reconstructed only for
/// today, which is why this started OBV-only; it now covers the whole backfill window, so requiring
/// it no longer caps the backtest at a single signal. The two measure different things - OBV signs
/// whole bars by close-vs-close, CDV signs by where each bar closed within its own range - so
/// "both" is a genuinely stricter test than either alone, not a duplicate of it.
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
    public string Description => "Once a day, a few minutes after the open, takes the direction the CE/PE volume has already committed to: CE rising while PE falls is bullish, the mirror is bearish, and both moving the same way is rejected as volume rather than direction. Source picks OBV, CDV, or both having to agree. The 1-minute setup is timeframe 1 with entry 917; the 3-minute one is timeframe 3 with entry 922.";

    private const decimal SourceObvOnly = 0;
    private const decimal SourceCdvOnly = 1;
    private const decimal SourceBoth = 2;

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

        new BacktestParameterSpec("source", "Volume source", Default: SourceBoth, Min: SourceObvOnly, Max: SourceBoth, Step: 1, Options: new[]
        {
            new BacktestParameterOption(SourceObvOnly, "OBV only"),
            new BacktestParameterOption(SourceCdvOnly, "CDV only"),
            new BacktestParameterOption(SourceBoth, "Both must agree"),
        }),
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
        var source = parameters["source"];
        var entryHour = entryTime / 100;
        var entryMinute = entryTime % 100;

        var useObv = source != SourceCdvOnly;
        var useCdv = source != SourceObvOnly;

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        // Keyed by bar time so the value AT the entry bar can be read directly - both series are
        // already aggregated to this run's timeframe, so their times line up with SpotBars.
        var obvCe = context.ObvCeSeries.ToDictionary(p => p.Time, p => p.Obv);
        var obvPe = context.ObvPeSeries.ToDictionary(p => p.Time, p => p.Obv);
        var cdvCe = context.CdvCeSeries.ToDictionary(p => p.Time, p => p.Obv);
        var cdvPe = context.CdvPeSeries.ToDictionary(p => p.Time, p => p.Obv);

        foreach (var day in context.SpotBars.GroupBy(b => BacktestUtil.IstDate(b.Time)).OrderBy(g => g.Key))
        {
            var dayBars = day.OrderBy(b => b.Time).ToList();

            // This day's own baseline - the first bar it actually traded, whenever that was, rather
            // than an assumed session-open time.
            var firstBar = dayBars[0];
            var entryBar = dayBars.FirstOrDefault(b => IsAtOrAfter(b.Time, entryHour, entryMinute));
            if (entryBar.Time == default) continue; // this day never reached the entry time

            var obv = Read("OBV", obvCe, obvPe, firstBar.Time, entryBar.Time, threshold);
            var cdv = Read("CDV", cdvCe, cdvPe, firstBar.Time, entryBar.Time, threshold);

            // A source that has no data for this day cannot vote. Requiring it (CDV only, or both)
            // therefore means no trade rather than a pass by default.
            if ((useObv && obv is null) || (useCdv && cdv is null)) continue;

            var verdicts = new[] { useObv ? obv : null, useCdv ? cdv : null }.Where(v => v is not null).Select(v => v!.Value).ToList();
            if (verdicts.Count == 0) continue;

            var summary = $"At {entryHour:00}:{entryMinute:00} " + string.Join("; ", verdicts.Select(v => v.Detail)) +
                $" (threshold {threshold:0.#}%)";

            // Every required source has to point the SAME way - that is what "both must agree"
            // buys over either alone.
            var isBullish = verdicts.All(v => v.IsBullish);
            var isBearish = verdicts.All(v => v.IsBearish);

            if (isBullish || isBearish)
            {
                var directionName = isBullish ? "Bullish" : "Bearish";
                signals.Add(new BacktestSignal(context.Underlying, entryBar.Time, "Entry", directionName, summary));
                entries.Add((entryBar.Time, directionName));
            }
            else
            {
                // Reported rather than skipped silently, so a day with no trade explains itself -
                // the reasons look very different and it matters which one it was.
                var why = verdicts.Count > 1 && verdicts.Any(v => v.IsBullish || v.IsBearish)
                    ? "the sources disagreed"
                    : verdicts.All(v => v.SameDirection)
                        ? "both legs moved the same way, so this is volume rather than direction"
                        : "the legs diverged but not strongly enough for the threshold";
                signals.Add(new BacktestSignal(context.Underlying, entryBar.Time, "Rejected", "Neutral", $"{summary} - no trade, {why}"));
            }
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }

    /// <summary>One source's verdict at the entry bar: how one-sided its CE/PE change since this
    /// day's open is, and the phrase that goes in the signal row so the table says WHAT was seen.
    /// Null when the source has no reading for this day at all.</summary>
    private readonly record struct Verdict(bool IsBullish, bool IsBearish, bool SameDirection, string Detail);

    private static Verdict? Read(
        string label, IReadOnlyDictionary<DateTimeOffset, decimal> ce, IReadOnlyDictionary<DateTimeOffset, decimal> pe,
        DateTimeOffset openTime, DateTimeOffset entryTime, decimal threshold)
    {
        if (!ce.TryGetValue(openTime, out var ceOpen) || !pe.TryGetValue(openTime, out var peOpen)) return null;
        if (!ce.TryGetValue(entryTime, out var ceNow) || !pe.TryGetValue(entryTime, out var peNow)) return null;

        var ceChange = ceNow - ceOpen;
        var peChange = peNow - peOpen;
        var magnitude = Math.Abs(ceChange) + Math.Abs(peChange);
        if (magnitude == 0) return null; // neither leg moved - nothing to read, and the ratio is undefined

        var oneSidedness = (ceChange - peChange) / magnitude * 100m;

        var detail = $"CE {label} {(ceChange >= 0 ? "+" : "")}{ceChange:0.##} / PE {label} " +
            $"{(peChange >= 0 ? "+" : "")}{peChange:0.##} since the open, {oneSidedness:0.#}% one-sided";

        return new Verdict(
            IsBullish: ceChange > 0 && peChange < 0 && oneSidedness >= threshold,
            IsBearish: ceChange < 0 && peChange > 0 && oneSidedness <= -threshold,
            SameDirection: ceChange > 0 == peChange > 0,
            Detail: detail);
    }

    private static bool IsAtOrAfter(DateTimeOffset barTime, int hour, int minute)
    {
        var ist = barTime.ToOffset(TimeSpan.FromHours(5.5));
        return ist.Hour > hour || (ist.Hour == hour && ist.Minute >= minute);
    }
}

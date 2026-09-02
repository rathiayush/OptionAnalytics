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
/// On top of that, PrevDayChangePercent asks the same direction to hold against WHERE YESTERDAY
/// FINISHED, not just against this morning's open:
///
///   ceGap = CE now - CE at the previous trading day's last bar   (peGap likewise)
///   BULLISH additionally needs ceGap >= +X% of |yesterday's CE close| AND peGap &lt;= -X% of
///   |yesterday's PE close|; BEARISH needs the mirror.
///
/// Both series are day-baselined (each trading day starts from its own zero - see
/// CdvUnderlyingState.ApplyDailyBaseline for OBV and FinalizeHistory for CDV), so yesterday's
/// closing level is yesterday's NET move for the whole session, and this reading is today's net
/// move so far. The gate therefore says "the legs are already on the other side of where yesterday
/// left them, by a margin" rather than comparing two arbitrary absolute levels. The margin is
/// expressed against |yesterday's close| and applied as a multiplication, never a division, so a
/// day that finished flat does not blow the ratio up - against a flat close any real move clears
/// the bar. Set the parameter to 0 to switch the whole gate off and get the open-relative
/// behaviour alone. A day with no previous trading day in the window (the first day of the
/// backfill) cannot answer the question and is reported as a no-trade rather than passed.
///
/// Both OBV and CDV can answer all of this, and Source picks which. CDV used to be reconstructed
/// only for today, which is why this started OBV-only; it now covers the whole backfill window, so
/// requiring it no longer caps the backtest at a single signal - and it is what makes a
/// previous-day comparison possible for CDV at all. The two measure different things - OBV signs
/// whole bars by close-vs-close, CDV signs by where each bar closed within its own range - so
/// "both" is a genuinely stricter test than either alone, not a duplicate of it.
///
/// A known characteristic of reading OBV this early in the session: BacktestStrategyContext's
/// series is day-baselined and THEN EMA-smoothed, and that EMA runs continuously across days
/// rather than restarting - so a value a couple of bars into the session still carries a good deal
/// of yesterday's tail. Subtracting this day's own first bar (rather than reading the level) is
/// what normalises that out, and is why the one-sidedness condition is written as a CHANGE since
/// the open rather than an absolute reading.
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
    public string Description => "Once a day, a few minutes after the open, takes the direction the CE/PE volume has already committed to: CE rising while PE falls is bullish, the mirror is bearish, and both moving the same way is rejected as volume rather than direction. The same direction also has to hold against where the legs finished the previous day, by a configurable margin. Source picks OBV, CDV, or both having to agree. The 1-minute setup is timeframe 1 with entry 917; the 3-minute one is timeframe 3 with entry 922.";

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

        // Measured against |yesterday's closing level|, so it is a margin rather than a bounded
        // ratio - a leg can sit several times yesterday's whole-day move. 0 switches the gate off.
        new BacktestParameterSpec("prevDayChangePercent", "Change vs previous day close (%)", Default: 20, Min: 0, Max: 500, Step: 5),

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
        var prevDayThreshold = parameters.TryGetValue("prevDayChangePercent", out var p) ? p : 0m;
        var source = parameters["source"];
        var entryHour = entryTime / 100;
        var entryMinute = entryTime % 100;

        var useObv = source != SourceCdvOnly;
        var useCdv = source != SourceObvOnly;

        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();

        var obvCe = BuildLeg(context.ObvCeSeries);
        var obvPe = BuildLeg(context.ObvPeSeries);
        var cdvCe = BuildLeg(context.CdvCeSeries);
        var cdvPe = BuildLeg(context.CdvPeSeries);

        // The previous day is taken from the SPOT bars, not from either volume series, so both
        // sources answer about the same calendar day - a series missing that day then reads as no
        // data (below) instead of silently comparing against a different day than the other source.
        DateOnly? previousDay = null;

        foreach (var day in context.SpotBars.GroupBy(b => BacktestUtil.IstDate(b.Time)).OrderBy(g => g.Key))
        {
            var dayBars = day.OrderBy(b => b.Time).ToList();

            // This day's own baseline - the first bar it actually traded, whenever that was, rather
            // than an assumed session-open time.
            var firstBar = dayBars[0];
            var entryBar = dayBars.FirstOrDefault(b => IsAtOrAfter(b.Time, entryHour, entryMinute));

            var thisDay = day.Key;
            var comparisonDay = previousDay;
            previousDay = thisDay;

            if (entryBar.Time == default) continue; // this day never reached the entry time

            if (prevDayThreshold > 0 && comparisonDay is null)
            {
                // The oldest day in the window has nothing behind it. Said out loud rather than
                // skipped, because "no trade on day one" is a property of the window, not a setup
                // that was looked at and rejected.
                signals.Add(new BacktestSignal(context.Underlying, entryBar.Time, "Rejected", "Neutral",
                    "No previous trading day in the window to compare against - no trade"));
                continue;
            }

            var obv = Read("OBV", obvCe, obvPe, firstBar.Time, entryBar.Time, threshold, prevDayThreshold, comparisonDay);
            var cdv = Read("CDV", cdvCe, cdvPe, firstBar.Time, entryBar.Time, threshold, prevDayThreshold, comparisonDay);

            // A source that has no data for this day cannot vote. Requiring it (CDV only, or both)
            // therefore means no trade rather than a pass by default.
            if ((useObv && obv is null) || (useCdv && cdv is null)) continue;

            var verdicts = new[] { useObv ? obv : null, useCdv ? cdv : null }.Where(v => v is not null).Select(v => v!.Value).ToList();
            if (verdicts.Count == 0) continue;

            var summary = $"At {entryHour:00}:{entryMinute:00} " + string.Join("; ", verdicts.Select(v => v.Detail)) +
                $" (threshold {threshold:0.#}%" + (prevDayThreshold > 0 ? $", vs previous close {prevDayThreshold:0.#}%)" : ")");

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
                        : verdicts.Any(v => v.OpenDirectionOnly)
                            ? "the move since the open was one-sided, but the legs are not far enough from where they closed yesterday"
                            : "the legs diverged but not strongly enough for the threshold";
                signals.Add(new BacktestSignal(context.Underlying, entryBar.Time, "Rejected", "Neutral", $"{summary} - no trade, {why}"));
            }
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList());
    }

    /// <summary>One leg's series in the two shapes this needs: the value AT a given bar (both series
    /// are already aggregated to this run's timeframe, so their times line up with SpotBars), and
    /// each trading day's LAST value, which is what "where it finished yesterday" reads.</summary>
    private readonly record struct Leg(
        IReadOnlyDictionary<DateTimeOffset, decimal> ByTime,
        IReadOnlyDictionary<DateOnly, decimal> CloseByDay);

    private static Leg BuildLeg(IReadOnlyList<ObvPoint> series) => new(
        series.ToDictionary(p => p.Time, p => p.Obv),
        series.GroupBy(p => BacktestUtil.IstDate(p.Time))
              .ToDictionary(g => g.Key, g => g.OrderBy(p => p.Time).Last().Obv));

    /// <summary>One source's verdict at the entry bar: how one-sided its CE/PE change since this
    /// day's open is, whether that same direction also holds against the previous day's close, and
    /// the phrase that goes in the signal row so the table says WHAT was seen. Null when the source
    /// has no reading for this day at all.</summary>
    private readonly record struct Verdict(
        bool IsBullish, bool IsBearish, bool SameDirection, bool OpenDirectionOnly, string Detail);

    private static Verdict? Read(
        string label, Leg ce, Leg pe,
        DateTimeOffset openTime, DateTimeOffset entryTime, decimal threshold,
        decimal prevDayThreshold, DateOnly? previousDay)
    {
        if (!ce.ByTime.TryGetValue(openTime, out var ceOpen) || !pe.ByTime.TryGetValue(openTime, out var peOpen)) return null;
        if (!ce.ByTime.TryGetValue(entryTime, out var ceNow) || !pe.ByTime.TryGetValue(entryTime, out var peNow)) return null;

        var ceChange = ceNow - ceOpen;
        var peChange = peNow - peOpen;
        var magnitude = Math.Abs(ceChange) + Math.Abs(peChange);
        if (magnitude == 0) return null; // neither leg moved - nothing to read, and the ratio is undefined

        var oneSidedness = (ceChange - peChange) / magnitude * 100m;

        var bullishSinceOpen = ceChange > 0 && peChange < 0 && oneSidedness >= threshold;
        var bearishSinceOpen = ceChange < 0 && peChange > 0 && oneSidedness <= -threshold;

        var detail = $"CE {label} {(ceChange >= 0 ? "+" : "")}{ceChange:0.##} / PE {label} " +
            $"{(peChange >= 0 ? "+" : "")}{peChange:0.##} since the open, {oneSidedness:0.#}% one-sided";

        // Gate off: the open-relative reading is the whole verdict, exactly as before.
        if (prevDayThreshold <= 0)
            return new Verdict(bullishSinceOpen, bearishSinceOpen, ceChange > 0 == peChange > 0, false, detail);

        // Gate on but the previous day is missing for THIS source - it cannot answer, so it does
        // not vote (and, when it is required, the day produces no trade).
        if (previousDay is not { } prev) return null;
        if (!ce.CloseByDay.TryGetValue(prev, out var cePrev) || !pe.CloseByDay.TryGetValue(prev, out var pePrev)) return null;

        var ceGap = ceNow - cePrev;
        var peGap = peNow - pePrev;

        // The margin as a multiplication rather than a division: a day that finished flat has a
        // needed-margin of zero, so any real move clears it instead of dividing by ~0.
        var ceNeeded = Math.Abs(cePrev) * prevDayThreshold / 100m;
        var peNeeded = Math.Abs(pePrev) * prevDayThreshold / 100m;

        var ceAbove = ceGap > 0 && ceGap >= ceNeeded;
        var ceBelow = ceGap < 0 && -ceGap >= ceNeeded;
        var peAbove = peGap > 0 && peGap >= peNeeded;
        var peBelow = peGap < 0 && -peGap >= peNeeded;

        detail += $", and {FormatGap(ceGap, cePrev)} CE / {FormatGap(peGap, pePrev)} PE vs yesterday's close";

        var isBullish = bullishSinceOpen && ceAbove && peBelow;
        var isBearish = bearishSinceOpen && ceBelow && peAbove;

        return new Verdict(
            IsBullish: isBullish,
            IsBearish: isBearish,
            SameDirection: ceChange > 0 == peChange > 0,
            OpenDirectionOnly: (bullishSinceOpen || bearishSinceOpen) && !isBullish && !isBearish,
            Detail: detail);
    }

    /// <summary>The gap as a percentage of where the leg finished yesterday - or as a raw number
    /// when yesterday finished flat, where a percentage would be meaningless rather than large.</summary>
    private static string FormatGap(decimal gap, decimal previousClose) =>
        previousClose == 0
            ? $"{(gap >= 0 ? "+" : "")}{gap:0.##} from a flat"
            : $"{(gap >= 0 ? "+" : "")}{gap / Math.Abs(previousClose) * 100m:0.#}%";

    private static bool IsAtOrAfter(DateTimeOffset barTime, int hour, int minute)
    {
        var ist = barTime.ToOffset(TimeSpan.FromHours(5.5));
        return ist.Hour > hour || (ist.Hour == hour && ist.Minute >= minute);
    }
}

using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// The user's own setup, translated directly: "sweep liquidity, IFVG, trendline break" - a sibling
/// to DailyBiasSweepFvgStrategy (same 1-hour timeframe, same sweep mechanic, same signalExits/
/// intraday constraints), but the confirmation chain and the retrace zone are different: an
/// INVERTED fair-value gap rather than a fresh one, and a short trendline break rather than a daily
/// bias filter.
///
/// THE SWEEP: identical mechanic to DailyBiasSweepFvgStrategy's own - a rolling sweepLookbackBars
/// channel of recent 1-hour highs/lows, swept by a wick beyond sweepBufferPoints that then closes
/// back inside. Unlike that strategy, there is no daily-bias gate here - either direction is hunted
/// at all times.
///
/// THE IFVG: an ordinary 3-candle fair-value gap in the ORIGINAL (pre-reversal) direction - a
/// bearish gap for a bullish sweep, the mirror for bearish - found by searching backward from the
/// sweep bar (bounded by ifvgLookbackBars). It only counts once INVERTED: the sweep bar's own close
/// must already reach back through the gap's far boundary (closing above a bearish gap's High for a
/// bullish setup, below a bullish gap's Low for bearish) - the classic ICT "IFVG" idea that a fully
/// violated gap flips polarity and becomes support/resistance in the OPPOSITE direction from
/// whatever it originally was. Sweep and inversion are checked together, at the same bar - a
/// candidate that doesn't invert its own gap on the sweep bar itself is dropped rather than watched
/// for several more bars, keeping "sweep" and "IFVG confirmed" one event rather than a second
/// waiting phase.
///
/// THE TRENDLINE BREAK: once the IFVG confirms, a line through the last two CONFIRMED swing
/// highs (for a bullish setup - the resistance line through a sequence of declining highs) or swing
/// lows (bearish - the support line through rising lows) found before the IFVG's own bar, using the
/// standard 3-bar fractal (confirmed the bar after the pivot itself closes - never lookahead). The
/// line is fixed at whatever those two points were the moment the IFVG confirmed, projected forward
/// bar by bar; "broken" the first time a later bar's Close crosses through the projected level
/// (above it for bullish, below for bearish) - bounded by trendlineLookaheadBars. Fewer than two
/// confirmed swings of the right kind before the IFVG bar means there is no line to break - the
/// candidate is dropped.
///
/// THE ENTRY: waits (bounded by retraceLookaheadBars) for a later bar to dip back into the IFVG's
/// own zone and enters there, invalidated if price closes back through the IFVG's far side first.
/// Stop sits beyond the IFVG's own far boundary; target is riskRewardMultiple times that distance,
/// resolved to an exact spot-crossing TIME the same way the other two new strategies' stops/targets
/// are (see OrbOrderBlockStrategy's own doc comment for why only a TIME, never a price, feeds
/// OptionTradeSimulator.Run's signalExits).
///
/// Same real limitation as DailyBiasSweepFvgStrategy: this app's trade model is intraday-only, so a
/// chain this long (sweep -> IFVG -> trendline break -> retrace) found late in the session may have
/// little runway left before the forced end-of-day close.
/// </summary>
public sealed class SweepIfvgTrendlineBreakStrategy : IBacktestStrategy
{
    public string Key => "sweep-ifvg-trendline-break";
    public string Name => "Sweep Liquidity + IFVG + Trendline Break";
    public string Description => "On the 1-hour chart: a liquidity sweep reverses price back through a prior fair-value gap in the original direction, inverting it into support/resistance (IFVG); once a short trendline off the last two swing highs/lows also breaks in the same direction, buys/sells the retrace back into the IFVG zone. Intraday only, like every strategy here.";

    private const decimal DirectionBoth = 0;
    private const decimal DirectionLongOnly = 1;
    private const decimal DirectionShortOnly = 2;

    private const int HourlyTimeframeMinutes = 60;

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        OptionTradeSimulator.SignalStartTimeParameter(),
        OptionTradeSimulator.ExcludeLastDaysParameter(),
        OptionTradeSimulator.MaxHoldingTimeParameter(),
        new BacktestParameterSpec("direction", "Take", Default: DirectionBoth, Min: DirectionBoth, Max: DirectionShortOnly, Step: 1, Options: new[]
        {
            new BacktestParameterOption(DirectionBoth, "Both sides"),
            new BacktestParameterOption(DirectionLongOnly, "Bullish only"),
            new BacktestParameterOption(DirectionShortOnly, "Bearish only"),
        }),
        new BacktestParameterSpec("sweepLookbackBars", "Recent swing high/low channel (1hr bars)", Default: 20, Min: 2, Max: 60, Step: 1),
        new BacktestParameterSpec("sweepBufferPoints", "Wick must clear the recent level by at least (points)", Default: 10, Min: 0, Max: 500, Step: 1),
        new BacktestParameterSpec("ifvgLookbackBars", "Search back this many 1hr bars for the gap to invert", Default: 10, Min: 1, Max: 30, Step: 1),
        new BacktestParameterSpec("trendlineLookaheadBars", "Give up waiting for the trendline break after (1hr bars)", Default: 10, Min: 1, Max: 30, Step: 1),
        new BacktestParameterSpec("retraceLookaheadBars", "Give up waiting for the retrace after (1hr bars)", Default: 5, Min: 1, Max: 20, Step: 1),
        new BacktestParameterSpec("stopBufferPoints", "Stop placed this far beyond the IFVG's far side (points)", Default: 5, Min: 0, Max: 500, Step: 1),
        new BacktestParameterSpec("riskRewardMultiple", "Target = this many times the stop distance", Default: 3, Min: 1, Max: 10, Step: 0.5m),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var (entries, signals, signalExits) = Evaluate(context, parameters);
        return OptionTradeSimulator.Run(context, entries, parameters, signalExits: signalExits, oneMinuteFills: true);
    }

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals, Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)> SignalExits) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var direction = parameters["direction"];
        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);
        var sweepLookbackBars = Math.Max(2, (int)parameters["sweepLookbackBars"]);
        var sweepBufferPoints = parameters["sweepBufferPoints"];
        var ifvgLookbackBars = Math.Max(1, (int)parameters["ifvgLookbackBars"]);
        var trendlineLookaheadBars = Math.Max(1, (int)parameters["trendlineLookaheadBars"]);
        var retraceLookaheadBars = Math.Max(1, (int)parameters["retraceLookaheadBars"]);
        var stopBufferPoints = parameters["stopBufferPoints"];
        var riskRewardMultiple = parameters["riskRewardMultiple"];

        var entries = new List<(DateTimeOffset, string)>();
        var signals = new List<BacktestSignal>();
        var signalExits = new Dictionary<DateTimeOffset, (DateTimeOffset, string)>();

        var oneMinBars = context.SpotBarsOneMinute;
        if (oneMinBars.Count == 0) return (entries, signals, signalExits);

        var hourlyBars = BacktestUtil.AggregateCandles(oneMinBars, HourlyTimeframeMinutes);
        if (hourlyBars.Count == 0) return (entries, signals, signalExits);

        void Emit(Candle bar, bool bearish, string detail, decimal stop, decimal target, int oneMinDayEndExclusive, int oneMinEntryIndex)
        {
            var dir = bearish ? "Bearish" : "Bullish";
            var beforeSignalStart = signalStartMinutes > 0 && IstClock.MinutesOfDay(bar.Time) < signalStartMinutes;

            if (beforeSignalStart)
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{detail} - skipped, before {IstClock.FormatMinutesOfDay(signalStartMinutes)} IST (pre-open)"));
            else if (bearish && !takeShorts)
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{detail} - skipped, bullish only"));
            else if (!bearish && !takeLongs)
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", dir, $"{detail} - skipped, bearish only"));
            else
            {
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", dir, detail));
                entries.Add((bar.Time, dir));

                var exit = FindSpotExit(oneMinBars, oneMinEntryIndex, oneMinDayEndExclusive, bearish, stop, target);
                if (exit is { } e) signalExits[bar.Time] = e;
            }
        }

        var hourStart = 0;
        while (hourStart < hourlyBars.Count)
        {
            var day = IstClock.IstDate(hourlyBars[hourStart].Time);
            var hourEnd = hourStart;
            while (hourEnd < hourlyBars.Count && IstClock.IstDate(hourlyBars[hourEnd].Time) == day) hourEnd++;

            if (hourEnd - hourStart > sweepLookbackBars)
            {
                RunSession(hourlyBars, hourStart, hourEnd, oneMinBars, sweepLookbackBars, sweepBufferPoints,
                    ifvgLookbackBars, trendlineLookaheadBars, retraceLookaheadBars, stopBufferPoints, riskRewardMultiple, Emit);
            }

            hourStart = hourEnd;
        }

        return (entries, signals.OrderByDescending(sig => sig.TimeUtc).ToList(), signalExits);
    }

    private sealed record IfvgZone(bool Bullish, decimal High, decimal Low);
    private sealed record TrendlineBreak(IfvgZone Ifvg, decimal Slope, decimal ValueAtBreakIndex, int BreakOriginIndex, int ConfirmedIndex);

    private static void RunSession(
        IReadOnlyList<Candle> hourlyBars, int start, int end, IReadOnlyList<Candle> oneMinBars,
        int sweepLookbackBars, decimal sweepBufferPoints, int ifvgLookbackBars, int trendlineLookaheadBars, int retraceLookaheadBars,
        decimal stopBufferPoints, decimal riskRewardMultiple,
        Action<Candle, bool, string, decimal, decimal, int, int> emit)
    {
        var swingHighs = new List<(int Index, decimal Value)>();
        var swingLows = new List<(int Index, decimal Value)>();

        IfvgZone? pendingIfvg = null;
        TrendlineBreak? pendingBreak = null;
        var pendingIfvgIndex = 0;
        var pendingBreakIndex = 0;

        for (var i = start; i < end; i++)
        {
            var bar = hourlyBars[i];

            // Confirm the swing at i-1 (the standard 3-bar fractal) now that its right-hand
            // neighbor i has itself closed - never earlier, so a still-forming bar can't create a
            // pivot that wasn't knowable yet.
            if (i >= start + 2)
            {
                var mid = i - 1;
                if (hourlyBars[mid].High > hourlyBars[mid - 1].High && hourlyBars[mid].High > bar.High)
                    swingHighs.Add((mid, hourlyBars[mid].High));
                if (hourlyBars[mid].Low < hourlyBars[mid - 1].Low && hourlyBars[mid].Low < bar.Low)
                    swingLows.Add((mid, hourlyBars[mid].Low));
            }

            if (pendingBreak is { } brk)
            {
                if (i - pendingBreakIndex > retraceLookaheadBars) { pendingBreak = null; pendingIfvg = null; continue; }

                var ifvg = brk.Ifvg;
                var invalidated = ifvg.Bullish ? bar.Close < ifvg.Low : bar.Close > ifvg.High;
                if (invalidated) { pendingBreak = null; pendingIfvg = null; continue; }

                var retraced = ifvg.Bullish ? bar.Low <= ifvg.High : bar.High >= ifvg.Low;
                if (retraced)
                {
                    var stop = ifvg.Bullish ? ifvg.Low - stopBufferPoints : ifvg.High + stopBufferPoints;
                    var risk = Math.Abs(bar.Close - stop);
                    var target = ifvg.Bullish ? bar.Close + riskRewardMultiple * risk : bar.Close - riskRewardMultiple * risk;

                    var (oneMinEntryIndex, oneMinDayEnd) = LocateInOneMinuteBars(oneMinBars, bar.Time);
                    emit(bar, !ifvg.Bullish,
                        $"Swept, inverted the FVG [{ifvg.Low:0.##}-{ifvg.High:0.##}], broke the trendline, and retraced back into it at {bar.Close:0.##} - stop {stop:0.##}, target {target:0.##} (1:{riskRewardMultiple:0.#})",
                        stop, target, oneMinDayEnd, oneMinEntryIndex);
                    pendingBreak = null;
                    pendingIfvg = null;
                }
                continue;
            }

            if (pendingIfvg is { } ifvgZone)
            {
                if (i - pendingIfvgIndex > trendlineLookaheadBars) { pendingIfvg = null; continue; }

                var line = ifvgZone.Bullish
                    ? BuildLine(swingHighs, beforeIndex: pendingIfvgIndex)
                    : BuildLine(swingLows, beforeIndex: pendingIfvgIndex);

                if (line is { } l)
                {
                    var projected = l.Value2 + l.Slope * (i - l.Index2);
                    var broken = ifvgZone.Bullish ? bar.Close > projected : bar.Close < projected;
                    if (broken)
                    {
                        pendingBreak = new TrendlineBreak(ifvgZone, l.Slope, projected, l.Index2, i);
                        pendingBreakIndex = i;
                    }
                }
                continue;
            }

            // Hunt a sweep+inversion together at this same bar - see this class's own doc comment
            // for why the two are checked as one event rather than two separate waiting phases.
            if (i - start < sweepLookbackBars) continue;

            decimal recentHigh = hourlyBars[i - sweepLookbackBars].High, recentLow = hourlyBars[i - sweepLookbackBars].Low;
            for (var w = i - sweepLookbackBars + 1; w < i; w++)
            {
                recentHigh = Math.Max(recentHigh, hourlyBars[w].High);
                recentLow = Math.Min(recentLow, hourlyBars[w].Low);
            }

            if (bar.Low <= recentLow - sweepBufferPoints && bar.Close > recentLow)
            {
                var gap = FindGapBefore(hourlyBars, i, ifvgLookbackBars, wantBullishMove: false); // a BEARISH gap precedes a bullish reversal
                if (gap is { } g && bar.Close > g.High) { pendingIfvg = new IfvgZone(true, g.High, g.Low); pendingIfvgIndex = i; }
            }
            else if (bar.High >= recentHigh + sweepBufferPoints && bar.Close < recentHigh)
            {
                var gap = FindGapBefore(hourlyBars, i, ifvgLookbackBars, wantBullishMove: true); // a BULLISH gap precedes a bearish reversal
                if (gap is { } g && bar.Close < g.Low) { pendingIfvg = new IfvgZone(false, g.High, g.Low); pendingIfvgIndex = i; }
            }
        }
    }

    /// <summary>The nearest 3-candle fair-value gap ending strictly before <paramref name="atIndex"/>
    /// (the sweep bar), searched backward within lookbackBars - same shape as
    /// DailyBiasSweepFvgStrategy's own FindGap, just scanning a whole window at once instead of one
    /// bar per loop iteration, since this is a one-shot lookup rather than an ongoing forward
    /// scan.</summary>
    private static (decimal High, decimal Low)? FindGapBefore(IReadOnlyList<Candle> bars, int atIndex, int lookbackBars, bool wantBullishMove)
    {
        var floor = Math.Max(2, atIndex - lookbackBars);
        for (var j = atIndex - 1; j >= floor; j--)
        {
            var first = bars[j - 2];
            var third = bars[j];
            if (wantBullishMove && first.High < third.Low) return (third.Low, first.High);
            if (!wantBullishMove && first.Low > third.High) return (first.Low, third.High);
        }
        return null;
    }

    private sealed record Line(int Index2, decimal Value2, decimal Slope);

    /// <summary>A line through the last two swing points strictly before <paramref name="beforeIndex"/>
    /// - null if fewer than two exist yet, meaning there is no trendline to break.</summary>
    private static Line? BuildLine(List<(int Index, decimal Value)> swings, int beforeIndex)
    {
        var usable = swings.Where(s => s.Index < beforeIndex).ToList();
        if (usable.Count < 2) return null;

        var (idx1, val1) = usable[^2];
        var (idx2, val2) = usable[^1];
        var slope = idx2 == idx1 ? 0 : (val2 - val1) / (idx2 - idx1);
        return new Line(idx2, val2, slope);
    }

    /// <summary>Same mapping as OrbOrderBlockStrategy/DailyBiasSweepFvgStrategy's own - locates an
    /// hourly bar's Time within SpotBarsOneMinute's index range for that same calendar day.</summary>
    private static (int EntryIndex, int DayEndExclusive) LocateInOneMinuteBars(IReadOnlyList<Candle> oneMinBars, DateTimeOffset hourlyBarTime)
    {
        var day = IstClock.IstDate(hourlyBarTime);
        var entryIndex = -1;
        var dayEnd = oneMinBars.Count;
        for (var i = 0; i < oneMinBars.Count; i++)
        {
            var barDay = IstClock.IstDate(oneMinBars[i].Time);
            if (barDay != day)
            {
                if (entryIndex >= 0) { dayEnd = i; break; }
                continue;
            }
            if (entryIndex < 0 && oneMinBars[i].Time >= hourlyBarTime) entryIndex = i;
        }
        if (entryIndex < 0) entryIndex = oneMinBars.Count - 1;
        return (entryIndex, dayEnd);
    }

    /// <summary>Same conservative "check the stop first" convention as OrbOrderBlockStrategy's own
    /// FindSpotExit - see that method's own doc comment.</summary>
    private static (DateTimeOffset Time, string Reason)? FindSpotExit(
        IReadOnlyList<Candle> bars, int entryIndex, int dayEndExclusive, bool bearish, decimal stop, decimal target)
    {
        for (var i = entryIndex + 1; i < dayEndExclusive; i++)
        {
            var bar = bars[i];
            var stopHit = bearish ? bar.High >= stop : bar.Low <= stop;
            if (stopHit) return (bar.Time, "IfvgTrendlineStop");

            var targetHit = bearish ? bar.Low <= target : bar.High >= target;
            if (targetHit) return (bar.Time, "IfvgTrendlineTarget");
        }
        return null;
    }
}

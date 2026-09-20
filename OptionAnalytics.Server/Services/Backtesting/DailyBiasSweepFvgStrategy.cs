using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// The user's own setup, translated directly: "daily sweep - daily chart identify market going up
/// or down - structure - HH HL market up, LL LH market want to go down - shift to 1hr - look for
/// fakeouts - once fakeout is over look for FVG - and wait for retrace and then enter."
///
/// DAILY BIAS: one bar per calendar day, built here from SpotBarsOneMinute (Open of its first bar,
/// High/Low across all of it, Close of its last bar) - this app has no separate daily candle source.
/// A day is a confirmed swing high/low using the standard 3-bar fractal (its High/Low beats BOTH
/// immediate neighbors) - "confirmed" the moment the day AFTER it has itself fully closed, never
/// earlier, so today's own still-forming day can never retroactively create a pivot that wasn't
/// knowable yet. Bias for a given session is Bullish when the last two CONFIRMED swing highs are
/// rising AND the last two confirmed swing lows are rising (HH+HL); Bearish when both are falling
/// (LH+LL); otherwise there is no bias and this strategy trades nothing that day.
///
/// THE FAKEOUT: on the 1-hour chart (SpotBarsOneMinute re-aggregated here, independent of the page's
/// own timeframe - the same convention SrFlowSellStrategy's 30-minute channel uses), a rolling
/// sweepLookbackBars channel of recent 1hr highs/lows is the level to sweep. Trading WITH the daily
/// bias means sweeping AGAINST it first: an uptrend day looks for a bar whose Low pokes below the
/// recent low by sweepBufferPoints and then CLOSES back above it (a liquidity grab that reverses) -
/// the mirror for a downtrend day.
///
/// THE FVG: once a sweep confirms, searches forward (bounded by fvgLookaheadBars, never past the
/// same session) for the standard 3-candle fair-value gap - bars[j-1].High below bars[j+1].Low for a
/// bullish gap (the mirror for bearish) - the imbalance the impulsive reversal leg leaves behind.
///
/// THE ENTRY: waits (bounded by retraceLookaheadBars) for a later bar to dip back into that gap zone
/// and enters there, at that bar's own close - invalidated if price closes back through the gap's
/// far side first (fully filled, no edge left). Stop sits beyond the SWEEP bar's own wicked-through
/// extreme; target is riskRewardMultiple times that distance, resolved into the exact spot-crossing
/// TIME the same way OrbOrderBlockStrategy's own stop/target are (see its doc comment) - a level in
/// spot terms, handed to OptionTradeSimulator.Run as a signalExits TIME rather than a premium level.
///
/// A REAL LIMITATION, not swept under the rug: this app's whole trade model is intraday-only (see
/// OptionTradeSimulator's own doc comment - every position is forced closed at that day's last bar).
/// A genuine daily-bias swing setup often wants to run for more than one session; here it cannot -
/// a sweep+FVG found late in the day simply has less runway left before the forced close than one
/// found in the morning. This strategy is the intraday-compatible version of the idea, not a literal
/// multi-day carry - trading it well means favoring setups that complete earlier in the session.
/// </summary>
public sealed class DailyBiasSweepFvgStrategy : IBacktestStrategy
{
    public string Key => "daily-bias-sweep-fvg";
    public string Name => "Daily Bias Sweep + 1hr FVG Retrace";
    public string Description => "Daily HH/HL vs LL/LH structure sets today's bias; on the 1-hour chart, waits for a liquidity sweep against that bias (a wick beyond a recent swing level that closes back inside), then a fair-value gap, then enters on the retrace into that gap - only trading with the daily bias. Intraday only, like every strategy here - see this class's own doc comment for what that means for a setup found late in the session.";

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
            new BacktestParameterOption(DirectionBoth, "Both sides (whichever the daily bias is)"),
            new BacktestParameterOption(DirectionLongOnly, "Bullish only"),
            new BacktestParameterOption(DirectionShortOnly, "Bearish only"),
        }),
        new BacktestParameterSpec("sweepLookbackBars", "Recent swing high/low channel (1hr bars)", Default: 20, Min: 2, Max: 60, Step: 1),
        new BacktestParameterSpec("sweepBufferPoints", "Wick must clear the recent level by at least (points)", Default: 10, Min: 0, Max: 500, Step: 1),
        new BacktestParameterSpec("fvgLookaheadBars", "Look for a fair-value gap within this many 1hr bars of the sweep", Default: 5, Min: 1, Max: 20, Step: 1),
        new BacktestParameterSpec("retraceLookaheadBars", "Give up waiting for the retrace after (1hr bars)", Default: 5, Min: 1, Max: 20, Step: 1),
        new BacktestParameterSpec("stopBufferPoints", "Stop placed this far beyond the sweep's own extreme (points)", Default: 5, Min: 0, Max: 500, Step: 1),
        new BacktestParameterSpec("riskRewardMultiple", "Target = this many times the stop distance", Default: 3, Min: 1, Max: 10, Step: 0.5m),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var (entries, signals, signalExits) = Evaluate(context, parameters);
        return OptionTradeSimulator.Run(context, entries, parameters, signalExits: signalExits, oneMinuteFills: true);
    }

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    private enum Bias { None, Bullish, Bearish }

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals, Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)> SignalExits) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var direction = parameters["direction"];
        var takeLongs = direction != DirectionShortOnly;
        var takeShorts = direction != DirectionLongOnly;
        var signalStartMinutes = (int)parameters.GetValueOrDefault("signalStartMinutes", 555);
        var sweepLookbackBars = Math.Max(2, (int)parameters["sweepLookbackBars"]);
        var sweepBufferPoints = parameters["sweepBufferPoints"];
        var fvgLookaheadBars = Math.Max(1, (int)parameters["fvgLookaheadBars"]);
        var retraceLookaheadBars = Math.Max(1, (int)parameters["retraceLookaheadBars"]);
        var stopBufferPoints = parameters["stopBufferPoints"];
        var riskRewardMultiple = parameters["riskRewardMultiple"];

        var entries = new List<(DateTimeOffset, string)>();
        var signals = new List<BacktestSignal>();
        var signalExits = new Dictionary<DateTimeOffset, (DateTimeOffset, string)>();

        var oneMinBars = context.SpotBarsOneMinute;
        if (oneMinBars.Count == 0) return (entries, signals, signalExits);

        var dailyBars = BuildDailyBars(oneMinBars);
        var hourlyBars = BacktestUtil.AggregateCandles(oneMinBars, HourlyTimeframeMinutes);
        if (dailyBars.Count < 5 || hourlyBars.Count == 0) return (entries, signals, signalExits);

        void Emit(Candle bar, bool bearish, string detail, decimal? stop = null, decimal? target = null, int? oneMinDayEndExclusive = null, int? oneMinEntryIndex = null)
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

                if (stop is { } s && target is { } t && oneMinEntryIndex is { } ei && oneMinDayEndExclusive is { } dayEnd)
                {
                    var exit = FindSpotExit(oneMinBars, ei, dayEnd, bearish, s, t);
                    if (exit is { } e) signalExits[bar.Time] = e;
                }
            }
        }

        // hourIndexByDay groups hourlyBars' own indices by IST calendar day, so the sweep/FVG/retrace
        // state machine below never reaches across a session boundary - every trade here is intraday.
        var hourStart = 0;
        while (hourStart < hourlyBars.Count)
        {
            var day = IstClock.IstDate(hourlyBars[hourStart].Time);
            var hourEnd = hourStart;
            while (hourEnd < hourlyBars.Count && IstClock.IstDate(hourlyBars[hourEnd].Time) == day) hourEnd++;

            var bias = BiasFor(dailyBars, day);
            if (bias != Bias.None && hourEnd - hourStart > sweepLookbackBars)
            {
                RunSession(hourlyBars, hourStart, hourEnd, bias, oneMinBars, sweepLookbackBars, sweepBufferPoints,
                    fvgLookaheadBars, retraceLookaheadBars, stopBufferPoints, riskRewardMultiple, Emit);
            }

            hourStart = hourEnd;
        }

        return (entries, signals.OrderByDescending(sig => sig.TimeUtc).ToList(), signalExits);
    }

    private sealed record SweepState(bool Bullish, decimal SweptExtreme, int SweepIndex);
    private sealed record FvgZone(bool Bullish, decimal High, decimal Low, int SweepIndex);

    private static void RunSession(
        IReadOnlyList<Candle> hourlyBars, int start, int end, Bias bias, IReadOnlyList<Candle> oneMinBars,
        int sweepLookbackBars, decimal sweepBufferPoints, int fvgLookaheadBars, int retraceLookaheadBars,
        decimal stopBufferPoints, decimal riskRewardMultiple,
        Action<Candle, bool, string, decimal?, decimal?, int?, int?> emit)
    {
        SweepState? pendingSweep = null;
        FvgZone? pendingFvg = null;

        for (var i = start + sweepLookbackBars; i < end; i++)
        {
            var bar = hourlyBars[i];

            if (pendingFvg is { } fvg)
            {
                if (i - fvg.SweepIndex > retraceLookaheadBars + fvgLookaheadBars) { pendingFvg = null; continue; }

                var invalidated = fvg.Bullish ? bar.Close < fvg.Low : bar.Close > fvg.High;
                if (invalidated) { pendingFvg = null; continue; }

                var retraced = fvg.Bullish ? bar.Low <= fvg.High : bar.High >= fvg.Low;
                if (retraced)
                {
                    var sweepBar = hourlyBars[fvg.SweepIndex];
                    var sweptExtreme = fvg.Bullish ? sweepBar.Low : sweepBar.High;
                    var stop = fvg.Bullish ? sweptExtreme - stopBufferPoints : sweptExtreme + stopBufferPoints;
                    var risk = Math.Abs(bar.Close - stop);
                    var target = fvg.Bullish ? bar.Close + riskRewardMultiple * risk : bar.Close - riskRewardMultiple * risk;

                    var (oneMinEntryIndex, oneMinDayEnd) = LocateInOneMinuteBars(oneMinBars, bar.Time);
                    emit(bar, !fvg.Bullish,
                        $"Swept {sweptExtreme:0.##} then retraced into the FVG [{fvg.Low:0.##}-{fvg.High:0.##}] at {bar.Close:0.##} - stop {stop:0.##}, target {target:0.##} (1:{riskRewardMultiple:0.#})",
                        stop, target, oneMinDayEnd, oneMinEntryIndex);
                    pendingFvg = null;
                }
                continue;
            }

            if (pendingSweep is { } sweep)
            {
                if (i - sweep.SweepIndex > fvgLookaheadBars) { pendingSweep = null; continue; }
                if (i < 1) continue;

                var found = sweep.Bullish
                    ? FindGap(hourlyBars, i, bullish: true)
                    : FindGap(hourlyBars, i, bullish: false);
                if (found is { } gap) { pendingFvg = new FvgZone(gap.Bullish, gap.High, gap.Low, sweep.SweepIndex); pendingSweep = null; }
                continue;
            }

            // A rolling channel read only off bars STRICTLY BEFORE this one - never the bar being
            // evaluated itself - same "as of the most recently closed bar" discipline
            // SrFlowSellStrategy's own channel uses.
            decimal recentHigh = hourlyBars[i - sweepLookbackBars].High, recentLow = hourlyBars[i - sweepLookbackBars].Low;
            for (var w = i - sweepLookbackBars + 1; w < i; w++)
            {
                recentHigh = Math.Max(recentHigh, hourlyBars[w].High);
                recentLow = Math.Min(recentLow, hourlyBars[w].Low);
            }

            if (bias == Bias.Bullish && bar.Low <= recentLow - sweepBufferPoints && bar.Close > recentLow)
            {
                pendingSweep = new SweepState(true, bar.Low, i);
            }
            else if (bias == Bias.Bearish && bar.High >= recentHigh + sweepBufferPoints && bar.Close < recentHigh)
            {
                pendingSweep = new SweepState(false, bar.High, i);
            }
        }
    }

    /// <summary>The classic 3-candle fair-value gap, searched forward from the sweep bar (index i is
    /// the CURRENT bar in the outer loop - the middle candle of the 3 is i-1, so this checks
    /// [i-2,i-1,i] as they become available one bar at a time rather than scanning a whole window at
    /// once).</summary>
    private static (bool Bullish, decimal High, decimal Low)? FindGap(IReadOnlyList<Candle> bars, int i, bool bullish)
    {
        if (i < 2) return null;
        var first = bars[i - 2];
        var third = bars[i];
        if (bullish && first.High < third.Low) return (true, third.Low, first.High);
        if (!bullish && first.Low > third.High) return (false, first.Low, third.High);
        return null;
    }

    /// <summary>One bar per IST calendar day from SpotBarsOneMinute - this app has no separate daily
    /// series of its own.</summary>
    private static List<Candle> BuildDailyBars(IReadOnlyList<Candle> oneMinBars)
    {
        var days = new List<Candle>();
        var start = 0;
        while (start < oneMinBars.Count)
        {
            var day = IstClock.IstDate(oneMinBars[start].Time);
            var end = start;
            decimal high = oneMinBars[start].High, low = oneMinBars[start].Low;
            while (end < oneMinBars.Count && IstClock.IstDate(oneMinBars[end].Time) == day)
            {
                high = Math.Max(high, oneMinBars[end].High);
                low = Math.Min(low, oneMinBars[end].Low);
                end++;
            }
            days.Add(new Candle(oneMinBars[start].Time, oneMinBars[start].Open, high, low, oneMinBars[end - 1].Close));
            start = end;
        }
        return days;
    }

    /// <summary>Bullish when the last two CONFIRMED swing highs are rising AND the last two
    /// confirmed swing lows are rising (HH+HL); Bearish when both are falling (LH+LL); otherwise
    /// None. A swing at daily index d needs BOTH neighbors d-1 and d+1 to exist and beat it/be beaten
    /// by it (the standard 3-bar fractal) - and is only usable for a session on calendar day
    /// <paramref name="today"/> once its confirming neighbor (day d+1) closed strictly before
    /// today, so a still-forming or same-day pivot can never leak into today's own bias.</summary>
    private static Bias BiasFor(IReadOnlyList<Candle> dailyBars, DateOnly today)
    {
        var swingHighs = new List<decimal>();
        var swingLows = new List<decimal>();

        for (var d = 1; d < dailyBars.Count - 1; d++)
        {
            var confirmingDay = IstClock.IstDate(dailyBars[d + 1].Time);
            if (confirmingDay >= today) break; // nothing from here on is confirmed yet as of today

            if (dailyBars[d].High > dailyBars[d - 1].High && dailyBars[d].High > dailyBars[d + 1].High)
                swingHighs.Add(dailyBars[d].High);
            if (dailyBars[d].Low < dailyBars[d - 1].Low && dailyBars[d].Low < dailyBars[d + 1].Low)
                swingLows.Add(dailyBars[d].Low);
        }

        if (swingHighs.Count < 2 || swingLows.Count < 2) return Bias.None;

        var risingHighs = swingHighs[^1] > swingHighs[^2];
        var risingLows = swingLows[^1] > swingLows[^2];
        if (risingHighs && risingLows) return Bias.Bullish;
        if (!risingHighs && !risingLows) return Bias.Bearish;
        return Bias.None;
    }

    /// <summary>Maps a hourly bar's own bucket-start Time onto SpotBarsOneMinute's index range for
    /// that SAME calendar day - what FindSpotExit needs to walk forward in native 1-minute
    /// resolution instead of the coarser hourly one, for the same finer-grained fill precision
    /// BacktestStrategyContext.SpotBarsOneMinute's own doc comment describes.</summary>
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

    /// <summary>Same conservative "check the stop first" convention as
    /// OrbOrderBlockStrategy.FindSpotExit - see that method's own doc comment.</summary>
    private static (DateTimeOffset Time, string Reason)? FindSpotExit(
        IReadOnlyList<Candle> bars, int entryIndex, int dayEndExclusive, bool bearish, decimal stop, decimal target)
    {
        for (var i = entryIndex + 1; i < dayEndExclusive; i++)
        {
            var bar = bars[i];
            var stopHit = bearish ? bar.High >= stop : bar.Low <= stop;
            if (stopHit) return (bar.Time, "SweepFvgStop");

            var targetHit = bearish ? bar.Low <= target : bar.High >= target;
            if (targetHit) return (bar.Time, "SweepFvgTarget");
        }
        return null;
    }
}

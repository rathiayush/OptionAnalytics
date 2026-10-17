using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// Spot #101 for the Expired Backtest - the same rule as the scanner's <c>spotFlip</c> (spotEngine.js), on the 1-minute clock:
///  1. the ALERT: the chain's since-open CE - PE OI lines cross (CE - PE going negative = puts added lead = Bullish; positive = Bearish);
///  2. within <c>armMin</c> minutes the spot's <c>emaFast</c> / <c>emaSlow</c> on <c>emaTf</c>-minute candles cross the trade's way - the
///     entry is taken when THAT candle closes (emaMode: crossed on the candle that just closed, or already in direction too);
/// Nothing else is asked.
/// The chain is the expired-option strike band the run fetched (ATM +/- 10 strikes), each ABSOLUTE strike read from its first bar of the
/// day, so the lines are an approximation of the scanner's whole-chain read. OI is read from the minute before the clock (finished
/// minutes only). A 20-minute cooldown per side. The option leaves by the simulator's premium rules and the index stop-loss / target
/// (spot, in ATR) - the earliest wins. No trailing stop.
/// </summary>
public sealed class SpotFlipStrategy : IBacktestStrategy
{
    public string Key => "spot-flip";
    public string Name => "Spot #101: CE / PE since-open crossover -> spot EMA crossover";
    public string Description => "Alert: the since-open CE - PE lines cross. Then the spot's 3-minute EMA crosses the same way; the entry is taken when that candle closes. Nothing else is asked; leaves on the index stop / target.";

    private const int CooldownMinutes = 20;
    private const decimal EmaCross = 0, EmaState = 1;
    private const decimal ModeOff = 0, ModeState = 1, ModeCross = 2; // EmaAgrees modes

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.StopLossParameter(),
        OptionTradeSimulator.TakeProfitParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        // As the scanner: no entry before 09:30 (570), and its time stop of 330 minutes (in bars of the page's timeframe, see DefaultsForTimeframe).
        OptionTradeSimulator.SignalStartTimeParameter() with { Default = 570 },
        OptionTradeSimulator.ExcludeLastDaysParameter(),
        OptionTradeSimulator.MaxHoldingTimeParameter() with { Default = 330 },
        new BacktestParameterSpec("armMin", "After the CE - PE crossover (the alert) wait for the spot EMA crossover for at most (minutes)", Default: 30, Min: 1, Max: 120, Step: 1),
        new BacktestParameterSpec("emaTf", "Spot EMA candle (minutes) - the entry is taken when the crossover candle closes", Default: 3, Min: 1, Max: 15, Step: 1),
        new BacktestParameterSpec("emaFast", "EMA fast (candles)", Default: 7, Min: 2, Max: 50, Step: 1),
        new BacktestParameterSpec("emaSlow", "EMA slow (candles)", Default: 21, Min: 3, Max: 100, Step: 1),
        new BacktestParameterSpec("emaMode", "Spot EMA", Default: EmaCross, Min: EmaCross, Max: EmaState, Step: 1, Options: new[]
        {
            new BacktestParameterOption(EmaCross, "Crossed on the candle that just closed"),
            new BacktestParameterOption(EmaState, "Already in direction counts too"),
        }),
        new BacktestParameterSpec("lastEntryMinutes", "No entries after (IST time)", Default: 885, Min: 0, Max: 1439, Step: 1),
        new BacktestParameterSpec("indexExit", "Leave on the index stop / target (spot) too (1 = yes)", Default: 1, Min: 0, Max: 1, Step: 1),
        new BacktestParameterSpec("stopAtr", "Index stop-loss (x ATR)", Default: 1.5m, Min: 0.5m, Max: 5, Step: 0.25m),
        new BacktestParameterSpec("targetAtr", "Index target (x ATR)", Default: 3, Min: 0.5m, Max: 10, Step: 0.25m),
    };

    /// <summary>The scanner's 330-minute time stop is bars of the page's timeframe here (330 on 1-minute bars, 110 on 3-minute ...), and the
    /// premium stop / target scale with the timeframe like every strategy's.</summary>
    public IReadOnlyDictionary<string, decimal> DefaultsForTimeframe(int timeframeMinutes)
    {
        var scale = OptionTradeSimulator.TimeframeScale(timeframeMinutes);
        return new Dictionary<string, decimal>
        {
            ["slPoints"] = 10m * scale,
            ["tpPoints"] = 20m * scale,
            ["maxHoldingBars"] = Math.Round(330m / Math.Max(1, timeframeMinutes)),
        };
    }

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var (entries, _, exits) = Evaluate(context, parameters);
        return OptionTradeSimulator.Run(context, entries, parameters, signalExits: exits.Count > 0 ? exits : null);
    }

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

    /// <summary>Whether a fast / slow EMA pair of <paramref name="closes"/> is with a trade (sign +1: should rise with it, -1: fall):
    /// state = the fast is on the trade's side of the slow; cross = it got there within the last crossBars candles; off = not asked.</summary>
    internal static bool EmaAgrees(IReadOnlyList<decimal> closes, int fast, int slow, decimal mode, int crossBars, int sign)
    {
        if (mode == ModeOff) return true;
        if (slow <= fast || closes.Count < slow) return false;
        var f = EmaAll(closes, fast); var sl = EmaAll(closes, slow);
        var n = closes.Count;
        if (sign * (f[n - 1]!.Value - sl[n - 1]!.Value) <= 0) return false;
        if (mode != ModeCross) return true;
        for (var i = Math.Max(0, n - 1 - crossBars); i < n - 1; i++)
            if (f[i] is { } a && sl[i] is { } b && sign * (a - b) <= 0) return true;
        return false;
    }

    private static decimal AvgRange(IReadOnlyList<Candle> bars, DateTimeOffset upTo)
    {
        decimal sum = 0; var n = 0;
        for (var i = bars.Count - 1; i >= 0 && n < 14; i--)
        {
            if (bars[i].Time > upTo) continue;
            sum += bars[i].High - bars[i].Low; n++;
        }
        return n == 0 ? 0 : sum / n;
    }


    private static decimal?[] EmaAll(IReadOnlyList<decimal> v, int period)
    {
        var o = new decimal?[v.Count];
        if (v.Count < period) return o;
        var e = v.Take(period).Average(); o[period - 1] = e;
        var k = 2m / (period + 1);
        for (var i = period; i < v.Count; i++) { e = v[i] * k + e * (1 - k); o[i] = e; }
        return o;
    }

    private sealed class StrikeSeries
    {
        public readonly List<(DateTimeOffset Time, long Oi)> Points = new();
        public long? At(DateTimeOffset t)
        {
            var lo = 0; var hi = Points.Count - 1; var found = -1;
            while (lo <= hi) { var mid = (lo + hi) / 2; if (Points[mid].Time <= t) { found = mid; lo = mid + 1; } else hi = mid - 1; }
            return found < 0 ? null : Points[found].Oi;
        }
        public long? OpenOf(DateOnly day)
        {
            foreach (var p in Points) { var d = IstClock.IstDate(p.Time); if (d == day) return p.Oi; if (d > day) break; }
            return null;
        }
    }

    private static Dictionary<decimal, StrikeSeries> SeriesOf(IReadOnlyList<OiIvPoint> band, int step)
    {
        var map = new Dictionary<decimal, StrikeSeries>();
        foreach (var p in band)
        {
            if (p.Strike is not { } k || p.OpenInterest is not { } oi) continue;
            var key = Math.Round(k / step) * step;
            if (!map.TryGetValue(key, out var s)) map[key] = s = new StrikeSeries();
            if (s.Points.Count == 0 || s.Points[^1].Time < p.Time) s.Points.Add((p.Time, oi));
        }
        return map;
    }

    private static decimal? Ema(IReadOnlyList<decimal> closes, int period)
    {
        if (closes.Count < period) return null;
        var e = closes.Take(period).Average();
        var k = 2m / (period + 1);
        for (var i = period; i < closes.Count; i++) e = closes[i] * k + e * (1 - k);
        return e;
    }


    internal (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals, Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)> Exits) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> p)
    {
        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();
        var exits = new Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)>();
        var armMin = Math.Max(1, (int)p["armMin"]);
        var emaTf = Math.Max(1, (int)p["emaTf"]);
        var emaFast = Math.Max(2, (int)p["emaFast"]);
        var emaSlow = Math.Max(emaFast + 1, (int)p["emaSlow"]);
        var emaMode = p.GetValueOrDefault("emaMode", EmaCross) >= 0.5m ? 1m : 2m; // EmaAgrees: 1 = state, 2 = cross
        var signalStart = (int)p.GetValueOrDefault("signalStartMinutes", 570);
        var lastEntry = (int)p.GetValueOrDefault("lastEntryMinutes", 885);
        var indexExit = p.GetValueOrDefault("indexExit", 1m) >= 0.5m;
        var stopAtr = p.GetValueOrDefault("stopAtr", 1.5m);
        var targetAtr = p.GetValueOrDefault("targetAtr", 3m);
        var step = Math.Max(1, context.Step);

        var ce = SeriesOf(context.CeOiIvBand, step);
        var pe = SeriesOf(context.PeOiIvBand, step);
        var bars = context.SpotBarsOneMinute;
        if (ce.Count == 0 || pe.Count == 0 || bars.Count == 0) return (entries, signals, exits);

        var one = TimeSpan.FromMinutes(1);
        var openCache = new Dictionary<(DateOnly, bool, decimal), long?>();
        long? OpenAt(DateOnly day, bool call, decimal strike, StrikeSeries s)
        {
            if (!openCache.TryGetValue((day, call, strike), out var v)) openCache[(day, call, strike)] = v = s.OpenOf(day);
            return v;
        }

        // The chain's since-open CE - PE share at the finished minute before `clock`: > 0 calls added more (bearish), < 0 puts (bullish).
        decimal? LeadAt(DateTimeOffset clock)
        {
            var t = clock - one; var day = IstClock.IstDate(t);
            decimal chgCe = 0, chgPe = 0, now = 0;
            foreach (var (k, s) in ce) { if (s.At(t) is { } n && OpenAt(day, true, k, s) is { } o) { chgCe += n - o; now += n; } }
            foreach (var (k, s) in pe) { if (s.At(t) is { } n && OpenAt(day, false, k, s) is { } o) { chgPe += n - o; now += n; } }
            return now > 0 ? (chgCe - chgPe) / now : null;
        }
        var lastFire = new Dictionary<int, DateTimeOffset>();
        var dayCloses = new List<decimal>();
        var inBucket = 0;
        DateOnly curDay = default;
        foreach (var bar in bars)
        {
            var day = IstClock.IstDate(bar.Time);
            if (day != curDay) { curDay = day; dayCloses.Clear(); inBucket = 0; }
            // A candle counts once all its minutes are in; the entry is taken at the close of one.
            var candleClosed = false;
            if (++inBucket == emaTf) { dayCloses.Add(bar.Close); inBucket = 0; candleClosed = true; }
            if (!candleClosed) continue;
            var clock = bar.Time + one;
            var minute = IstClock.MinutesOfDay(clock);
            if (minute < signalStart || minute > lastEntry) continue;
            if (LeadAt(clock) is not { } now) continue;

            foreach (var dir in new[] { 1, -1 })
            {
                var name = dir > 0 ? "Bullish" : "Bearish";
                // (2) the spot's EMA crossing the trade's way on the candle that just closed (or already that way)
                if (!EmaAgrees(dayCloses, emaFast, emaSlow, emaMode, 1, dir)) continue;
                // (1) the since-open CE - PE lines crossed to this side within the last armMin minutes, and are still there
                if (!(dir * now < 0)) continue;
                DateTimeOffset? crossedAt = null;
                for (var k = 1; k <= armMin; k++)
                {
                    if (LeadAt(clock - TimeSpan.FromMinutes(k)) is not { } before) break;
                    if (dir * before >= 0) { crossedAt = clock - TimeSpan.FromMinutes(k - 1); break; }
                }
                if (crossedAt is null) continue;
                var fast = Ema(dayCloses, emaFast)!.Value; var slow = Ema(dayCloses, emaSlow)!.Value;
                var detail = $"CE-PE since open crossed at {IstClock.FormatMinutesOfDay(IstClock.MinutesOfDay(crossedAt.Value))} ({now:P2} of the chain); EMA {emaFast}/{emaSlow} {fast:0.0}/{slow:0.0}";
                if (lastFire.TryGetValue(dir, out var last) && clock - last < TimeSpan.FromMinutes(CooldownMinutes))
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", name, $"Crossover candle closed, but in the {CooldownMinutes}-minute cooldown - {detail}"));
                    continue;
                }
                lastFire[dir] = clock;
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", name, detail));
                entries.Add((bar.Time, name));
                if (!indexExit) continue;
                // The trade's exit in the index (spot): its stop-loss and target, the first.
                var atr = Math.Max(AvgRange(bars, bar.Time), bar.Close * 0.0004m);
                var stop = bar.Close - dir * stopAtr * atr;
                var target = bar.Close + dir * targetAtr * atr;
                foreach (var later in bars.Where(x => x.Time > bar.Time && IstClock.IstDate(x.Time) == day))
                {
                    if (dir > 0 ? later.Low <= stop : later.High >= stop) { exits[bar.Time] = (later.Time, "Index stop-loss"); break; }
                    if (dir > 0 ? later.High >= target : later.Low <= target) { exits[bar.Time] = (later.Time, "Index target"); break; }
                }
            }
        }

        return (entries, signals.OrderByDescending(x => x.TimeUtc).ToList(), exits);
    }

}

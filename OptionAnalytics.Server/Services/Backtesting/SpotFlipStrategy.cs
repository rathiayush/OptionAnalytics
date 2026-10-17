using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services.Backtesting;

/// <summary>
/// Spot #101 "CE / PE flip" for the Expired Backtest - the same rule as the scanner's <c>spotFlip</c> (spotEngine.js),
/// walked on the 1-minute clock:
///  - the chain's since-open CE - PE OI change (as a share of the chain's OI) changes sign within <c>flipTf</c> minutes
///    (CE - PE going negative = puts added now lead = Bullish; going positive = Bearish);
///  - the spot's <c>emaFast</c> / <c>emaSlow</c> on <c>emaTf</c>-minute candles (a candle counts once all its minutes are in) agree;
///  - the CE / PE OI change over the last <c>deltaMin</c> minutes is with the trade;
///  - the PE vs CE OI within ATM +/- <c>nearStrikes</c> strikes sits with it (support heavier for Bullish, resistance for Bearish).
/// The chain is the expired-option strike band the run fetched (ATM +/- 10 strikes), each ABSOLUTE strike read from its
/// first bar of the day, so the lead is an approximation of the scanner's whole-chain read, not the same number. OI is read
/// from the minute before the clock (finished minutes only). A 20-minute cooldown per side, like the scanner.
/// The option leaves by the simulator's premium stop / target / square-off, and (exitOnFlipBack) when the lead flips back.
/// The index (spot) stop-loss, target and trailing stop (points per index, x ATR or in R) leave it too - the earliest wins.
/// </summary>
public sealed class SpotFlipStrategy : IBacktestStrategy
{
    public string Key => "spot-flip";
    public string Name => "Spot #101: CE / PE since-open flip + EMA + CE/PE change + ATM walls";
    public string Description => "Enters when the chain's since-open CE - PE OI change flips sign, the spot's fast/slow EMA agree, the last few minutes' CE/PE OI change and the OI walls round the ATM are with the trade; leaves on the stop / target or when the flip comes back.";

    private const int CooldownMinutes = 20;
    private const decimal ModeOff = 0, ModeState = 1, ModeCross = 2;
    private const decimal TrailOff = 0, TrailPoints = 1, TrailAtr = 2, TrailR = 3;

    private static BacktestParameterOption[] ModeOptions(string state, string cross) => new[]
    {
        new BacktestParameterOption(ModeOff, "Not asked"),
        new BacktestParameterOption(ModeState, state),
        new BacktestParameterOption(ModeCross, cross),
    };

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

    private static (decimal? Start, decimal? Gap) TrailPointsOf(string underlying, decimal mode, IReadOnlyDictionary<string, decimal> p, decimal atr, decimal stopPts)
    {
        if (mode == TrailOff) return (null, null);
        if (mode == TrailAtr) return (p.GetValueOrDefault("trailStartAtr", 1m) * atr, p.GetValueOrDefault("trailGapAtr", 1m) * atr);
        if (mode == TrailR) return (p.GetValueOrDefault("trailStartR", 1m) * stopPts, p.GetValueOrDefault("trailGapR", 1m) * stopPts);
        var own = underlying.ToUpperInvariant() switch { "BANKNIFTY" => 20m, "SENSEX" => 30m, _ => 10m };
        var start = p.GetValueOrDefault("trailStartPts", 0m); var gap = p.GetValueOrDefault("trailGapPts", 0m);
        return (start > 0 ? start : own, gap > 0 ? gap : own);
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

    public IReadOnlyList<BacktestParameterSpec> Parameters { get; } = new[]
    {
        OptionTradeSimulator.SideParameter(),
        OptionTradeSimulator.StrikeOffsetParameter(),
        OptionTradeSimulator.StopLossParameter(),
        OptionTradeSimulator.TakeProfitParameter(),
        OptionTradeSimulator.SquareOffTimeParameter(),
        OptionTradeSimulator.SignalStartTimeParameter(),
        OptionTradeSimulator.ExcludeLastDaysParameter(),
        OptionTradeSimulator.MaxHoldingTimeParameter(),
        new BacktestParameterSpec("trigger", "Entry trigger", Default: 1, Min: 0, Max: 1, Step: 1, Options: new[]
        {
            new BacktestParameterOption(1, "Fresh spot EMA crossover, with the OI behind it"),
            new BacktestParameterOption(0, "The since-open CE - PE flip"),
        }),
        new BacktestParameterSpec("minLeadPct", "Crossover trigger: since-open CE - PE must lean with the trade by at least (% of the chain) - less is a sideways OI market", Default: 0.3m, Min: 0, Max: 20, Step: 0.1m),
        new BacktestParameterSpec("flipTf", "CE-PE flip window (minutes)", Default: 1, Min: 1, Max: 60, Step: 1),
        new BacktestParameterSpec("emaTf", "EMA candle size (minutes)", Default: 3, Min: 1, Max: 15, Step: 1),
        new BacktestParameterSpec("emaMode", "Spot EMA (the crossover trigger always asks a fresh crossover)", Default: ModeCross, Min: ModeOff, Max: ModeCross, Step: 1, Options: ModeOptions("Already in direction (fast over/under slow)", "Fresh crossover within the candles below")),
        new BacktestParameterSpec("crossBars", "A fresh crossover happened within the last (candles) - spot and ATM option EMAs", Default: 2, Min: 1, Max: 20, Step: 1),
        new BacktestParameterSpec("vwapMode", "VWAP", Default: 0, Min: 0, Max: 1, Step: 1, Options: new[]
        {
            new BacktestParameterOption(0, "Not asked"),
            new BacktestParameterOption(1, "Spot above VWAP for a long, below for a short"),
        }),
        new BacktestParameterSpec("optEmaMode", "ATM option EMAs (CE / PE premium) - they may be aligned already", Default: ModeState, Min: ModeOff, Max: ModeCross, Step: 1, Options: ModeOptions("Already in direction", "Fresh crossover")),
        new BacktestParameterSpec("optEmaLegs", "ATM option EMAs: legs", Default: 1, Min: 0, Max: 1, Step: 1, Options: new[]
        {
            new BacktestParameterOption(0, "The leg traded (CE for a long, PE for a short)"),
            new BacktestParameterOption(1, "Both: traded leg rising, the other falling"),
        }),
        new BacktestParameterSpec("optEmaFast", "ATM option EMA fast (candles)", Default: 7, Min: 2, Max: 50, Step: 1),
        new BacktestParameterSpec("optEmaSlow", "ATM option EMA slow (candles)", Default: 21, Min: 3, Max: 100, Step: 1),
        new BacktestParameterSpec("emaFast", "Fast EMA (candles)", Default: 7, Min: 2, Max: 50, Step: 1),
        new BacktestParameterSpec("emaSlow", "Slow EMA (candles)", Default: 21, Min: 3, Max: 100, Step: 1),
        new BacktestParameterSpec("deltaMin", "CE/PE OI change over the last (minutes)", Default: 10, Min: 3, Max: 15, Step: 1),
        new BacktestParameterSpec("nearStrikes", "OI walls: ATM +/- strikes", Default: 2, Min: 1, Max: 5, Step: 1),
        new BacktestParameterSpec("lastEntryMinutes", "No entries after (IST time)", Default: 885, Min: 0, Max: 1439, Step: 1),
        new BacktestParameterSpec("indexExit", "Leave on the index stop / target / trailing stop (spot) too (1 = yes)", Default: 1, Min: 0, Max: 1, Step: 1),
        new BacktestParameterSpec("stopAtr", "Index stop-loss (x ATR)", Default: 1.5m, Min: 0.5m, Max: 5, Step: 0.25m),
        new BacktestParameterSpec("targetAtr", "Index target (x ATR)", Default: 3, Min: 0.5m, Max: 10, Step: 0.25m),
        new BacktestParameterSpec("trailMode", "Trailing stop on the index", Default: TrailPoints, Min: TrailOff, Max: TrailR, Step: 1, Options: new[]
        {
            new BacktestParameterOption(TrailOff, "No trailing stop"),
            new BacktestParameterOption(TrailPoints, "Fixed points (this index: NIFTY 10 / BANKNIFTY 20 / SENSEX 30, or the points below)"),
            new BacktestParameterOption(TrailAtr, "Dynamic: x the ATR"),
            new BacktestParameterOption(TrailR, "In R: x the stop distance (0.5R, 1R ...)"),
        }),
        new BacktestParameterSpec("trailStartPts", "Points: trailing starts after (0 = this index's own)", Default: 0, Min: 0, Max: 1500, Step: 1),
        new BacktestParameterSpec("trailGapPts", "Points: stays this far behind (0 = this index's own)", Default: 0, Min: 0, Max: 1500, Step: 1),
        new BacktestParameterSpec("trailStartAtr", "ATR: trailing starts after (x ATR)", Default: 1, Min: 0.2m, Max: 10, Step: 0.1m),
        new BacktestParameterSpec("trailGapAtr", "ATR: stays this far behind (x ATR)", Default: 1, Min: 0.2m, Max: 10, Step: 0.1m),
        new BacktestParameterSpec("trailStartR", "R: trailing starts after (x the stop distance)", Default: 1, Min: 0.25m, Max: 5, Step: 0.25m),
        new BacktestParameterSpec("trailGapR", "R: stays this far behind (x the stop distance)", Default: 1, Min: 0.25m, Max: 5, Step: 0.25m),
        new BacktestParameterSpec("emaWarm", "EMAs: carry the previous day's candles over (1 = yes)", Default: 0, Min: 0, Max: 1, Step: 1),
        new BacktestParameterSpec("exitOnFlipBack", "Leave when the CE-PE flip comes back (1 = yes)", Default: 1, Min: 0, Max: 1, Step: 1),
    };

    public IReadOnlyList<BacktestTrade> Simulate(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters)
    {
        var (entries, _, exits) = Evaluate(context, parameters);
        return OptionTradeSimulator.Run(context, entries, parameters, signalExits: exits.Count > 0 ? exits : null);
    }

    public IReadOnlyList<BacktestSignal> EntrySignals(BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> parameters) =>
        Evaluate(context, parameters).Signals;

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
        var flipTf = Math.Max(1, (int)p["flipTf"]);
        var emaTf = Math.Max(1, (int)p["emaTf"]);
        var crossTrigger = p.GetValueOrDefault("trigger", 1m) >= 0.5m;
        var minLead = p.GetValueOrDefault("minLeadPct", 0.3m) / 100m;
        var emaMode = crossTrigger ? ModeCross : p.GetValueOrDefault("emaMode", ModeCross);
        var crossBars = Math.Max(1, (int)p.GetValueOrDefault("crossBars", 2));
        var vwapOn = p.GetValueOrDefault("vwapMode", 0) >= 0.5m;
        var optMode = p.GetValueOrDefault("optEmaMode", ModeState);
        var optBoth = p.GetValueOrDefault("optEmaLegs", 1) >= 0.5m;
        var optFast = Math.Max(2, (int)p.GetValueOrDefault("optEmaFast", 7));
        var optSlow = Math.Max(3, (int)p.GetValueOrDefault("optEmaSlow", 21));
        var emaFast = Math.Max(2, (int)p["emaFast"]);
        var emaSlow = Math.Max(emaFast + 1, (int)p["emaSlow"]);
        var deltaMin = Math.Max(1, (int)p["deltaMin"]);
        var nearStrikes = Math.Max(1, (int)p["nearStrikes"]);
        var signalStart = (int)p.GetValueOrDefault("signalStartMinutes", 555);
        var lastEntry = (int)p.GetValueOrDefault("lastEntryMinutes", 885);
        var indexExit = p.GetValueOrDefault("indexExit", 1m) >= 0.5m;
        var stopAtr = p.GetValueOrDefault("stopAtr", 1.5m);
        var targetAtr = p.GetValueOrDefault("targetAtr", 3m);
        var trailMode = p.GetValueOrDefault("trailMode", TrailPoints);
        var emaWarm = p.GetValueOrDefault("emaWarm", 0m) >= 0.5m;
        var exitOnFlipBack = p.GetValueOrDefault("exitOnFlipBack", 1m) >= 0.5m;
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

        // The chain's since-open CE - PE share at the finished minute before `clock`.
        decimal? LeadAt(DateTimeOffset clock)
        {
            var t = clock - one; var day = IstClock.IstDate(t);
            decimal chgCe = 0, chgPe = 0, now = 0;
            foreach (var (k, s) in ce) { if (s.At(t) is { } n && OpenAt(day, true, k, s) is { } o) { chgCe += n - o; now += n; } }
            foreach (var (k, s) in pe) { if (s.At(t) is { } n && OpenAt(day, false, k, s) is { } o) { chgPe += n - o; now += n; } }
            return now > 0 ? (chgCe - chgPe) / now : null;
        }
        // CE / PE OI change over `minutes`, as a share of each side's OI now.
        (decimal? Ce, decimal? Pe) DeltaAt(DateTimeOffset clock, int minutes)
        {
            var t = clock - one; var before = t - TimeSpan.FromMinutes(minutes);
            decimal Side(Dictionary<decimal, StrikeSeries> m)
            {
                decimal chg = 0, now = 0;
                foreach (var (_, s) in m) if (s.At(t) is { } n && s.At(before) is { } b) { chg += n - b; now += n; }
                return now > 0 ? chg / now : decimal.MinValue;
            }
            var c = Side(ce); var q = Side(pe);
            return (c == decimal.MinValue ? null : c, q == decimal.MinValue ? null : q);
        }
        int St(decimal x) => x >= 0.0005m ? 1 : x <= -0.0005m ? -1 : 0;

        var lastFire = new Dictionary<int, DateTimeOffset>();
        var dayCloses = new List<decimal>();
        var candleEnds = new List<DateTimeOffset>();
        var inBucket = 0;
        decimal vwapSum = 0; var vwapCount = 0;
        var optBars = new Dictionary<(decimal, bool), IReadOnlyList<Candle>>();
        IReadOnlyList<Candle> OptBars(decimal strike, bool call)
        {
            if (!optBars.TryGetValue((strike, call), out var b)) optBars[(strike, call)] = b = context.GetOptionBarsOneMinute(strike, call);
            return b;
        }
        // The ATM option's closes at the end of each finished spot candle (the strike ATM now - a snapshot, like the scanner's).
        List<decimal> OptCloses(decimal strike, bool call, DateTimeOffset clock)
        {
            var bs = OptBars(strike, call); var o = new List<decimal>();
            foreach (var end in candleEnds)
            {
                if (end > clock) break;
                Candle? last = null;
                foreach (var c in bs) { if (c.Time + one > end) break; last = c; }
                if (last is { } l && l.Close > 0) o.Add(l.Close);
            }
            return o;
        }
        DateOnly curDay = default;
        foreach (var bar in bars)
        {
            var day = IstClock.IstDate(bar.Time);
            if (day != curDay) { curDay = day; if (!emaWarm) dayCloses.Clear(); candleEnds.Clear(); inBucket = 0; vwapSum = 0; vwapCount = 0; }
            vwapSum += (bar.High + bar.Low + bar.Close) / 3; vwapCount++;
            // A candle counts once all its minutes are in.
            if (++inBucket == emaTf) { dayCloses.Add(bar.Close); candleEnds.Add(bar.Time + one); inBucket = 0; }
            var clock = bar.Time + one;
            var minute = IstClock.MinutesOfDay(clock);
            if (minute < signalStart || minute > lastEntry) continue;
            if (lead(clock) is not { } now) continue;
            var prevLead = crossTrigger ? null : lead(clock - TimeSpan.FromMinutes(flipTf));
            if (!crossTrigger && prevLead is null) continue;
            var prev = prevLead ?? 0m;
            var fast = Ema(dayCloses, emaFast); var slow = Ema(dayCloses, emaSlow);
            if (emaMode != ModeOff && (fast is null || slow is null)) continue;
            var vwap = vwapSum / vwapCount;
            var atm = Math.Round(bar.Close / step) * step;
            decimal ceNear = 0, peNear = 0;
            foreach (var (k, s) in ce) if (Math.Abs(k - atm) <= nearStrikes * step && s.At(clock - one) is { } n) ceNear += n;
            foreach (var (k, s) in pe) if (Math.Abs(k - atm) <= nearStrikes * step && s.At(clock - one) is { } n) peNear += n;
            var (ceD, peD) = DeltaAt(clock, deltaMin);

            foreach (var dir in new[] { 1, -1 })
            {
                var flipped = crossTrigger ? dir * now < -minLead : dir > 0 ? prev >= 0 && now < 0 : prev <= 0 && now > 0;
                if (!flipped) continue;
                var name = dir > 0 ? "Bullish" : "Bearish";
                var emaWith = EmaAgrees(dayCloses, emaFast, emaSlow, emaMode, crossBars, dir);
                var vwapWith = !vwapOn || dir * (bar.Close - vwap) > 0;
                var legWith = optMode == ModeOff || (
                    EmaAgrees(OptCloses(atm, dir > 0, clock), optFast, optSlow, optMode, crossBars, 1)
                    && (!optBoth || EmaAgrees(OptCloses(atm, dir < 0, clock), optFast, optSlow, optMode, crossBars, -1)));
                var deltaWith = ceD is { } a && peD is { } b ? dir * (St(b) - St(a)) : (int?)null;
                var wallsWith = dir > 0 ? peNear > ceNear : ceNear > peNear;
                string detail = $"CE-PE since open {prev:P2} -> {now:P2}; EMA {emaFast}/{emaSlow} {fast:0.0}/{slow:0.0}; VWAP {vwap:0.0}; last {deltaMin} min CE {ceD:P2} / PE {peD:P2}; ATM+-{nearStrikes}: PE {peNear / 1e5m:0.0}L vs CE {ceNear / 1e5m:0.0}L";
                if (!emaWith || !vwapWith || !legWith || deltaWith is null || deltaWith < 1 || !wallsWith || ceNear <= 0 || peNear <= 0)
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", name,
                        $"Flip, but {(!emaWith ? "EMA not with the trade" : !vwapWith ? "VWAP against" : !legWith ? "ATM option EMAs not with the trade" : deltaWith is null or < 1 ? "CE/PE change not with the trade" : "OI walls not with the trade")} - {detail}"));
                    continue;
                }
                if (lastFire.TryGetValue(dir, out var last) && clock - last < TimeSpan.FromMinutes(CooldownMinutes))
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", name, $"Flip, but in the {CooldownMinutes}-minute cooldown - {detail}"));
                    continue;
                }
                lastFire[dir] = clock;
                signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Entry", name, detail));
                entries.Add((bar.Time, name));
                // The trade's exit in the index (spot): its stop, target and trailing stop, and the flip coming back - the first.
                (DateTimeOffset Time, string Reason)? exit = null;
                var atr = Math.Max(AvgRange(bars, bar.Time), bar.Close * 0.0004m);
                var stopPts = stopAtr * atr;
                var targetPts = targetAtr * atr;
                var (trailStart, trailGap) = TrailPointsOf(context.Underlying, trailMode, p, atr, stopPts);
                var entryPrice = bar.Close;
                var level = entryPrice - dir * stopPts;
                var best = entryPrice;
                foreach (var later in bars.Where(x => x.Time > bar.Time && IstClock.IstDate(x.Time) == day))
                {
                    if (indexExit)
                    {
                        var stopHit = dir > 0 ? later.Low <= level : later.High >= level;
                        if (stopHit) { exit = (later.Time, level == entryPrice - dir * stopPts ? "Index stop-loss" : "Index trailing stop"); break; }
                        if (dir > 0 ? later.High >= entryPrice + targetPts : later.Low <= entryPrice - targetPts) { exit = (later.Time, "Index target"); break; }
                        // The trailing stop moves after each completed bar and only tightens.
                        best = dir > 0 ? Math.Max(best, later.High) : Math.Min(best, later.Low);
                        if (trailStart is { } ts && trailGap is { } tg && dir * (best - entryPrice) >= ts)
                            level = dir > 0 ? Math.Max(level, best - tg) : Math.Min(level, best + tg);
                    }
                    if (exitOnFlipBack && lead(later.Time + one) is { } l && (dir > 0 ? l >= 0 : l <= 0)) { exit = (later.Time, "CE-PE flipped back"); break; }
                }
                if (exit is { } e) exits[bar.Time] = e;
            }
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList(), exits);

        decimal? lead(DateTimeOffset clock) => LeadAt(clock);
    }
}

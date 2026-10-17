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
/// No trailing stop here - the simulator has none.
/// </summary>
public sealed class SpotFlipStrategy : IBacktestStrategy
{
    public string Key => "spot-flip";
    public string Name => "Spot #101: CE / PE since-open flip + EMA + CE/PE change + ATM walls";
    public string Description => "Enters when the chain's since-open CE - PE OI change flips sign, the spot's fast/slow EMA agree, the last few minutes' CE/PE OI change and the OI walls round the ATM are with the trade; leaves on the stop / target or when the flip comes back.";

    private const int CooldownMinutes = 20;

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
        new BacktestParameterSpec("flipTf", "CE-PE flip window (minutes)", Default: 1, Min: 1, Max: 15, Step: 1),
        new BacktestParameterSpec("emaTf", "EMA candle size (minutes)", Default: 3, Min: 1, Max: 15, Step: 1),
        new BacktestParameterSpec("emaFast", "Fast EMA (candles)", Default: 7, Min: 2, Max: 50, Step: 1),
        new BacktestParameterSpec("emaSlow", "Slow EMA (candles)", Default: 21, Min: 3, Max: 100, Step: 1),
        new BacktestParameterSpec("deltaMin", "CE/PE OI change over the last (minutes)", Default: 10, Min: 3, Max: 15, Step: 1),
        new BacktestParameterSpec("nearStrikes", "OI walls: ATM +/- strikes", Default: 2, Min: 1, Max: 5, Step: 1),
        new BacktestParameterSpec("lastEntryMinutes", "No entries after (IST time)", Default: 885, Min: 0, Max: 1439, Step: 1),
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

    private (List<(DateTimeOffset Time, string Direction)> Entries, List<BacktestSignal> Signals, Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)> Exits) Evaluate(
        BacktestStrategyContext context, IReadOnlyDictionary<string, decimal> p)
    {
        var entries = new List<(DateTimeOffset Time, string Direction)>();
        var signals = new List<BacktestSignal>();
        var exits = new Dictionary<DateTimeOffset, (DateTimeOffset Time, string Reason)>();
        var flipTf = Math.Max(1, (int)p["flipTf"]);
        var emaTf = Math.Max(1, (int)p["emaTf"]);
        var emaFast = Math.Max(2, (int)p["emaFast"]);
        var emaSlow = Math.Max(emaFast + 1, (int)p["emaSlow"]);
        var deltaMin = Math.Max(1, (int)p["deltaMin"]);
        var nearStrikes = Math.Max(1, (int)p["nearStrikes"]);
        var signalStart = (int)p.GetValueOrDefault("signalStartMinutes", 555);
        var lastEntry = (int)p.GetValueOrDefault("lastEntryMinutes", 885);
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
        var inBucket = 0;
        DateOnly curDay = default;
        foreach (var bar in bars)
        {
            var day = IstClock.IstDate(bar.Time);
            if (day != curDay) { curDay = day; dayCloses.Clear(); inBucket = 0; }
            // A candle counts once all its minutes are in.
            if (++inBucket == emaTf) { dayCloses.Add(bar.Close); inBucket = 0; }
            var clock = bar.Time + one;
            var minute = IstClock.MinutesOfDay(clock);
            if (minute < signalStart || minute > lastEntry) continue;
            if (lead(clock) is not { } now || lead(clock - TimeSpan.FromMinutes(flipTf)) is not { } prev) continue;
            var fast = Ema(dayCloses, emaFast); var slow = Ema(dayCloses, emaSlow);
            if (fast is null || slow is null) continue;
            var atm = Math.Round(bar.Close / step) * step;
            decimal ceNear = 0, peNear = 0;
            foreach (var (k, s) in ce) if (Math.Abs(k - atm) <= nearStrikes * step && s.At(clock - one) is { } n) ceNear += n;
            foreach (var (k, s) in pe) if (Math.Abs(k - atm) <= nearStrikes * step && s.At(clock - one) is { } n) peNear += n;
            var (ceD, peD) = DeltaAt(clock, deltaMin);

            foreach (var dir in new[] { 1, -1 })
            {
                var flipped = dir > 0 ? prev >= 0 && now < 0 : prev <= 0 && now > 0;
                if (!flipped) continue;
                var name = dir > 0 ? "Bullish" : "Bearish";
                var emaWith = dir * (fast.Value - slow.Value) > 0;
                var deltaWith = ceD is { } a && peD is { } b ? dir * (St(b) - St(a)) : (int?)null;
                var wallsWith = dir > 0 ? peNear > ceNear : ceNear > peNear;
                string detail = $"CE-PE since open {prev:P2} -> {now:P2}; EMA {emaFast}/{emaSlow} {fast:0.0}/{slow:0.0}; last {deltaMin} min CE {ceD:P2} / PE {peD:P2}; ATM+-{nearStrikes}: PE {peNear / 1e5m:0.0}L vs CE {ceNear / 1e5m:0.0}L";
                if (!emaWith || deltaWith is null || deltaWith < 1 || !wallsWith || ceNear <= 0 || peNear <= 0)
                {
                    signals.Add(new BacktestSignal(context.Underlying, bar.Time, "Rejected", name,
                        $"Flip, but {(!emaWith ? "EMA against" : deltaWith is null or < 1 ? "CE/PE change not with the trade" : "OI walls not with the trade")} - {detail}"));
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
                if (exitOnFlipBack)
                {
                    foreach (var later in bars.Where(x => x.Time > bar.Time && IstClock.IstDate(x.Time) == day))
                    {
                        if (lead(later.Time + one) is { } l && (dir > 0 ? l >= 0 : l <= 0))
                        {
                            exits[bar.Time] = (later.Time, "CE-PE flipped back");
                            break;
                        }
                    }
                }
            }
        }

        return (entries, signals.OrderByDescending(s => s.TimeUtc).ToList(), exits);

        decimal? lead(DateTimeOffset clock) => LeadAt(clock);
    }
}

using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>SpotFlipStrategy (spot #101 for the Expired Backtest): the since-open CE - PE lines cross (the alert), the spot's 3-minute
/// EMA 7 / 21 crosses the trade's way and the entry is at that candle's close, with the cumulative CE / PE change, the S / R OI near the
/// ATM going the trade's way (writers adding / leaving, a big net difference) and the strikes right round the ATM. The same day as the
/// scanner's tests/spot-flip-world.mjs, at 23,000 (step 50): 1-minute bars from 09:15 IST.</summary>
public sealed class SpotFlipStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero); // 09:15 IST
    private const int Minutes = 140;
    private const int Turn = 60;
    private const decimal Axis = 23000;
    private static readonly decimal[] Strikes = { 22800, 22850, 22900, 22950, 23000, 23050, 23100, 23150, 23200 };

    private sealed record Day(bool FarCalls = false, bool BothUp = false, bool NoCross = false, bool CallsStay = false, bool CeHeavy = false, bool SmallNet = false, bool AtmCalls = false, bool NoFlip = false, bool LateTurn = false);

    private static bool Near(decimal k) => Math.Abs(k - Axis) <= 100;

    private static List<Candle> Spot(Day d, bool mirror)
    {
        var turn = d.LateTurn ? Turn + 60 : Turn;
        decimal Base(int m) => Axis - 0.2m * Math.Min(m, Turn) + (d.NoCross ? -0.2m * Math.Max(0, m - Turn) : 1.2m * Math.Max(0, m - turn));
        return Enumerable.Range(0, Minutes).Select(m =>
        {
            var open = Base(m); var close = Base(m + 1);
            if (mirror) { open = 2 * Axis - open; close = 2 * Axis - close; }
            return new Candle(T0.AddMinutes(m), open, Math.Max(open, close) + 1.5m, Math.Min(open, close) - 1.5m, close);
        }).ToList();
    }

    private static decimal CeOi(Day d, decimal k, int m)
    {
        var baseOi = Near(k) && d.CeHeavy ? 4e6m : 2e6m;
        var early = d.BothUp ? 0.0016m : 0.0006m;
        var leave = d.CallsStay ? 0m : 0.003m;
        var rate = d.FarCalls && !Near(k) ? -0.004m : d.AtmCalls ? (Math.Abs(k - Axis) <= 50 ? -0.002m : Near(k) ? 0.012m : leave) : leave;
        return baseOi * (1 + early * Math.Min(m, Turn) - rate * Math.Max(0, m - Turn));
    }

    private static decimal PeOi(Day d, decimal k, int m)
    {
        var baseOi = Near(k) ? (d.CeHeavy ? 2e6m : d.SmallNet ? 2.4e6m : 3.5e6m) : 2e6m;
        return baseOi * (1 + (d.BothUp ? 0.0008m : 0.0002m) * Math.Min(m, Turn) + (d.NoFlip ? 0m : 0.0016m) * Math.Max(0, m - Turn));
    }

    private static BacktestStrategyContext Context(Day d, bool mirror = false)
    {
        var spot = Spot(d, mirror);
        var ce = new List<OiIvPoint>(); var pe = new List<OiIvPoint>();
        foreach (var strike in Strikes)
            for (var m = 0; m < Minutes; m++)
            {
                // The mirror swaps the sides about the axis, as the scanner's fixture does.
                var s = mirror ? 2 * Axis - strike : strike;
                ce.Add(new OiIvPoint(T0.AddMinutes(m), strike, (long)(mirror ? PeOi(d, s, m) : CeOi(d, strike, m)), 12m));
                pe.Add(new OiIvPoint(T0.AddMinutes(m), strike, (long)(mirror ? CeOi(d, s, m) : PeOi(d, strike, m)), 12m));
            }
        return new BacktestStrategyContext
        {
            Underlying = "NIFTY", TimeframeMinutes = 1, Step = 50, SpotBars = spot, SpotBarsOneMinute = spot,
            SpotVolumeBarsOneMinute = Array.Empty<CandleWithVolume>(), ConfluenceSignalsAscending = Array.Empty<BacktestSignal>(),
            AllSignals = Array.Empty<BacktestSignal>(), ObvCeSeries = Array.Empty<ObvPoint>(), ObvPeSeries = Array.Empty<ObvPoint>(),
            CdvCeSeries = Array.Empty<ObvPoint>(), CdvPeSeries = Array.Empty<ObvPoint>(),
            GetOptionBars = (_, _) => Array.Empty<Candle>(), GetOptionBarsOneMinute = (_, _) => Array.Empty<Candle>(),
            AtmCeBars = Array.Empty<Candle>(), AtmPeBars = Array.Empty<Candle>(),
            AtmCeVolumeBars = Array.Empty<CandleWithVolume>(), AtmPeVolumeBars = Array.Empty<CandleWithVolume>(),
            AtmStrike = 23000, CeOiIvBand = ce, PeOiIvBand = pe,
        };
    }

    private static Dictionary<string, decimal> Parameters() => new SpotFlipStrategy().Parameters.ToDictionary(p => p.Key, p => p.Default);

    private static List<BacktestSignal> Entries(Day d, bool mirror = false, Action<Dictionary<string, decimal>>? tweak = null)
    {
        var p = Parameters(); tweak?.Invoke(p);
        return new SpotFlipStrategy().EntrySignals(Context(d, mirror), p).Where(s => s.Kind == "Entry").ToList();
    }

    [Fact]
    public void Long_and_short_enter_when_the_crossover_candle_closes()
    {
        var long_ = Assert.Single(Entries(new Day()));
        Assert.Equal("Bullish", long_.Direction);
        Assert.Equal(0, ((long_.TimeUtc - T0).TotalMinutes + 1) % 3); // the bar that closes a 3-minute candle
        Assert.Contains("crossed at", long_.Summary);
        var short_ = Assert.Single(Entries(new Day(), mirror: true));
        Assert.Equal("Bearish", short_.Direction);
    }

    [Fact]
    public void Not_without_each_key_condition()
    {
        foreach (var d in new[] { new Day(NoCross: true), new Day(NoFlip: true), new Day(CallsStay: true), new Day(CeHeavy: true), new Day(SmallNet: true), new Day(AtmCalls: true), new Day(LateTurn: true) })
            Assert.Empty(Entries(d));
    }

    [Fact]
    public void Each_setting_changes_the_rule()
    {
        Assert.Single(Entries(new Day(LateTurn: true), tweak: p => p["armMin"] = 120));
        Assert.Single(Entries(new Day(SmallNet: true), tweak: p => p["netMinPct"] = 10));
        Assert.Empty(Entries(new Day(), tweak: p => p["netMinPct"] = 40));
        Assert.Single(Entries(new Day(AtmCalls: true), tweak: p => p["atmStrikes"] = 0));
        Assert.Single(Entries(new Day(), tweak: p => p["emaFast"] = 9));
    }

    [Fact]
    public void The_whole_chain_over_the_last_minutes_must_add_on_the_trades_side_and_leave_on_the_other()
    {
        Assert.Empty(Entries(new Day(FarCalls: true)));
        Assert.Single(Entries(new Day(FarCalls: true), tweak: p => p["deltaMin"] = 0));
    }

    [Fact]
    public void The_cumulative_change_only_has_to_be_not_against_the_trade()
    {
        // Both sides up since the open: neither with nor against a long.
        Assert.Single(Entries(new Day(BothUp: true)));
        Assert.Empty(Entries(new Day(BothUp: true), tweak: p => p["cumDelta"] = 1));
        Assert.Single(Entries(new Day(BothUp: true), tweak: p => p["cumDelta"] = 2));
        Assert.Single(Entries(new Day(), tweak: p => p["cumDelta"] = 1));
    }

    [Fact]
    public void The_index_stop_and_target_take_the_trade_out()
    {
        // A fall right after the long entry: out at the index stop-loss.
        var spot = Spot(new Day(), mirror: false);
        var entryBar = 72;
        for (var i = entryBar + 1; i < spot.Count; i++)
        {
            var c = spot[entryBar].Close - 4 * (i - entryBar);
            spot[i] = new Candle(spot[i].Time, c + 4, c + 5, c - 1, c);
        }
        var ctx = Context(new Day());
        var fell = new BacktestStrategyContext
        {
            Underlying = ctx.Underlying, TimeframeMinutes = 1, Step = 50, SpotBars = spot, SpotBarsOneMinute = spot,
            SpotVolumeBarsOneMinute = ctx.SpotVolumeBarsOneMinute, ConfluenceSignalsAscending = ctx.ConfluenceSignalsAscending,
            AllSignals = ctx.AllSignals, ObvCeSeries = ctx.ObvCeSeries, ObvPeSeries = ctx.ObvPeSeries, CdvCeSeries = ctx.CdvCeSeries,
            CdvPeSeries = ctx.CdvPeSeries, GetOptionBars = ctx.GetOptionBars, GetOptionBarsOneMinute = ctx.GetOptionBarsOneMinute,
            AtmCeBars = ctx.AtmCeBars, AtmPeBars = ctx.AtmPeBars, AtmCeVolumeBars = ctx.AtmCeVolumeBars, AtmPeVolumeBars = ctx.AtmPeVolumeBars,
            AtmStrike = 23000, CeOiIvBand = ctx.CeOiIvBand, PeOiIvBand = ctx.PeOiIvBand,
        };
        var (entries, _, exits) = new SpotFlipStrategy().Evaluate(fell, Parameters());
        Assert.Single(entries);
        Assert.Equal("Index stop-loss", exits[entries[0].Time].Reason);
        var off = Parameters(); off["indexExit"] = 0;
        Assert.Empty(new SpotFlipStrategy().Evaluate(fell, off).Exits);
    }

    [Fact]
    public void The_EMA_is_checked_crossed_on_the_last_candle_or_already_in_direction()
    {
        var up = Enumerable.Range(0, 30).Select(i => 100m + i).ToList();
        Assert.True(SpotFlipStrategy.EmaAgrees(up, 3, 7, 1, 1, 1));
        Assert.False(SpotFlipStrategy.EmaAgrees(up, 3, 7, 1, 1, -1));
        Assert.False(SpotFlipStrategy.EmaAgrees(up, 3, 7, 2, 1, 1), "a long-running climb is not a cross on the last candle");
        var turn = Enumerable.Range(0, 20).Select(i => 120m - i).Concat(Enumerable.Range(0, 6).Select(i => 100m + 3 * i)).ToList();
        Assert.True(SpotFlipStrategy.EmaAgrees(turn, 3, 7, 2, 6, 1));
    }

    [Fact]
    public void The_defaults_are_the_scanners_and_every_default_is_inside_its_range_and_options()
    {
        var strategy = new SpotFlipStrategy();
        var d = strategy.Parameters.ToDictionary(x => x.Key, x => x);
        foreach (var x in strategy.Parameters)
        {
            Assert.InRange(x.Default, x.Min, x.Max);
            if (x.Options is { Count: > 0 } o) Assert.Contains(o, option => option.Value == x.Default);
        }
        Assert.Equal(570, d["signalStartMinutes"].Default);   // no entry before 09:30
        Assert.Equal(885, d["lastEntryMinutes"].Default);     // none after 14:45
        Assert.Equal(330, d["maxHoldingBars"].Default);       // its 330-minute time stop
        Assert.Equal(110, strategy.DefaultsForTimeframe(3)["maxHoldingBars"]);
        Assert.Equal(25, d["netMinPct"].Default);
        Assert.Equal(1, d["atmStrikes"].Default);
        Assert.Equal(1.5m, d["stopAtr"].Default);
        Assert.Equal(3m, d["targetAtr"].Default);
        Assert.False(d.ContainsKey("trailMode"), "no trailing stop");
        Assert.Equal(strategy.Parameters.Count, strategy.Parameters.Select(x => x.Key).Distinct().Count());
    }
}

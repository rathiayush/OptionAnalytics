using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>SpotFlipStrategy (spot #101 for the Expired Backtest): the since-open CE - PE flip with the EMAs, the last
/// minutes' CE / PE change and the ATM walls with the trade. 09:15 IST open, 1-minute bars, 5 strikes round 23000.</summary>
public sealed class SpotFlipStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero); // 09:15 IST
    private const int Minutes = 60;
    private const int FlipAt = 40;

    private static List<Candle> Spot(bool rising) =>
        Enumerable.Range(0, Minutes).Select(i =>
        {
            var c = 23000m + (rising ? i : -i);
            return new Candle(T0.AddMinutes(i), c, c + 1, c - 1, c);
        }).ToList();

    private static BacktestStrategyContext Context(List<Candle> spot, long putJump, long callJump)
    {
        var ce = new List<OiIvPoint>(); var pe = new List<OiIvPoint>();
        foreach (var strike in new[] { 22900m, 22950m, 23000m, 23050m, 23100m })
            for (var i = 0; i < Minutes; i++)
            {
                ce.Add(new OiIvPoint(T0.AddMinutes(i), strike, 1_000_000 + (i >= FlipAt ? callJump : 0), 12m));
                pe.Add(new OiIvPoint(T0.AddMinutes(i), strike, 1_000_000 + (i >= FlipAt ? putJump : 0), 12m));
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

    private static Dictionary<string, decimal> Parameters() =>
        new SpotFlipStrategy().Parameters.ToDictionary(p => p.Key, p => p.Default);

    private static Dictionary<string, decimal> Small()
    {
        var p = Parameters();
        p["emaTf"] = 1; p["emaFast"] = 3; p["emaSlow"] = 7; p["deltaMin"] = 3; p["signalStartMinutes"] = 0;
        return p;
    }

    [Fact]
    public void Puts_added_with_a_rising_spot_enters_bullish_on_the_flip_minute()
    {
        var signals = new SpotFlipStrategy().EntrySignals(Context(Spot(true), putJump: 60_000, callJump: 0), Small());
        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal("Bullish", entry.Direction);
        Assert.Equal(T0.AddMinutes(FlipAt), entry.TimeUtc);
    }

    [Fact]
    public void Calls_added_with_a_falling_spot_enters_bearish()
    {
        var signals = new SpotFlipStrategy().EntrySignals(Context(Spot(false), putJump: 0, callJump: 60_000), Small());
        Assert.Equal("Bearish", Assert.Single(signals, s => s.Kind == "Entry").Direction);
    }

    [Fact]
    public void An_EMA_against_the_flip_does_not_enter()
    {
        var signals = new SpotFlipStrategy().EntrySignals(Context(Spot(false), putJump: 60_000, callJump: 0), Small());
        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
    }

    [Fact]
    public void No_OI_change_means_no_flip()
    {
        var signals = new SpotFlipStrategy().EntrySignals(Context(Spot(true), 0, 0), Small());
        Assert.Empty(signals);
    }

    [Fact]
    public void Without_a_OI_band_nothing_fires()
    {
        var ctx = Context(Spot(true), 60_000, 0);
        var empty = new BacktestStrategyContext
        {
            Underlying = ctx.Underlying, TimeframeMinutes = 1, Step = 50, SpotBars = ctx.SpotBars, SpotBarsOneMinute = ctx.SpotBarsOneMinute,
            SpotVolumeBarsOneMinute = ctx.SpotVolumeBarsOneMinute, ConfluenceSignalsAscending = ctx.ConfluenceSignalsAscending,
            AllSignals = ctx.AllSignals, ObvCeSeries = ctx.ObvCeSeries, ObvPeSeries = ctx.ObvPeSeries, CdvCeSeries = ctx.CdvCeSeries,
            CdvPeSeries = ctx.CdvPeSeries, GetOptionBars = ctx.GetOptionBars, GetOptionBarsOneMinute = ctx.GetOptionBarsOneMinute,
            AtmCeBars = ctx.AtmCeBars, AtmPeBars = ctx.AtmPeBars, AtmCeVolumeBars = ctx.AtmCeVolumeBars, AtmPeVolumeBars = ctx.AtmPeVolumeBars,
            AtmStrike = null, CeOiIvBand = Array.Empty<OiIvPoint>(), PeOiIvBand = Array.Empty<OiIvPoint>(),
        };
        Assert.Empty(new SpotFlipStrategy().EntrySignals(empty, Small()));
    }

    [Fact]
    public void The_EMA_can_be_already_in_direction_a_fresh_crossover_or_not_asked()
    {
        var up = Enumerable.Range(0, 30).Select(i => 100m + i).ToList();
        Assert.True(SpotFlipStrategy.EmaAgrees(up, 3, 7, 1, 3, 1));
        Assert.False(SpotFlipStrategy.EmaAgrees(up, 3, 7, 1, 3, -1));
        Assert.False(SpotFlipStrategy.EmaAgrees(up, 3, 7, 2, 3, 1), "a long-running climb is not a fresh cross");
        var turn = Enumerable.Range(0, 20).Select(i => 120m - i).Concat(Enumerable.Range(0, 6).Select(i => 100m + 3 * i)).ToList();
        Assert.True(SpotFlipStrategy.EmaAgrees(turn, 3, 7, 2, 6, 1));
        Assert.True(SpotFlipStrategy.EmaAgrees(up, 3, 7, 0, 3, -1), "not asked");
    }

    [Fact]
    public void EMA_not_asked_lets_a_flip_against_the_trend_through_and_VWAP_can_stop_it()
    {
        var p = Small(); p["emaMode"] = 0;
        var falling = new SpotFlipStrategy().EntrySignals(Context(Spot(false), 60_000, 0), p);
        Assert.Single(falling, s => s.Kind == "Entry");
        p["vwapMode"] = 1; // a falling spot is under its VWAP - a long is stopped
        Assert.DoesNotContain(new SpotFlipStrategy().EntrySignals(Context(Spot(false), 60_000, 0), p), s => s.Kind == "Entry");
        Assert.Single(new SpotFlipStrategy().EntrySignals(Context(Spot(true), 60_000, 0), p), s => s.Kind == "Entry");
    }

    [Fact]
    public void Every_setting_is_a_parameter()
    {
        var keys = new SpotFlipStrategy().Parameters.Select(x => x.Key).ToHashSet();
        foreach (var k in new[] { "flipTf", "emaTf", "emaMode", "crossBars", "emaFast", "emaSlow", "vwapMode", "optEmaMode", "optEmaLegs", "optEmaFast", "optEmaSlow", "deltaMin", "nearStrikes", "lastEntryMinutes", "exitOnFlipBack", "slPoints", "tpPoints" })
            Assert.Contains(k, keys);
    }

    private static List<Candle> RiseThen(int turn, decimal slope) =>
        Enumerable.Range(0, Minutes).Select(i =>
        {
            var c = i <= turn ? 23000m + i : 23000m + turn + slope * (i - turn);
            return new Candle(T0.AddMinutes(i), c, c + 1, c - 1, c);
        }).ToList();

    [Fact]
    public void The_index_stop_takes_the_trade_out_and_a_trailing_stop_follows_a_run()
    {
        var p = Small(); p["exitOnFlipBack"] = 0;
        // A fall right after the entry: out at the index stop-loss.
        var (e1, _, x1) = new SpotFlipStrategy().Evaluate(Context(RiseThen(FlipAt, -3), 60_000, 0), p);
        Assert.Single(e1);
        Assert.Equal("Index stop-loss", x1[e1[0].Time].Reason);
        // A run well past the trailing start, then a fall: out by the trailing stop, not the first stop.
        p["target" + "Atr"] = 10;
        var (e2, _, x2) = new SpotFlipStrategy().Evaluate(Context(RiseThen(FlipAt + 12, -3), 60_000, 0), p);
        Assert.Equal("Index trailing stop", x2[e2[0].Time].Reason);
        // Index exits off: none.
        p["indexExit"] = 0;
        var (e3, _, x3) = new SpotFlipStrategy().Evaluate(Context(RiseThen(FlipAt, -3), 60_000, 0), p);
        Assert.Empty(x3);
        // The trailing stop in R and in ATR is configurable too.
        p["indexExit"] = 1; p["trailMode"] = 3; p["trailStartR"] = 0.5m; p["trailGapR"] = 0.5m;
        var (e4, _, x4) = new SpotFlipStrategy().Evaluate(Context(RiseThen(FlipAt + 12, -3), 60_000, 0), p);
        Assert.Equal("Index trailing stop", x4[e4[0].Time].Reason);
    }
}

using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// Covers FiveEmaObvCrossoverStrategy's one addition over plain FiveEmaStrategy: the OBV(CE)
/// vs OBV(PE) confirmation required at the exact breakout bar. Each series below is a flat
/// plateau (to seed a stable 5 EMA), one alert candle entirely clear of it, then a breakout bar
/// whose high/low crosses the alert candle's - the same shape FiveEmaStrategy itself fires on -
/// so these tests isolate the OBV check rather than re-proving the alert-candle logic.
/// </summary>
public sealed class FiveEmaObvCrossoverStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero);

    /// <summary>10 flat bars at 100 (settles the 5 EMA at exactly 100), then one alert candle
    /// entirely BELOW the EMA (high 95, ema drops to 98), then a breakout bar whose high (99)
    /// clears the alert candle's high (95) - a Bullish/long setup. Breakout lands at index 11.</summary>
    private static List<Candle> BuildBullishBreakoutBars()
    {
        var bars = new List<Candle>();
        var time = T0;
        for (var i = 0; i < 10; i++)
        {
            bars.Add(new Candle(time, 100, 100, 100, 100));
            time = time.AddMinutes(1);
        }
        bars.Add(new Candle(time, 100, 95, 93, 94)); // alert candle - entirely below EMA
        time = time.AddMinutes(1);
        bars.Add(new Candle(time, 94, 99, 93, 97)); // breakout - high clears the alert candle's high
        return bars;
    }

    /// <summary>Same shape, mirrored: alert candle entirely ABOVE the EMA (low 105), then a
    /// breakout bar whose low (101) clears the alert candle's low (105) - a Bearish/short setup.</summary>
    private static List<Candle> BuildBearishBreakoutBars()
    {
        var bars = new List<Candle>();
        var time = T0;
        for (var i = 0; i < 10; i++)
        {
            bars.Add(new Candle(time, 100, 100, 100, 100));
            time = time.AddMinutes(1);
        }
        bars.Add(new Candle(time, 100, 107, 105, 106)); // alert candle - entirely above EMA
        time = time.AddMinutes(1);
        bars.Add(new Candle(time, 106, 108, 101, 103)); // breakout - low clears the alert candle's low
        return bars;
    }

    private static DateTimeOffset BreakoutTime(IReadOnlyList<Candle> bars) => bars[^1].Time;

    private static BacktestStrategyContext Context(
        IReadOnlyList<Candle> spotBars,
        IReadOnlyList<ObvPoint>? obvCe = null,
        IReadOnlyList<ObvPoint>? obvPe = null,
        Func<decimal, bool, IReadOnlyList<Candle>>? getOptionBars = null) => new()
    {
        Underlying = "NIFTY",
        TimeframeMinutes = 1,
        Step = 50,
        SpotBars = spotBars,
        ConfluenceSignalsAscending = Array.Empty<BacktestSignal>(),
        AllSignals = Array.Empty<BacktestSignal>(),
        ObvCeSeries = obvCe ?? Array.Empty<ObvPoint>(),
        ObvPeSeries = obvPe ?? Array.Empty<ObvPoint>(),
        CdvCeSeries = Array.Empty<ObvPoint>(),
        CdvPeSeries = Array.Empty<ObvPoint>(),
        GetOptionBars = getOptionBars ?? ((_, _) => Array.Empty<Candle>()),
    };

    private static Dictionary<string, decimal> Parameters() => new()
    {
        ["side"] = OptionTradeSimulator.SideBuy,
        ["otmSteps"] = 1,
        ["slPoints"] = 10,
        ["tpPoints"] = 20,
        ["squareOffMinutes"] = 930, // 15:30 IST - well after these tests' bars
        ["signalStartMinutes"] = 555,
        ["emaPeriod"] = 5,
        ["direction"] = 0,
        ["alertMaxAgeBars"] = 0,
        ["exitOnEmaTouch"] = 1,
    };

    [Fact]
    public void EntrySignals_BullishBreakoutWithObvCeAboveObvPe_FiresEntry()
    {
        var bars = BuildBullishBreakoutBars();
        var breakoutTime = BreakoutTime(bars);
        var context = Context(bars,
            obvCe: new[] { new ObvPoint(breakoutTime, 500m) },
            obvPe: new[] { new ObvPoint(breakoutTime, 200m) });
        var strategy = new FiveEmaObvCrossoverStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.Contains(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
    }

    [Fact]
    public void EntrySignals_BullishBreakoutWithObvPeAboveObvCe_RejectsInsteadOfEntering()
    {
        var bars = BuildBullishBreakoutBars();
        var breakoutTime = BreakoutTime(bars);
        var context = Context(bars,
            obvCe: new[] { new ObvPoint(breakoutTime, 200m) },
            obvPe: new[] { new ObvPoint(breakoutTime, 500m) });
        var strategy = new FiveEmaObvCrossoverStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish" && s.Summary.Contains("OBV"));
    }

    [Fact]
    public void EntrySignals_BearishBreakoutWithObvPeAboveObvCe_FiresEntry()
    {
        var bars = BuildBearishBreakoutBars();
        var breakoutTime = BreakoutTime(bars);
        var context = Context(bars,
            obvCe: new[] { new ObvPoint(breakoutTime, 200m) },
            obvPe: new[] { new ObvPoint(breakoutTime, 500m) });
        var strategy = new FiveEmaObvCrossoverStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.Contains(signals, s => s.Kind == "Entry" && s.Direction == "Bearish");
    }

    [Fact]
    public void EntrySignals_BearishBreakoutWithObvCeAboveObvPe_RejectsInsteadOfEntering()
    {
        var bars = BuildBearishBreakoutBars();
        var breakoutTime = BreakoutTime(bars);
        var context = Context(bars,
            obvCe: new[] { new ObvPoint(breakoutTime, 500m) },
            obvPe: new[] { new ObvPoint(breakoutTime, 200m) });
        var strategy = new FiveEmaObvCrossoverStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bearish" && s.Summary.Contains("OBV"));
    }

    [Fact]
    public void EntrySignals_BreakoutWithNoObvDataAtAll_RejectsInsteadOfEntering()
    {
        var bars = BuildBullishBreakoutBars();
        var context = Context(bars); // no OBV series at all
        var strategy = new FiveEmaObvCrossoverStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("no OBV data"));
    }

    [Fact]
    public void Simulate_ConfirmedBullishBreakout_ProducesABuyCallTrade()
    {
        var bars = BuildBullishBreakoutBars();
        var breakoutTime = BreakoutTime(bars);
        var optionBars = bars.Select(b => new Candle(b.Time, 50, 55, 45, 50)).ToList();
        var context = Context(bars,
            obvCe: new[] { new ObvPoint(breakoutTime, 500m) },
            obvPe: new[] { new ObvPoint(breakoutTime, 200m) },
            getOptionBars: (_, isCall) => isCall ? optionBars : Array.Empty<Candle>());
        var strategy = new FiveEmaObvCrossoverStrategy();

        var trades = strategy.Simulate(context, Parameters());

        var bullishTrades = trades.Where(t => t.Direction == "Bullish").ToList();
        var trade = Assert.Single(bullishTrades);
        Assert.Equal("Buy", trade.Side);
        Assert.Equal("CE", trade.OptionType);
    }
}

using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// Covers BollingerBandsStrategy's own reasoning - a fresh band touch fires (not every bar still
/// beyond it), Reversion and Breakout modes read the SAME touch as opposite directions, day
/// boundaries reset the band state, and the direction/signal-start filters reject instead of
/// silently dropping a qualifying touch.
/// </summary>
public sealed class BollingerBandsStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero); // 09:30 IST

    /// <summary>10 flat bars at 100 (seeds a 5-SMA with zero variance - the flat window's own
    /// upper/lower bands sit exactly AT 100, at any stdDev multiplier), then TWO bars at a wildly
    /// different level. Whether a single new value entering an otherwise-flat period-5 window
    /// clears the recomputed band depends only on the stdDev multiplier, not on how extreme the new
    /// value is (a flat window's own variance is dominated by the outlier itself, so the two grow
    /// together) - algebraically it clears whenever stdDev &lt; 2, which is why tests use 1.0 rather
    /// than Bollinger's own standard 2.0. Two consecutive bars at the SAME extreme level (rather
    /// than one) is what lets "only the FIRST touch fires" have a second bar to prove itself
    /// against - by the third bar the band has already caught up regardless of the spike's size,
    /// which is also why this fixture stops at two.</summary>
    private static IReadOnlyList<Candle> BuildUpperBandTouchBars(DateTimeOffset? start = null)
    {
        var bars = new List<Candle>();
        var time = start ?? T0;

        for (var i = 0; i < 10; i++)
        {
            bars.Add(new Candle(time, 100, 100, 100, 100));
            time = time.AddMinutes(1);
        }
        for (var i = 0; i < 2; i++)
        {
            bars.Add(new Candle(time, 500, 500, 500, 500));
            time = time.AddMinutes(1);
        }

        return bars;
    }

    /// <summary>The exact mirror of BuildUpperBandTouchBars - two bars at 1 instead of 500,
    /// clearing the lower Bollinger Band instead.</summary>
    private static IReadOnlyList<Candle> BuildLowerBandTouchBars(DateTimeOffset? start = null)
    {
        var bars = new List<Candle>();
        var time = start ?? T0;

        for (var i = 0; i < 10; i++)
        {
            bars.Add(new Candle(time, 100, 100, 100, 100));
            time = time.AddMinutes(1);
        }
        for (var i = 0; i < 2; i++)
        {
            bars.Add(new Candle(time, 1, 1, 1, 1));
            time = time.AddMinutes(1);
        }

        return bars;
    }

    private static BacktestStrategyContext Context(IReadOnlyList<Candle> spotBars, Func<decimal, bool, IReadOnlyList<Candle>>? getOptionBars = null) => new()
    {
        Underlying = "NIFTY",
        TimeframeMinutes = 1,
        Step = 50,
        SpotBars = spotBars,
        ConfluenceSignalsAscending = Array.Empty<BacktestSignal>(),
        AllSignals = Array.Empty<BacktestSignal>(),
        ObvCeSeries = Array.Empty<ObvPoint>(),
        ObvPeSeries = Array.Empty<ObvPoint>(),
        CdvCeSeries = Array.Empty<ObvPoint>(),
        CdvPeSeries = Array.Empty<ObvPoint>(),
        GetOptionBars = getOptionBars ?? ((_, _) => Array.Empty<Candle>()),
        AtmCeBars = Array.Empty<Candle>(),
        AtmPeBars = Array.Empty<Candle>(),
        AtmStrike = null,
    };

    private static Dictionary<string, decimal> Parameters(decimal mode = 0, decimal direction = 0, decimal signalStartMinutes = 555) => new()
    {
        ["side"] = OptionTradeSimulator.SideBuy,
        ["otmSteps"] = 1,
        ["slPoints"] = 10,
        ["tpPoints"] = 20,
        ["period"] = 5,
        ["stdDev"] = 1,
        ["mode"] = mode,
        ["direction"] = direction,
        ["signalStartMinutes"] = signalStartMinutes,
    };

    [Fact]
    public void EntrySignals_ReversionMode_UpperBandTouch_FiresBearishOnlyOnce()
    {
        var context = Context(BuildUpperBandTouchBars());
        var strategy = new BollingerBandsStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        var entries = signals.Where(s => s.Kind == "Entry").ToList();
        var entry = Assert.Single(entries);
        Assert.Equal("Bearish", entry.Direction);
    }

    [Fact]
    public void EntrySignals_ReversionMode_LowerBandTouch_FiresBullish()
    {
        var context = Context(BuildLowerBandTouchBars());
        var strategy = new BollingerBandsStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        var entries = signals.Where(s => s.Kind == "Entry").ToList();
        var entry = Assert.Single(entries);
        Assert.Equal("Bullish", entry.Direction);
    }

    [Fact]
    public void EntrySignals_BreakoutMode_ReadsTheSameUpperTouchAsBullishInstead()
    {
        var context = Context(BuildUpperBandTouchBars());
        var strategy = new BollingerBandsStrategy();

        var signals = strategy.EntrySignals(context, Parameters(mode: 1 /* Breakout */));

        var entries = signals.Where(s => s.Kind == "Entry").ToList();
        var entry = Assert.Single(entries);
        Assert.Equal("Bullish", entry.Direction);
    }

    [Fact]
    public void Simulate_LowerBandTouch_ProducesABuyCallTrade()
    {
        var bars = BuildLowerBandTouchBars();
        var optionBars = bars.Select(b => new Candle(b.Time, 50, 55, 45, 50)).ToList();
        var context = Context(bars, (_, isCall) => isCall ? optionBars : Array.Empty<Candle>());
        var strategy = new BollingerBandsStrategy();

        var trades = strategy.Simulate(context, Parameters());

        var trade = Assert.Single(trades);
        Assert.Equal("Bullish", trade.Direction);
        Assert.Equal("Buy", trade.Side);
        Assert.Equal("CE", trade.OptionType);
    }

    [Fact]
    public void EntrySignals_DirectionFilterExcludesTheOppositeSide_RejectsInsteadOfEntering()
    {
        var context = Context(BuildUpperBandTouchBars());
        var strategy = new BollingerBandsStrategy();

        var signals = strategy.EntrySignals(context, Parameters(direction: 1 /* Bullish only */));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bearish");
    }

    private static readonly DateTimeOffset EarlyStart = new(2026, 1, 5, 3, 0, 0, TimeSpan.Zero); // 08:30 IST

    [Fact]
    public void EntrySignals_TouchBeforeSignalStartTime_RejectsInsteadOfEntering()
    {
        var context = Context(BuildUpperBandTouchBars(EarlyStart));
        var strategy = new BollingerBandsStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("pre-open"));
    }

    [Fact]
    public void EntrySignals_TouchOnANewDay_FiresAgainInsteadOfStayingSuppressed()
    {
        // Two independent days, each with its own upper-band touch - the second day's touch must
        // fire even though the FIRST day's touch left bandState on "Upper", since nothing should
        // carry across the overnight gap.
        var day1 = BuildUpperBandTouchBars(T0);
        var day2Start = new DateTimeOffset(2026, 1, 6, 4, 0, 0, TimeSpan.Zero);
        var day2 = BuildUpperBandTouchBars(day2Start);
        var bars = day1.Concat(day2).ToList();
        var context = Context(bars);
        var strategy = new BollingerBandsStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        var entries = signals.Where(s => s.Kind == "Entry").ToList();
        Assert.Equal(2, entries.Count);
        Assert.All(entries, e => Assert.Equal("Bearish", e.Direction));
    }

    [Fact]
    public void EntrySignals_DeadFlatSeries_NeverFiresOnTheZeroVarianceWindow()
    {
        // A window where every bar printed the SAME price has exactly zero variance, which
        // collapses both bands onto that price - close, upper, and lower all equal. Without the
        // guard for this, "close >= upper" is trivially true the instant the SMA period first has
        // enough bars, firing a spurious signal off a market that has not actually moved at all.
        var bars = new List<Candle>();
        var time = T0;
        for (var i = 0; i < 20; i++)
        {
            bars.Add(new Candle(time, 100, 100, 100, 100));
            time = time.AddMinutes(1);
        }
        var context = Context(bars);
        var strategy = new BollingerBandsStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.Empty(signals);
    }
}

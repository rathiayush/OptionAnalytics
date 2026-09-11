using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// Covers EmaBandRsiAdxStrategy's own reasoning: a clean, sustained trend clears the EMA band with
/// RSI/ADX/DMI all already confirming (fires exactly once, not on every later bar still outside the
/// band), a flat series never breaks the band at all, and the RSI/ADX/direction/pre-open filters
/// reject instead of silently dropping a qualifying breakout - matching every other strategy's own
/// filter tests this session.
///
/// The trend series below is a straight, unbroken 3-point-per-bar ramp with a small consistent
/// daily range (no down bars at all in the uptrend, no up bars at all in the downtrend) - not
/// picked for realism, but because it drives RSI and ADX/DMI to their extreme, unambiguous ends
/// (RSI exactly 100/0, ADX 100 with the losing side's DI at exactly 0) well before the 33 EMA even
/// has enough bars to produce a value, so the very first bar the EMA exists at is already a clean,
/// fully-confirmed breakout - verified empirically against Skender.Stock.Indicators rather than
/// hand-derived, since Wilder's smoothing has no simple closed form.
/// </summary>
public sealed class EmaBandRsiAdxStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero); // 09:30 IST

    // The 33 EMA's first value lands on the 33rd bar (index 32) - by then this ramp has already
    // pushed RSI/ADX/DMI to their extremes, so index 32 is a clean, fully-confirmed breakout.
    private const int BreakoutIndex = 32;

    private static List<Candle> BuildStrongUptrend(int count = 40, DateTimeOffset? start = null)
    {
        var bars = new List<Candle>();
        var time = start ?? T0;
        for (var i = 0; i < count; i++)
        {
            var basePrice = 1000m + i * 3;
            bars.Add(new Candle(time, basePrice, basePrice + 4, basePrice - 1, basePrice + 3));
            time = time.AddMinutes(1);
        }
        return bars;
    }

    private static List<Candle> BuildStrongDowntrend(int count = 40, DateTimeOffset? start = null)
    {
        var bars = new List<Candle>();
        var time = start ?? T0;
        for (var i = 0; i < count; i++)
        {
            var basePrice = 1000m - i * 3;
            bars.Add(new Candle(time, basePrice, basePrice + 1, basePrice - 4, basePrice - 3));
            time = time.AddMinutes(1);
        }
        return bars;
    }

    private static List<Candle> BuildFlat(int count = 60, DateTimeOffset? start = null)
    {
        var bars = new List<Candle>();
        var time = start ?? T0;
        for (var i = 0; i < count; i++)
        {
            bars.Add(new Candle(time, 1000, 1000, 1000, 1000));
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

    private static Dictionary<string, decimal> Parameters(
        decimal direction = 0, decimal signalStartMinutes = 555,
        decimal rsiBullishMin = 50, decimal rsiBearishMax = 50, decimal adxMinimum = 20) => new()
    {
        ["side"] = OptionTradeSimulator.SideBuy,
        ["otmSteps"] = 1,
        ["slPoints"] = 10,
        ["tpPoints"] = 20,
        ["squareOffMinutes"] = 0,
        ["signalStartMinutes"] = signalStartMinutes,
        ["emaPeriod"] = 33,
        ["bandPercent"] = 0.3m,
        ["rsiPeriod"] = 14,
        ["rsiBullishMin"] = rsiBullishMin,
        ["rsiBearishMax"] = rsiBearishMax,
        ["adxPeriod"] = 14,
        ["adxMinimum"] = adxMinimum,
        ["direction"] = direction,
    };

    [Fact]
    public void EntrySignals_StrongUptrend_FiresBullishEntryAtFirstQualifyingBar()
    {
        var bars = BuildStrongUptrend();
        var context = Context(bars);
        var strategy = new EmaBandRsiAdxStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        var entry = Assert.Single(signals);
        Assert.Equal("Entry", entry.Kind);
        Assert.Equal("Bullish", entry.Direction);
        Assert.Equal(bars[BreakoutIndex].Time, entry.TimeUtc);
    }

    [Fact]
    public void EntrySignals_StrongDowntrend_FiresBearishEntryAtFirstQualifyingBar()
    {
        var bars = BuildStrongDowntrend();
        var context = Context(bars);
        var strategy = new EmaBandRsiAdxStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        var entry = Assert.Single(signals);
        Assert.Equal("Entry", entry.Kind);
        Assert.Equal("Bearish", entry.Direction);
        Assert.Equal(bars[BreakoutIndex].Time, entry.TimeUtc);
    }

    [Fact]
    public void EntrySignals_FlatSeries_NeverBreaksTheBand()
    {
        var bars = BuildFlat();
        var context = Context(bars);
        var strategy = new EmaBandRsiAdxStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.Empty(signals);
    }

    [Fact]
    public void EntrySignals_FiresOnlyOnceWhileTheBreakoutContinues()
    {
        var bars = BuildStrongUptrend(); // every bar after the breakout also closes outside the band
        var context = Context(bars);
        var strategy = new EmaBandRsiAdxStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.Single(signals);
    }

    [Fact]
    public void EntrySignals_DirectionFilterExcludesTheOppositeSide_RejectsInsteadOfEntering()
    {
        var bars = BuildStrongUptrend();
        var context = Context(bars);
        var strategy = new EmaBandRsiAdxStrategy();

        var signals = strategy.EntrySignals(context, Parameters(direction: 2 /* shorts only */));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish" && s.Summary.Contains("shorts only"));
    }

    [Fact]
    public void EntrySignals_RsiThresholdImpossiblyHigh_RejectsInsteadOfEntering()
    {
        var bars = BuildStrongUptrend();
        var context = Context(bars);
        var strategy = new EmaBandRsiAdxStrategy();

        // RSI can never exceed 100 - guarantees this veto fires regardless of the exact RSI value,
        // the same "impossible threshold" pattern this app's other filter tests already use.
        var signals = strategy.EntrySignals(context, Parameters(rsiBullishMin: 101));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("RSI"));
    }

    [Fact]
    public void EntrySignals_AdxMinimumImpossiblyHigh_RejectsInsteadOfEntering()
    {
        var bars = BuildStrongUptrend();
        var context = Context(bars);
        var strategy = new EmaBandRsiAdxStrategy();

        // ADX can never exceed 100 - same reasoning as the RSI test above.
        var signals = strategy.EntrySignals(context, Parameters(adxMinimum: 101));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("ADX"));
    }

    private static readonly DateTimeOffset EarlyStart = new(2026, 1, 5, 3, 0, 0, TimeSpan.Zero); // 08:30 IST

    [Fact]
    public void EntrySignals_QualifyingBreakoutBeforeSignalStartTime_RejectsInsteadOfEntering()
    {
        var bars = BuildStrongUptrend(start: EarlyStart); // breakout lands at 09:02 IST, before the 09:15 default cutoff
        var context = Context(bars);
        var strategy = new EmaBandRsiAdxStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("pre-open"));
    }

    [Fact]
    public void Simulate_ConfirmedBullishBreakout_ProducesABuyCallTrade()
    {
        var bars = BuildStrongUptrend();
        var optionBars = bars.Select(b => new Candle(b.Time, 50, 55, 45, 50)).ToList();
        var context = Context(bars, getOptionBars: (_, isCall) => isCall ? optionBars : Array.Empty<Candle>());
        var strategy = new EmaBandRsiAdxStrategy();

        var trades = strategy.Simulate(context, Parameters());

        var trade = Assert.Single(trades);
        Assert.Equal("Bullish", trade.Direction);
        Assert.Equal("Buy", trade.Side);
        Assert.Equal("CE", trade.OptionType);
    }
}

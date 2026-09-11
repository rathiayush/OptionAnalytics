using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// Covers MacdCrossoverStrategy's own reasoning - firing on a real MACD/Signal crossover, the
/// histogram-strength filter, and the direction/signal-start filters. Uses small custom
/// fast/slow/signal periods (3/6/2) rather than the famous 12/26/9 default so a clear reversal fits
/// in a short, hand-verifiable bar series - the crossover MATH is identical at any period, and the
/// real 12/26/9 default is covered by the live-API smoke test instead of needing a much longer
/// fixture here.
/// </summary>
public sealed class MacdCrossoverStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero); // 09:30 IST

    /// <summary>20 bars declining 100 -> 81, then 15 bars rallying sharply to 186 - strong enough
    /// that MACD (fast EMA minus slow EMA) crosses back above its own Signal line partway through.
    /// At fastPeriod=3/slowPeriod=6/signalPeriod=2 this produces exactly one crossover (Bullish) -
    /// MACD is already above Signal from the very first bar both have a value, so unlike the plain
    /// price-crossover strategies in this app there is no separate initial "Bearish" event to key
    /// tests off first.</summary>
    private static IReadOnlyList<Candle> BuildReversalBars(DateTimeOffset? start = null)
    {
        var bars = new List<Candle>();
        var time = start ?? T0;
        var price = 100m;

        for (var i = 0; i < 20; i++)
        {
            bars.Add(new Candle(time, price, price, price, price));
            time = time.AddMinutes(1);
            price -= 1;
        }
        for (var i = 0; i < 15; i++)
        {
            price += 7;
            bars.Add(new Candle(time, price, price, price, price));
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
        AtmCeVolumeBars = Array.Empty<CandleWithVolume>(),
        AtmPeVolumeBars = Array.Empty<CandleWithVolume>(),
        AtmStrike = null,
    };

    private static Dictionary<string, decimal> Parameters(decimal minHistogram = 0, decimal direction = 0, decimal signalStartMinutes = 555) => new()
    {
        ["side"] = OptionTradeSimulator.SideBuy,
        ["otmSteps"] = 1,
        ["slPoints"] = 10,
        ["tpPoints"] = 20,
        ["fastPeriod"] = 3,
        ["slowPeriod"] = 6,
        ["signalPeriod"] = 2,
        ["minHistogram"] = minHistogram,
        ["direction"] = direction,
        ["signalStartMinutes"] = signalStartMinutes,
    };

    [Fact]
    public void EntrySignals_SharpReversal_FiresBullishEntry()
    {
        var context = Context(BuildReversalBars());
        var strategy = new MacdCrossoverStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal("Bullish", entry.Direction);
    }

    [Fact]
    public void Simulate_SharpReversal_ProducesABuyCallTrade()
    {
        var bars = BuildReversalBars();
        var optionBars = bars.Select(b => new Candle(b.Time, 50, 55, 45, 50)).ToList();
        var context = Context(bars, (_, isCall) => isCall ? optionBars : Array.Empty<Candle>());
        var strategy = new MacdCrossoverStrategy();

        var trades = strategy.Simulate(context, Parameters());

        var trade = Assert.Single(trades);
        Assert.Equal("Bullish", trade.Direction);
        Assert.Equal("Buy", trade.Side);
        Assert.Equal("CE", trade.OptionType);
    }

    [Fact]
    public void EntrySignals_HistogramThresholdTooHigh_RejectsInsteadOfEntering()
    {
        var context = Context(BuildReversalBars());
        var strategy = new MacdCrossoverStrategy();

        // The reversal's own crossover histogram is small (well under 1) - a threshold of 5 must
        // veto it, confirming the filter can actually reject a crossover that fires cleanly with
        // the filter off.
        var signals = strategy.EntrySignals(context, Parameters(minHistogram: 5));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("histogram"));
    }

    [Fact]
    public void EntrySignals_DirectionFilterExcludesTheOppositeSide_RejectsInsteadOfEntering()
    {
        var context = Context(BuildReversalBars());
        var strategy = new MacdCrossoverStrategy();

        var signals = strategy.EntrySignals(context, Parameters(direction: 2 /* Bearish only */));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish" && s.Summary.Contains("bearish only"));
    }

    private static readonly DateTimeOffset EarlyStart = new(2026, 1, 5, 3, 0, 0, TimeSpan.Zero); // 08:30 IST

    [Fact]
    public void EntrySignals_ReversalBeforeSignalStartTime_RejectsInsteadOfEntering()
    {
        var context = Context(BuildReversalBars(EarlyStart));
        var strategy = new MacdCrossoverStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("pre-open"));
    }

    [Fact]
    public void EntrySignals_FastPeriodNotBelowSlowPeriod_ReturnsNoSignals()
    {
        var context = Context(BuildReversalBars());
        var strategy = new MacdCrossoverStrategy();

        var parameters = Parameters();
        parameters["fastPeriod"] = 6;
        parameters["slowPeriod"] = 6; // invalid - fast must be strictly below slow

        var signals = strategy.EntrySignals(context, parameters);

        Assert.Empty(signals);
    }
}

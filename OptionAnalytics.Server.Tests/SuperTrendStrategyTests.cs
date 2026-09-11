using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// Covers SuperTrendStrategy's own reasoning - firing on a real flip and the direction/signal-start
/// filters. Unlike ParabolicSarStrategy's IsReversal flag, Supertrend has no "this bar is the flip"
/// marker of its own - direction is read from which band (UpperBand/LowerBand) is currently active,
/// the same "state changed from the previous bar" convention this app's EMA/SMA-line crossover
/// strategies use, and inherits the same cold-start quirk they have: the reversal-bars fixture
/// verified empirically (against Skender's own GetSuperTrend(10, 3) output) flips THREE times, not
/// once - an initial Bullish reading the moment the indicator first has enough bars, a Bearish flip
/// partway through the still-declining phase (the ATR window catching up to the new, lower
/// volatility), and finally the real Bullish reversal this fixture exists to produce. Tests key off
/// finding the specific Bullish entry the reversal itself causes, not "the only signal", to stay
/// correct regardless of the two earlier ones - the exact same tolerance
/// EmaCrossoverStrategyTests's own doc comment explains for its own cold start.
/// </summary>
public sealed class SuperTrendStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero); // 09:30 IST

    private static IReadOnlyList<Candle> BuildReversalBars(DateTimeOffset? start = null)
    {
        var bars = new List<Candle>();
        var time = start ?? T0;
        var price = 100m;

        for (var i = 0; i < 20; i++)
        {
            bars.Add(new Candle(time, price, price + 1, price - 1, price));
            time = time.AddMinutes(1);
            price -= 1;
        }
        for (var i = 0; i < 15; i++)
        {
            price += 7;
            bars.Add(new Candle(time, price, price + 1, price - 1, price));
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

    private static Dictionary<string, decimal> Parameters(decimal direction = 0, decimal signalStartMinutes = 555) => new()
    {
        ["side"] = OptionTradeSimulator.SideBuy,
        ["otmSteps"] = 1,
        ["slPoints"] = 8,
        ["tpPoints"] = 80,
        ["atrPeriod"] = 10,
        ["multiplier"] = 3,
        ["direction"] = direction,
        ["signalStartMinutes"] = signalStartMinutes,
    };

    [Fact]
    public void EntrySignals_SharpReversal_FiresABullishEntry()
    {
        var context = Context(BuildReversalBars());
        var strategy = new SuperTrendStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.Contains(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
    }

    [Fact]
    public void Simulate_SharpReversal_ProducesABuyCallTrade()
    {
        var bars = BuildReversalBars();
        var optionBars = bars.Select(b => new Candle(b.Time, 50, 55, 45, 50)).ToList();
        var context = Context(bars, (_, isCall) => isCall ? optionBars : Array.Empty<Candle>());
        var strategy = new SuperTrendStrategy();

        var trades = strategy.Simulate(context, Parameters());

        var bullishTrades = trades.Where(t => t.Direction == "Bullish").ToList();
        var trade = Assert.Single(bullishTrades);
        Assert.Equal("Buy", trade.Side);
        Assert.Equal("CE", trade.OptionType);
    }

    [Fact]
    public void EntrySignals_DirectionFilterExcludesTheOppositeSide_RejectsInsteadOfEntering()
    {
        var context = Context(BuildReversalBars());
        var strategy = new SuperTrendStrategy();

        var signals = strategy.EntrySignals(context, Parameters(direction: 2 /* downtrend flips only */));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish" && s.Summary.Contains("downtrend flips only"));
    }

    private static readonly DateTimeOffset EarlyStart = new(2026, 1, 5, 3, 0, 0, TimeSpan.Zero); // 08:30 IST

    [Fact]
    public void EntrySignals_SignalStartTimeDisabled_FiresEvenBeforeDefaultCutoff()
    {
        var context = Context(BuildReversalBars(EarlyStart));
        var strategy = new SuperTrendStrategy();

        // 0 explicitly turns the cutoff off - the same reversal must still fire normally with it
        // disabled, mirroring EmaCrossoverStrategyTests's own "cutoff disabled" test.
        var signals = strategy.EntrySignals(context, Parameters(signalStartMinutes: 0));

        Assert.Contains(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
        Assert.DoesNotContain(signals, s => s.Summary.Contains("pre-open"));
    }
}

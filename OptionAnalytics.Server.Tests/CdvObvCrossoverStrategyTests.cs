using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// Covers CdvObvCrossoverStrategy's own reasoning: a CE lead confirmed on BOTH CDV and OBV for at
/// least the bars threshold fires Bullish (mirrored for PE/Bearish), a lead on only one of the two
/// series never fires at all, and the pre-open/direction filters reject instead of silently
/// dropping a qualifying streak - matching every other strategy's own filter tests this session.
/// </summary>
public sealed class CdvObvCrossoverStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero); // 09:30 IST

    private static List<Candle> Bars(int count, DateTimeOffset? start = null)
    {
        var bars = new List<Candle>();
        var time = start ?? T0;
        for (var i = 0; i < count; i++)
        {
            bars.Add(new Candle(time, 100, 100, 100, 100));
            time = time.AddMinutes(1);
        }
        return bars;
    }

    private static BacktestStrategyContext Context(
        IReadOnlyList<Candle> spotBars,
        IReadOnlyList<ObvPoint> cdvCe, IReadOnlyList<ObvPoint> cdvPe,
        IReadOnlyList<ObvPoint> obvCe, IReadOnlyList<ObvPoint> obvPe,
        Func<decimal, bool, IReadOnlyList<Candle>>? getOptionBars = null) => new()
    {
        Underlying = "NIFTY",
        TimeframeMinutes = 1,
        Step = 50,
        SpotBars = spotBars,
        ConfluenceSignalsAscending = Array.Empty<BacktestSignal>(),
        AllSignals = Array.Empty<BacktestSignal>(),
        ObvCeSeries = obvCe,
        ObvPeSeries = obvPe,
        CdvCeSeries = cdvCe,
        CdvPeSeries = cdvPe,
        GetOptionBars = getOptionBars ?? ((_, _) => Array.Empty<Candle>()),
    };

    private static Dictionary<string, decimal> Parameters(decimal barsThreshold = 3, decimal direction = 0, decimal signalStartMinutes = 555) => new()
    {
        ["side"] = OptionTradeSimulator.SideBuy,
        ["otmSteps"] = 1,
        ["slPoints"] = 10,
        ["tpPoints"] = 20,
        ["squareOffMinutes"] = 0,
        ["signalStartMinutes"] = signalStartMinutes,
        ["barsThreshold"] = barsThreshold,
        ["direction"] = direction,
    };

    private static (List<ObvPoint> Ce, List<ObvPoint> Pe) PointsFor(IReadOnlyList<Candle> bars, decimal ceValue, decimal peValue) =>
        (bars.Select(b => new ObvPoint(b.Time, ceValue)).ToList(), bars.Select(b => new ObvPoint(b.Time, peValue)).ToList());

    [Fact]
    public void EntrySignals_CeLeadsOnBothSeriesForThresholdBars_FiresBullishEntry()
    {
        var bars = Bars(5);
        var (cdvCe, cdvPe) = PointsFor(bars, 500, 200);
        var (obvCe, obvPe) = PointsFor(bars, 500, 200);
        var context = Context(bars, cdvCe, cdvPe, obvCe, obvPe);
        var strategy = new CdvObvCrossoverStrategy();

        var signals = strategy.EntrySignals(context, Parameters(barsThreshold: 3));

        // Threshold=3 bars ago (0-indexed bar 2, the third bar) is where the streak first qualifies.
        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal("Bullish", entry.Direction);
        Assert.Equal(bars[2].Time, entry.TimeUtc);
    }

    [Fact]
    public void EntrySignals_PeLeadsOnBothSeriesForThresholdBars_FiresBearishEntry()
    {
        var bars = Bars(5);
        var (cdvCe, cdvPe) = PointsFor(bars, 200, 500);
        var (obvCe, obvPe) = PointsFor(bars, 200, 500);
        var context = Context(bars, cdvCe, cdvPe, obvCe, obvPe);
        var strategy = new CdvObvCrossoverStrategy();

        var signals = strategy.EntrySignals(context, Parameters(barsThreshold: 3));

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal("Bearish", entry.Direction);
    }

    [Fact]
    public void EntrySignals_OnlyOneSeriesAgrees_NeverFires()
    {
        var bars = Bars(5);
        // CDV favors CE, OBV favors PE - the two series disagree, so bias is never resolved.
        var (cdvCe, cdvPe) = PointsFor(bars, 500, 200);
        var (obvCe, obvPe) = PointsFor(bars, 200, 500);
        var context = Context(bars, cdvCe, cdvPe, obvCe, obvPe);
        var strategy = new CdvObvCrossoverStrategy();

        var signals = strategy.EntrySignals(context, Parameters(barsThreshold: 3));

        Assert.Empty(signals);
    }

    [Fact]
    public void EntrySignals_StreakShorterThanThreshold_NeverFires()
    {
        var bars = Bars(2); // only 2 bars of agreement, threshold needs 3
        var (cdvCe, cdvPe) = PointsFor(bars, 500, 200);
        var (obvCe, obvPe) = PointsFor(bars, 500, 200);
        var context = Context(bars, cdvCe, cdvPe, obvCe, obvPe);
        var strategy = new CdvObvCrossoverStrategy();

        var signals = strategy.EntrySignals(context, Parameters(barsThreshold: 3));

        Assert.Empty(signals);
    }

    [Fact]
    public void EntrySignals_FiresOnlyOnceForOneContinuingStreak()
    {
        var bars = Bars(8);
        var (cdvCe, cdvPe) = PointsFor(bars, 500, 200);
        var (obvCe, obvPe) = PointsFor(bars, 500, 200);
        var context = Context(bars, cdvCe, cdvPe, obvCe, obvPe);
        var strategy = new CdvObvCrossoverStrategy();

        var signals = strategy.EntrySignals(context, Parameters(barsThreshold: 3));

        Assert.Single(signals.Where(s => s.Kind == "Entry"));
    }

    [Fact]
    public void EntrySignals_DirectionFilterExcludesTheOppositeSide_RejectsInsteadOfEntering()
    {
        var bars = Bars(5);
        var (cdvCe, cdvPe) = PointsFor(bars, 500, 200);
        var (obvCe, obvPe) = PointsFor(bars, 500, 200);
        var context = Context(bars, cdvCe, cdvPe, obvCe, obvPe);
        var strategy = new CdvObvCrossoverStrategy();

        var signals = strategy.EntrySignals(context, Parameters(barsThreshold: 3, direction: 2 /* shorts only */));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish" && s.Summary.Contains("shorts only"));
    }

    private static readonly DateTimeOffset EarlyStart = new(2026, 1, 5, 3, 0, 0, TimeSpan.Zero); // 08:30 IST

    [Fact]
    public void EntrySignals_QualifyingStreakBeforeSignalStartTime_RejectsInsteadOfEntering()
    {
        var bars = Bars(5, EarlyStart); // streak qualifies at 08:32 IST, before the 09:15 default cutoff
        var (cdvCe, cdvPe) = PointsFor(bars, 500, 200);
        var (obvCe, obvPe) = PointsFor(bars, 500, 200);
        var context = Context(bars, cdvCe, cdvPe, obvCe, obvPe);
        var strategy = new CdvObvCrossoverStrategy();

        var signals = strategy.EntrySignals(context, Parameters(barsThreshold: 3));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("pre-open"));
    }

    [Fact]
    public void Simulate_ConfirmedBullishStreak_ProducesABuyCallTrade()
    {
        var bars = Bars(5);
        var (cdvCe, cdvPe) = PointsFor(bars, 500, 200);
        var (obvCe, obvPe) = PointsFor(bars, 500, 200);
        var optionBars = bars.Select(b => new Candle(b.Time, 50, 55, 45, 50)).ToList();
        var context = Context(bars, cdvCe, cdvPe, obvCe, obvPe, getOptionBars: (_, isCall) => isCall ? optionBars : Array.Empty<Candle>());
        var strategy = new CdvObvCrossoverStrategy();

        var trades = strategy.Simulate(context, Parameters(barsThreshold: 3));

        var trade = Assert.Single(trades);
        Assert.Equal("Bullish", trade.Direction);
        Assert.Equal("Buy", trade.Side);
        Assert.Equal("CE", trade.OptionType);
    }
}

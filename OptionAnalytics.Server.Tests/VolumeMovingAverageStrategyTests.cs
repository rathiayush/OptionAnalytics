using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// Covers VolumeMovingAverageStrategy's own reasoning - a genuine crossover between the two sides'
/// volume moving averages fires (not every bar the same side continues to lead), the threshold
/// filter, and the direction/signal-start filters. The volume-MA math is a plain, hand-computable
/// rolling average (unlike this app's Skender-backed indicators), so fixtures below are exact by
/// construction rather than verified against a third-party library.
/// </summary>
public sealed class VolumeMovingAverageStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero); // 09:30 IST

    /// <summary>With a 3-bar volume MA: CE and PE both sit at a constant volume of 100 for the
    /// first 5 bars (their 3-bar MAs stay EXACTLY tied at 100 - a tie, not a cross, so no signal
    /// yet), then CE's volume jumps to 500 for 4 bars while PE stays at 100 - CE's MA overtakes
    /// PE's at bar index 5 (MA 233.33 vs 100), the first real signal (Bullish). CE then drops back
    /// to 100 while PE jumps to 500 for 3 bars - PE's MA overtakes CE's at bar index 10 (366.67 vs
    /// 233.33), the second real signal (Bearish).</summary>
    private static (IReadOnlyList<Candle> Spot, IReadOnlyList<CandleWithVolume> Ce, IReadOnlyList<CandleWithVolume> Pe) BuildCrossoverBars(DateTimeOffset? start = null)
    {
        var ceVolumes = new long[] { 100, 100, 100, 100, 100, 500, 500, 500, 500, 100, 100, 100 };
        var peVolumes = new long[] { 100, 100, 100, 100, 100, 100, 100, 100, 100, 500, 500, 500 };

        var spot = new List<Candle>();
        var ce = new List<CandleWithVolume>();
        var pe = new List<CandleWithVolume>();
        var time = start ?? T0;

        for (var i = 0; i < ceVolumes.Length; i++)
        {
            spot.Add(new Candle(time, 24000, 24000, 24000, 24000));
            ce.Add(new CandleWithVolume(time, 50, 55, 45, 50, ceVolumes[i]));
            pe.Add(new CandleWithVolume(time, 50, 55, 45, 50, peVolumes[i]));
            time = time.AddMinutes(1);
        }

        return (spot, ce, pe);
    }

    private static BacktestStrategyContext Context(
        IReadOnlyList<Candle> spotBars,
        IReadOnlyList<CandleWithVolume> ceVolumeBars,
        IReadOnlyList<CandleWithVolume> peVolumeBars,
        Func<decimal, bool, IReadOnlyList<Candle>>? getOptionBars = null) => new()
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
        AtmCeVolumeBars = ceVolumeBars,
        AtmPeVolumeBars = peVolumeBars,
        AtmStrike = null,
    };

    private static Dictionary<string, decimal> Parameters(decimal thresholdPercent = 0, decimal direction = 0, decimal signalStartMinutes = 555) => new()
    {
        ["side"] = OptionTradeSimulator.SideBuy,
        ["otmSteps"] = 1,
        ["slPoints"] = 10,
        ["tpPoints"] = 20,
        ["volumePeriod"] = 3,
        ["thresholdPercent"] = thresholdPercent,
        ["direction"] = direction,
        ["signalStartMinutes"] = signalStartMinutes,
    };

    [Fact]
    public void EntrySignals_CeVolumeOvertakesPe_FiresBullishEntry()
    {
        var (spot, ce, pe) = BuildCrossoverBars();
        var context = Context(spot, ce, pe);
        var strategy = new VolumeMovingAverageStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        var entries = signals.Where(s => s.Kind == "Entry").ToList();
        Assert.Equal(2, entries.Count);
        Assert.Equal("Bullish", entries.Single(e => e.TimeUtc == spot[5].Time).Direction);
    }

    [Fact]
    public void EntrySignals_PeVolumeLaterOvertakesCe_FiresBearishEntry()
    {
        var (spot, ce, pe) = BuildCrossoverBars();
        var context = Context(spot, ce, pe);
        var strategy = new VolumeMovingAverageStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        var entries = signals.Where(s => s.Kind == "Entry").ToList();
        Assert.Equal("Bearish", entries.Single(e => e.TimeUtc == spot[10].Time).Direction);
    }

    [Fact]
    public void EntrySignals_TiedVolume_NeverFiresWhileBothSidesMatch()
    {
        // Bars 0-4 (both sides constant at 100) must never produce a signal - a tie is not a cross.
        var (spot, ce, pe) = BuildCrossoverBars();
        var context = Context(spot.Take(5).ToList(), ce.Take(5).ToList(), pe.Take(5).ToList());
        var strategy = new VolumeMovingAverageStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.Empty(signals);
    }

    [Fact]
    public void Simulate_CeVolumeOvertakesPe_ProducesABuyCallTrade()
    {
        var (spot, ce, pe) = BuildCrossoverBars();
        var optionBars = spot.Select(b => new Candle(b.Time, 50, 55, 45, 50)).ToList();
        var context = Context(spot, ce, pe, (_, isCall) => isCall ? optionBars : Array.Empty<Candle>());
        var strategy = new VolumeMovingAverageStrategy();

        var trades = strategy.Simulate(context, Parameters());

        var bullishTrades = trades.Where(t => t.Direction == "Bullish").ToList();
        var trade = Assert.Single(bullishTrades);
        Assert.Equal("Buy", trade.Side);
        Assert.Equal("CE", trade.OptionType);
    }

    [Fact]
    public void EntrySignals_ThresholdTooHighForTheLead_RejectsInsteadOfEntering()
    {
        var (spot, ce, pe) = BuildCrossoverBars();
        var context = Context(spot, ce, pe);
        var strategy = new VolumeMovingAverageStrategy();

        // At the Bullish cross (233.33 vs 100), the normalized lead is (233.33-100)/(233.33+100)*100
        // = ~40.05% - a 90% minimum must veto it, confirming the filter can actually reject a cross
        // that fires cleanly with the filter off.
        var signals = strategy.EntrySignals(context, Parameters(thresholdPercent: 90));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish" && s.Summary.Contains("lead"));
    }

    [Fact]
    public void EntrySignals_DirectionFilterExcludesTheOppositeSide_RejectsInsteadOfEntering()
    {
        var (spot, ce, pe) = BuildCrossoverBars();
        var context = Context(spot, ce, pe);
        var strategy = new VolumeMovingAverageStrategy();

        var signals = strategy.EntrySignals(context, Parameters(direction: 2 /* PE volume leads only */));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish" && s.Summary.Contains("PE volume leads only"));
    }

    private static readonly DateTimeOffset EarlyStart = new(2026, 1, 5, 3, 0, 0, TimeSpan.Zero); // 08:30 IST

    [Fact]
    public void EntrySignals_CrossBeforeSignalStartTime_RejectsInsteadOfEntering()
    {
        var (spot, ce, pe) = BuildCrossoverBars(EarlyStart);
        var context = Context(spot, ce, pe);
        var strategy = new VolumeMovingAverageStrategy();

        var signals = strategy.EntrySignals(context, Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("pre-open"));
    }
}

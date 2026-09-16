using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers AdaptiveOptionSellingV2Strategy - the deliberately plain, single-timeframe
/// adaptive-selling strategy (see its own class doc comment). Fixtures confirmed via a diagnostic
/// dump: a smooth, wide sine wave actually reads as genuine Trending during each half-cycle (a real
/// local slope/ADX/alignment lineup, not a bug), so the Range/Sideways fixture here uses a small-
/// amplitude, short-period oscillation instead - choppy enough that EMA7/20/50 rarely sustain a
/// clean alignment, so the score stays below trendScoreMin and the VWAP+-ATR band rejection path
/// fires instead.</summary>
public sealed class AdaptiveOptionSellingV2StrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero);

    private static List<Candle> TrendFixture(int bars = 4000, decimal step = 0.5m)
    {
        var result = new List<Candle>(bars);
        var price = 20000m;
        for (var i = 0; i < bars; i++)
        {
            var open = price;
            price += step;
            var close = price;
            result.Add(new Candle(T0.AddMinutes(i), open, Math.Max(open, close) + 0.3m, Math.Min(open, close) - 0.3m, close));
        }
        return result;
    }

    private static List<Candle> ChoppyFixture(int bars = 4000, decimal amplitude = 4m, int period = 8)
    {
        var result = new List<Candle>(bars);
        var mid = 20000m;
        for (var i = 0; i < bars; i++)
        {
            var open = mid + amplitude * (decimal)Math.Sin(2 * Math.PI * i / period);
            var close = mid + amplitude * (decimal)Math.Sin(2 * Math.PI * (i + 1) / period);
            result.Add(new Candle(T0.AddMinutes(i), open, Math.Max(open, close) + 0.2m, Math.Min(open, close) - 0.2m, close));
        }
        return result;
    }

    private static List<CandleWithVolume> Volume(IReadOnlyList<Candle> bars) =>
        bars.Select(b => new CandleWithVolume(b.Time, b.Open, b.High, b.Low, b.Close, 1000)).ToList();

    private static BacktestStrategyContext Context(IReadOnlyList<Candle> oneMin, int timeframeMinutes = 1)
    {
        var oneMinOption = oneMin.Select(b => new Candle(b.Time, 100m, 100.5m, 99.5m, 100m)).ToList();
        return new()
        {
            Underlying = "NIFTY",
            TimeframeMinutes = timeframeMinutes,
            Step = 50,
            SpotBars = timeframeMinutes == 1 ? oneMin : BacktestUtil.AggregateCandles(oneMin, timeframeMinutes),
            SpotBarsOneMinute = oneMin,
            SpotVolumeBarsOneMinute = Volume(oneMin),
            ConfluenceSignalsAscending = Array.Empty<BacktestSignal>(),
            AllSignals = Array.Empty<BacktestSignal>(),
            ObvCeSeries = Array.Empty<ObvPoint>(),
            ObvPeSeries = Array.Empty<ObvPoint>(),
            CdvCeSeries = Array.Empty<ObvPoint>(),
            CdvPeSeries = Array.Empty<ObvPoint>(),
            GetOptionBars = (_, _) => timeframeMinutes == 1 ? oneMinOption : BacktestUtil.AggregateCandles(oneMinOption, timeframeMinutes),
            GetOptionBarsOneMinute = (_, _) => oneMinOption,
            AtmCeBars = Array.Empty<Candle>(),
            AtmPeBars = Array.Empty<Candle>(),
            AtmCeVolumeBars = Array.Empty<CandleWithVolume>(),
            AtmPeVolumeBars = Array.Empty<CandleWithVolume>(),
            AtmStrike = null,
        };
    }

    private static Dictionary<string, decimal> Parameters(Action<Dictionary<string, decimal>>? overrides = null)
    {
        var p = new AdaptiveOptionSellingV2Strategy().Parameters.ToDictionary(x => x.Key, x => x.Default);
        p["signalStartMinutes"] = 0;
        overrides?.Invoke(p);
        return p;
    }

    [Fact]
    public void Trend_FiresSingleLegDirectionalEntries_MatchingTheSustainedUptrend()
    {
        var bars = TrendFixture();

        var signals = new AdaptiveOptionSellingV2Strategy().EntrySignals(Context(bars), Parameters());
        var entries = signals.Where(s => s.Kind == "Entry").ToList();

        Assert.NotEmpty(entries);
        Assert.All(entries, e => Assert.Equal("Bullish", e.Direction));
        Assert.All(entries, e => Assert.Contains("Trending", e.Summary));
        Assert.All(entries, e => Assert.Contains("sell PE", e.Summary));
    }

    [Fact]
    public void RangeSideways_FiresBothLegsAtOnce_AsAShortStrangle()
    {
        var bars = ChoppyFixture();

        var signals = new AdaptiveOptionSellingV2Strategy().EntrySignals(Context(bars), Parameters());
        var entries = signals.Where(s => s.Kind == "Entry").ToList();

        Assert.NotEmpty(entries);
        var bullish = entries.Count(e => e.Direction == "Bullish");
        var bearish = entries.Count(e => e.Direction == "Bearish");
        Assert.Equal(bullish, bearish);
        Assert.All(entries, e => Assert.Contains("Short Strangle", e.Summary));
    }

    [Fact]
    public void RangeSideways_TheTwoLegsAreGenuinelyConcurrentPositions()
    {
        var bars = ChoppyFixture();

        var trades = new AdaptiveOptionSellingV2Strategy().Simulate(Context(bars), Parameters());
        var ceWindows = trades.Where(t => t.OptionType == "CE" && t.EntryTimeUtc is not null && t.ExitTimeUtc is not null)
            .Select(t => (Start: t.EntryTimeUtc!.Value, End: t.ExitTimeUtc!.Value)).ToList();
        var peWindows = trades.Where(t => t.OptionType == "PE" && t.EntryTimeUtc is not null && t.ExitTimeUtc is not null)
            .Select(t => (Start: t.EntryTimeUtc!.Value, End: t.ExitTimeUtc!.Value)).ToList();

        Assert.NotEmpty(ceWindows);
        Assert.NotEmpty(peWindows);
        Assert.Contains(ceWindows, ce => peWindows.Any(pe => ce.Start < pe.End && pe.Start < ce.End));
    }

    [Fact]
    public void RangeSideways_PairedLegsSquareOffTogether_NotIndependently()
    {
        var bars = ChoppyFixture();

        var trades = new AdaptiveOptionSellingV2Strategy().Simulate(Context(bars), Parameters());
        var pairs = trades.Where(t => t.EntryTimeUtc is not null && t.ExitTimeUtc is not null)
            .GroupBy(t => t.SignalTimeUtc).Where(g => g.Count() == 2).ToList();

        Assert.NotEmpty(pairs);
        // Per explicit instruction: trades executed together must be squared off together - see
        // OptionTradeSimulator.RunPairedLegs (this fixture's flat premium means every exit here is
        // RegimeChange/EndOfDay/time-driven, so it doesn't hit that method's own documented rare
        // stop/target-driven cascade residual - see its dedicated stress test for that ~99% case).
        Assert.All(pairs, g => Assert.Single(g.Select(t => t.ExitTimeUtc).Distinct()));
    }

    [Fact]
    public void Trend_DirectionFilter_BlocksTheDisallowedSide()
    {
        var bars = TrendFixture();

        var signals = new AdaptiveOptionSellingV2Strategy().EntrySignals(Context(bars), Parameters(p => p["direction"] = 2m /* ShortOnly */));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("direction filter"));
    }

    [Fact]
    public void NoSignalsAtAll_WhenTooFewBarsExistForEma50Warmup()
    {
        var bars = TrendFixture(50);

        var signals = new AdaptiveOptionSellingV2Strategy().EntrySignals(Context(bars), Parameters());

        Assert.Empty(signals);
    }

    [Fact]
    public void HasNoRegimeMultiplierParameters_ThisIsThePlainSiblingNotTheDetailedOne()
    {
        var strategy = new AdaptiveOptionSellingV2Strategy();
        Assert.DoesNotContain(strategy.Parameters, p => p.Key is "rangePtMult" or "rangeSlMult" or "rangeOtmMult" or "trendPtMult" or "trendSlMult" or "trendOtmMult" or "baseOtmSteps");
        Assert.Contains(strategy.Parameters, p => p.Key == "otmSteps");
    }

    [Fact]
    public void DefaultsForTimeframe_ScalesPriceDistanceParameters_ButNotIndicatorPeriodsOrThresholds()
    {
        var strategy = new AdaptiveOptionSellingV2Strategy();
        var staticEma7 = strategy.Parameters.Single(p => p.Key == "ema7Period").Default;
        var staticAdxTrendMin = strategy.Parameters.Single(p => p.Key == "adxTrendMin").Default;

        var result1 = BacktestUtil.ApplyTimeframeDefaults(strategy, 1);
        var result5 = BacktestUtil.ApplyTimeframeDefaults(strategy, 5);

        Assert.NotEqual(result1.Single(p => p.Key == "atrExtremePercent").Default, result5.Single(p => p.Key == "atrExtremePercent").Default);
        Assert.NotEqual(result1.Single(p => p.Key == "slPercentOfPremium").Default, result5.Single(p => p.Key == "slPercentOfPremium").Default);
        Assert.Equal(staticEma7, result5.Single(p => p.Key == "ema7Period").Default);
        Assert.Equal(staticAdxTrendMin, result5.Single(p => p.Key == "adxTrendMin").Default);
    }
}

using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers RegimeAdaptiveStrategy's own trend-continuation entry (its Range/VWAP-band fade,
/// and the RSI-neutral gate specifically guarding it, are NOT independently exercised here -
/// constructing a fixture that reaches Range regime AND clears a VWAP+-ATR band AND lands RSI both
/// inside and outside the neutral band is multiple independently fragile fixtures this suite does not
/// attempt; the trend path below already exercises the shared regime-scoring pipeline - EMA stack,
/// slope, ADX, VWAP side, and the chop/cross counts all have to agree for either path to fire at
/// all). Small EMA periods (5/10/20, not the real 7/20/50 default) purely to keep the fixture a
/// manageable 90 bars - verified once via a temporary Assert.Fail dump of every signal this fixture
/// produces, the same "confirm the real output before asserting on it" approach
/// LuxAlgoSrBreakStrategyTests' own history used for GetPivots.</summary>
public sealed class RegimeAdaptiveStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero); // 09:15 IST

    // A clean 60-bar uptrend, a shallow 5-bar pullback, then a 25-bar resumption - the EMA5 dips
    // below EMA10 during the pullback (index ~60-64) and crosses back over a few bars into the
    // resumption once the fixture is confirmed (via a diagnostic dump) to land at bar 68 - the one
    // and only signal this fixture produces at these parameters (no Range/VWAP-band breakout ever
    // triggers along the way, so this is intentionally a single-assertion fixture).
    private static List<Candle> UptrendWithPullbackFixture()
    {
        var bars = new List<Candle>();
        decimal price = 100m;
        for (var i = 0; i < 60; i++) { price += 1m; bars.Add(new Candle(T0.AddMinutes(i), price, price, price, price)); }
        for (var i = 60; i < 65; i++) { price -= 2m; bars.Add(new Candle(T0.AddMinutes(i), price, price, price, price)); }
        for (var i = 65; i < 90; i++) { price += 1.5m; bars.Add(new Candle(T0.AddMinutes(i), price, price, price, price)); }
        return bars;
    }

    // The same shape as the uptrend fixture (same step sizes, so ATR-as-%-of-price stays in a
    // comparable band) but descending from a higher base rather than reflected through a constant -
    // reflecting through 200 would shrink the tail end of this fixture down near 10-40, which
    // inflates ATR%-of-price well past the Extreme volatility cutoff and wrongly blocks every entry.
    private static List<Candle> DowntrendWithBounceFixture()
    {
        var bars = new List<Candle>();
        decimal price = 250m;
        for (var i = 0; i < 60; i++) { price -= 1m; bars.Add(new Candle(T0.AddMinutes(i), price, price, price, price)); }
        for (var i = 60; i < 65; i++) { price += 2m; bars.Add(new Candle(T0.AddMinutes(i), price, price, price, price)); }
        for (var i = 65; i < 90; i++) { price -= 1.5m; bars.Add(new Candle(T0.AddMinutes(i), price, price, price, price)); }
        return bars;
    }

    private static List<CandleWithVolume> Volume(IReadOnlyList<Candle> bars) =>
        bars.Select(b => new CandleWithVolume(b.Time, b.Open, b.High, b.Low, b.Close, 1000)).ToList();

    private static BacktestStrategyContext Context(
        IReadOnlyList<Candle> spotBars, IReadOnlyList<ObvPoint>? obvCe = null, IReadOnlyList<ObvPoint>? obvPe = null) => new()
    {
        Underlying = "NIFTY",
        TimeframeMinutes = 1,
        Step = 50,
        SpotBars = spotBars,
        SpotBarsOneMinute = spotBars,
        SpotVolumeBarsOneMinute = Volume(spotBars),
        ConfluenceSignalsAscending = Array.Empty<BacktestSignal>(),
        AllSignals = Array.Empty<BacktestSignal>(),
        ObvCeSeries = obvCe ?? Array.Empty<ObvPoint>(),
        ObvPeSeries = obvPe ?? Array.Empty<ObvPoint>(),
        CdvCeSeries = Array.Empty<ObvPoint>(),
        CdvPeSeries = Array.Empty<ObvPoint>(),
        GetOptionBars = (_, _) => Array.Empty<Candle>(),
        GetOptionBarsOneMinute = (_, _) => Array.Empty<Candle>(),
        AtmCeBars = Array.Empty<Candle>(),
        AtmPeBars = Array.Empty<Candle>(),
        AtmCeVolumeBars = Array.Empty<CandleWithVolume>(),
        AtmPeVolumeBars = Array.Empty<CandleWithVolume>(),
        AtmStrike = null,
    };

    private static Dictionary<string, decimal> Parameters(Action<Dictionary<string, decimal>>? overrides = null)
    {
        var p = new Dictionary<string, decimal>
        {
            ["side"] = OptionTradeSimulator.SideBuy,
            ["otmSteps"] = 1,
            ["slPoints"] = 10,
            ["tpPoints"] = 20,
            ["squareOffMinutes"] = 0,
            ["signalStartMinutes"] = 0,
            ["noNewEntriesAfterMinutes"] = 0,
            ["excludeLastDays"] = 0,
            ["direction"] = 0,
            ["emaFastPeriod"] = 5,
            ["emaMidPeriod"] = 10,
            ["emaSlowPeriod"] = 20,
            ["slopeLookbackBars"] = 3,
            ["slopeThresholdPercent"] = 0.05m,
            ["adxPeriod"] = 14,
            ["adxTrendMin"] = 25,
            ["adxRangeMax"] = 20,
            ["atrPeriod"] = 14,
            ["atrNormalLowPercent"] = 0.8m,
            ["atrNormalHighPercent"] = 1.5m,
            ["atrExtremePercent"] = 2.5m,
            ["chopWindowMinutes"] = 15,
            ["minChopCrosses"] = 3,
            ["trendScoreThreshold"] = 4,
            ["rangeAtrMultiple"] = 1.5m,
            ["rsiPeriod"] = 14,
            ["rsiNeutralLow"] = 30,
            ["rsiNeutralHigh"] = 70,
            ["requireFlowConfirmation"] = 0,
            ["flowLookbackBars"] = 5,
            ["minFlowRisePercent"] = 0,
            ["flowMode"] = FlowConfirmation.ModeEither,
        };
        overrides?.Invoke(p);
        return p;
    }

    [Fact]
    public void Bullish_FiresTrendContinuationEntry_OnAConfirmedUptrendResumingAfterAShallowPullback()
    {
        var bars = UptrendWithPullbackFixture();

        var signals = new RegimeAdaptiveStrategy().EntrySignals(Context(bars), Parameters());

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal("Bullish", entry.Direction);
        Assert.Equal(bars[68].Time, entry.TimeUtc);
        Assert.Contains("Trending Bullish", entry.Summary);
    }

    [Fact]
    public void Bearish_FiresTrendContinuationEntry_OnAConfirmedDowntrendResumingAfterAShallowBounce()
    {
        var bars = DowntrendWithBounceFixture();

        var signals = new RegimeAdaptiveStrategy().EntrySignals(Context(bars), Parameters());

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal("Bearish", entry.Direction);
        Assert.Equal(bars[68].Time, entry.TimeUtc);
        Assert.Contains("Trending Bearish", entry.Summary);
    }

    [Fact]
    public void RequireFlowConfirmation_OffByDefaultInTheseTests_EntersRegardlessOfFlow()
    {
        var bars = UptrendWithPullbackFixture();
        // PE dominant, not CE - would FAIL a bullish-favoring flow check if the filter were on.
        var ce = new[] { new ObvPoint(T0, 50), new ObvPoint(T0.AddMinutes(89), 60) };
        var pe = new[] { new ObvPoint(T0, 500), new ObvPoint(T0.AddMinutes(89), 500) };

        var signals = new RegimeAdaptiveStrategy().EntrySignals(Context(bars, obvCe: ce, obvPe: pe), Parameters());

        Assert.Contains(signals, s => s.Kind == "Entry" && s.Direction == "Bullish");
    }

    [Fact]
    public void RequireFlowConfirmation_DefaultsOnForThisStrategy()
    {
        var strategy = new RegimeAdaptiveStrategy();
        Assert.Equal(1m, strategy.Parameters.Single(p => p.Key == "requireFlowConfirmation").Default);
    }

    [Fact]
    public void Side_DefaultsToSell_UnlikeEveryOtherStrategyHere()
    {
        var strategy = new RegimeAdaptiveStrategy();
        Assert.Equal(OptionTradeSimulator.SideSell, strategy.Parameters.Single(p => p.Key == "side").Default);
    }

    [Fact]
    public void ExtremeVolatility_RejectsTheTrendEntry_EvenThoughTheRegimeItselfTurnedTrending()
    {
        // Reflecting the uptrend fixture through a low constant (rather than scaling it, which
        // would leave ATR-as-%-of-price unchanged) shrinks the tail-end price down near 10-40 while
        // keeping the SAME absolute point-sized moves - a much bigger % of a much smaller price,
        // pushing ATR well past the Extreme cutoff even though the regime math (EMA order, %
        // slope, ADX - none of it sensitive to the absolute price level) still happily calls this
        // Trending (Bearish, since reflecting also flips direction - confirmed via a diagnostic
        // dump: ATR read 3.09% of price here).
        var bars = UptrendWithPullbackFixture().Select(b => new Candle(b.Time, 200m - b.Open, 200m - b.Low, 200m - b.High, 200m - b.Close)).ToList();

        var signals = new RegimeAdaptiveStrategy().EntrySignals(Context(bars), Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bearish" && s.Summary.Contains("Extreme volatility"));
    }

    [Fact]
    public void RequireFlowConfirmation_On_RejectsEntry_WhenFlowDoesNotFavorTheDirection()
    {
        var bars = UptrendWithPullbackFixture();
        var ce = new[] { new ObvPoint(T0, 50), new ObvPoint(T0.AddMinutes(89), 60) };
        var pe = new[] { new ObvPoint(T0, 500), new ObvPoint(T0.AddMinutes(89), 500) };

        var signals = new RegimeAdaptiveStrategy().EntrySignals(Context(bars, obvCe: ce, obvPe: pe), Parameters(p => p["requireFlowConfirmation"] = 1));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bullish" && s.Summary.Contains("flow does not favor"));
    }
}

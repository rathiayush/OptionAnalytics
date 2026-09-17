using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers KathyLienEma20Sma200Strategy against real EmaCrossoverDetector EMA/SMA math
/// (fastEmaPeriod=3, slowSmaPeriod=5 here, purely to keep fixtures short - the same math runs at the
/// real 20/200 default). Values were confirmed via a diagnostic dump of the real EMA3/SMA5 series
/// against these exact fixtures, not hand-derived.
///
/// RampFixture: 10 flat seed bars, then a steady close ramp with each bar's own Low/High set just
/// off its OWN open/close (never the prior bar's) - confirmed via the dump that this makes EVERY ramp
/// bar both "touch" the fast EMA (its Low sits below the EMA, which lags the ramp) AND close back
/// above it, with the EMA already above the SMA from the very first ramp bar - i.e. every ramp bar is
/// a valid Bullish pullback-continuation entry. BearishRampFixture is the exact same series reflected
/// through a constant (EMA/SMA are both linear functions of Close, and the touch check is linear too,
/// so C-close and C-EMA/SMA reproduce the identical logic with the signs flipped - confirmed via the
/// same dump run against the reflected series).</summary>
public sealed class KathyLienEma20Sma200StrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero);

    private static Candle Bar(int index, decimal open, decimal high, decimal low, decimal close) =>
        new(T0.AddMinutes(index), open, high, low, close);

    private static List<Candle> RampFixture(int rampBars = 5)
    {
        var bars = new List<Candle>();
        for (var i = 0; i < 10; i++) bars.Add(Bar(i, 100, 100, 100, 100));
        for (var i = 0; i < rampBars; i++)
        {
            var idx = 10 + i;
            var open = 100 + i * 10;
            var close = 100 + (i + 1) * 10;
            bars.Add(Bar(idx, open, close + 0.5m, open - 0.5m, close));
        }
        return bars;
    }

    // The exact same series reflected through 400 - see this class's own doc comment.
    private static List<Candle> BearishRampFixture(int rampBars = 5)
    {
        const decimal reflect = 400m;
        return RampFixture(rampBars).Select(b => new Candle(b.Time, reflect - b.Open, reflect - b.Low, reflect - b.High, reflect - b.Close)).ToList();
    }

    // A "failed bounce": bar 15 touches the fast EMA (Low 125 <= ema 135.15625 <= High 136) but
    // closes BELOW it (130) while the trend is still Bullish (ema 135.15625 > sma 134) - confirmed
    // via the dump this fires no entry, and that the following bar (16) doesn't either, since the dip
    // briefly flips the EMA back under the SMA (ema 137.578125 < sma 138) before the ramp resumes and
    // trend/close agree again from bar 17 onward.
    private static List<Candle> FailedBounceFixture()
    {
        var bars = RampFixture();
        bars.Add(Bar(15, 140, 136, 125, 130));
        for (var i = 0; i < 5; i++)
        {
            var idx = 16 + i;
            var open = 130 + i * 10;
            var close = 130 + (i + 1) * 10;
            bars.Add(Bar(idx, open, close + 0.5m, open - 0.5m, close));
        }
        return bars;
    }

    private static List<CandleWithVolume> Volume(IReadOnlyList<Candle> bars) =>
        bars.Select(b => new CandleWithVolume(b.Time, b.Open, b.High, b.Low, b.Close, 1000)).ToList();

    private static BacktestStrategyContext Context(IReadOnlyList<Candle> spotBars) => new()
    {
        Underlying = "NIFTY",
        TimeframeMinutes = 1,
        Step = 50,
        SpotBars = spotBars,
        SpotBarsOneMinute = spotBars,
        SpotVolumeBarsOneMinute = Volume(spotBars),
        ConfluenceSignalsAscending = Array.Empty<BacktestSignal>(),
        AllSignals = Array.Empty<BacktestSignal>(),
        ObvCeSeries = Array.Empty<ObvPoint>(),
        ObvPeSeries = Array.Empty<ObvPoint>(),
        CdvCeSeries = Array.Empty<ObvPoint>(),
        CdvPeSeries = Array.Empty<ObvPoint>(),
        GetOptionBars = (_, _) => spotBars.Select(b => new Candle(b.Time, 100m, 100.5m, 99.5m, 100m)).ToList(),
        GetOptionBarsOneMinute = (_, _) => spotBars.Select(b => new Candle(b.Time, 100m, 100.5m, 99.5m, 100m)).ToList(),
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
            ["excludeLastDays"] = 0,
            ["direction"] = 0, // both sides
            ["fastEmaPeriod"] = 3,
            ["slowSmaPeriod"] = 5,
        };
        overrides?.Invoke(p);
        return p;
    }

    [Fact]
    public void BullishTrend_FiresEntries_WhenPullbackBarClosesBackAboveTheFastEma()
    {
        var bars = RampFixture();

        var signals = new KathyLienEma20Sma200Strategy().EntrySignals(Context(bars), Parameters());
        var entries = signals.Where(s => s.Kind == "Entry").ToList();

        Assert.NotEmpty(entries);
        Assert.All(entries, e => Assert.Equal("Bullish", e.Direction));
        Assert.All(entries, e => Assert.Contains("above", e.Summary));
    }

    [Fact]
    public void BearishTrend_FiresEntries_WhenPullbackBarClosesBackBelowTheFastEma()
    {
        var bars = BearishRampFixture();

        var signals = new KathyLienEma20Sma200Strategy().EntrySignals(Context(bars), Parameters());
        var entries = signals.Where(s => s.Kind == "Entry").ToList();

        Assert.NotEmpty(entries);
        Assert.All(entries, e => Assert.Equal("Bearish", e.Direction));
        Assert.All(entries, e => Assert.Contains("below", e.Summary));
    }

    [Fact]
    public void FailedBounce_FiresNoEntry_WhenTheTouchingBarClosesAgainstTheTrend()
    {
        var bars = FailedBounceFixture();

        var signals = new KathyLienEma20Sma200Strategy().EntrySignals(Context(bars), Parameters());

        Assert.DoesNotContain(signals, s => s.TimeUtc == bars[15].Time);
        Assert.DoesNotContain(signals, s => s.TimeUtc == bars[16].Time);
        // The ramp resumes and trend/close agree again from bar 17 onward.
        Assert.Contains(signals, s => s.Kind == "Entry" && s.TimeUtc == bars[17].Time && s.Direction == "Bullish");
    }

    [Fact]
    public void Direction_ShortOnly_BlocksBullishEntries()
    {
        var bars = RampFixture();

        var signals = new KathyLienEma20Sma200Strategy().EntrySignals(Context(bars), Parameters(p => p["direction"] = 2m /* ShortOnly */));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("bearish only"));
    }

    [Fact]
    public void Direction_LongOnly_BlocksBearishEntries()
    {
        var bars = BearishRampFixture();

        var signals = new KathyLienEma20Sma200Strategy().EntrySignals(Context(bars), Parameters(p => p["direction"] = 1m /* LongOnly */));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("bullish only"));
    }

    [Fact]
    public void NoSignalsAtAll_WhenTooFewBarsExistForSma200Warmup()
    {
        var bars = RampFixture();

        // Real 20/200 defaults instead of the shortened test periods - 15 bars total is nowhere near
        // enough for either to warm up.
        var signals = new KathyLienEma20Sma200Strategy().EntrySignals(Context(bars), Parameters(p =>
        {
            p["fastEmaPeriod"] = 20;
            p["slowSmaPeriod"] = 200;
        }));

        Assert.Empty(signals);
    }

    [Fact]
    public void Simulate_TakesTradesOnTheBullishLeg_MatchingTheEntrySignals()
    {
        var bars = RampFixture();

        var trades = new KathyLienEma20Sma200Strategy().Simulate(Context(bars), Parameters());

        Assert.NotEmpty(trades);
        Assert.All(trades, t => Assert.Equal("CE", t.OptionType)); // Buy + Bullish -> buy CE
    }

    [Fact]
    public void HasNoExtraConfirmationParameters_ThisIsDeliberatelyPlain()
    {
        var strategy = new KathyLienEma20Sma200Strategy();
        Assert.DoesNotContain(strategy.Parameters, p => p.Key.Contains("flow", StringComparison.OrdinalIgnoreCase) || p.Key.Contains("rsi", StringComparison.OrdinalIgnoreCase) || p.Key.Contains("adx", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(strategy.Parameters, p => p.Key == "fastEmaPeriod" && p.Default == 20);
        Assert.Contains(strategy.Parameters, p => p.Key == "slowSmaPeriod" && p.Default == 200);
        // 1:2 by default.
        Assert.Contains(strategy.Parameters, p => p.Key == "slPoints" && p.Default == 10);
        Assert.Contains(strategy.Parameters, p => p.Key == "tpPoints" && p.Default == 20);
    }
}

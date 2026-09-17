using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers KathyLienEma20Ema200Strategy against real EmaCrossoverDetector EMA math
/// (fastEmaPeriod=5, slowEmaPeriod=15 here, purely to keep fixtures short - the same math runs at the
/// real 20/200 default). Values confirmed via a diagnostic dump of the real EMA5/EMA15 series against
/// these exact fixtures, not hand-derived.
///
/// RampBars: 20 flat seed bars, then a steady close ramp. Confirmed via the dump: EMA5 is reactive
/// enough that the first couple of ramp bars still touch it, but from bar 22 on it lags clearly BELOW
/// every ordinary ramp bar's own Low - a genuine "price has run away from the 20 EMA" trend, not a
/// permanent touch. Bar 31 is a deliberately inserted GREEN pullback candle whose Low dips back down
/// to touch EMA5 while its Close stays above it - the qualifying rejection candle. Bar 32's High then
/// clears bar 31's own High - the entry. BearishFixture is the exact same series reflected through a
/// constant (EMA is a linear function of Close, and every check here - trend, touch, candle colour,
/// break - is linear/order-preserving under that reflection too, confirmed via the same dump run
/// against the reflected series - see EmaCrossoverRetestStrategyTests for the same technique).</summary>
public sealed class KathyLienEma20Ema200StrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero);

    private static Candle Bar(int index, decimal open, decimal high, decimal low, decimal close) =>
        new(T0.AddMinutes(index), open, high, low, close);

    private static List<Candle> RampBars()
    {
        var bars = new List<Candle>();
        for (var i = 0; i < 20; i++) bars.Add(Bar(i, 100, 100, 100, 100));
        for (var i = 0; i < 11; i++) // indices 20..30, close ramps up to 210
        {
            var idx = 20 + i;
            var open = 100 + i * 10;
            var close = 100 + (i + 1) * 10;
            bars.Add(Bar(idx, open, close + 0.5m, open - 0.5m, close));
        }
        return bars;
    }

    // Bar 31: green pullback candle touching EMA5 (~195.15), closing above it. Bar 32: breaks bar
    // 31's high (210).
    private static List<Candle> BullishFixture()
    {
        var bars = RampBars();
        bars.Add(Bar(31, 195, 210, 185, 205));
        bars.Add(Bar(32, 205, 220, 204, 215));
        return bars;
    }

    // Bar 32 is a sharp reversal that flips the trend to Bearish - the pending Bullish rejection
    // candle from bar 31 must be invalidated. Bar 33 spikes back up through bar 31's old high (210)
    // - if the alert had wrongly survived, this would fire a Bullish entry; it must not.
    private static List<Candle> TrendReversalFixture()
    {
        var bars = RampBars();
        bars.Add(Bar(31, 195, 210, 185, 205));
        bars.Add(Bar(32, 205, 205, 45, 50));
        bars.Add(Bar(33, 50, 230, 45, 215));
        return bars;
    }

    // The exact same series reflected through 400 - see this class's own doc comment.
    private static List<Candle> Reflect(IReadOnlyList<Candle> bars)
    {
        const decimal reflect = 400m;
        return bars.Select(b => new Candle(b.Time, reflect - b.Open, reflect - b.Low, reflect - b.High, reflect - b.Close)).ToList();
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
            ["fastEmaPeriod"] = 5,
            ["slowEmaPeriod"] = 15,
            ["alertMaxAgeBars"] = 0,
        };
        overrides?.Invoke(p);
        return p;
    }

    // RampBars' own very first ramp bar (20) also happens to satisfy trend+touch simultaneously -
    // confirmed via the dump this is genuine (EMA15 is still near its flat-seed baseline that early,
    // so trend confirms immediately, and EMA5 hasn't built up its later lag yet either), not a bug -
    // it fires its own legitimate entry once bar 21 breaks its high. The tests below are about the
    // DELIBERATELY inserted bar-31 pullback specifically, so they filter to entries at-or-after it
    // rather than asserting there is only ever one entry in the whole fixture.

    [Fact]
    public void BullishTrend_FiresEntry_WhenALaterBarBreaksTheRejectionCandlesHigh()
    {
        var bars = BullishFixture();

        var signals = new KathyLienEma20Ema200Strategy().EntrySignals(Context(bars), Parameters());
        var entry = Assert.Single(signals, s => s.Kind == "Entry" && s.TimeUtc >= bars[31].Time);

        Assert.Equal(bars[32].Time, entry.TimeUtc);
        Assert.Equal("Bullish", entry.Direction);
        Assert.Contains("broke", entry.Summary);
    }

    [Fact]
    public void BearishTrend_FiresEntry_WhenALaterBarBreaksTheRejectionCandlesLow()
    {
        var bars = Reflect(BullishFixture());

        var signals = new KathyLienEma20Ema200Strategy().EntrySignals(Context(bars), Parameters());
        var entry = Assert.Single(signals, s => s.Kind == "Entry" && s.TimeUtc >= bars[31].Time);

        Assert.Equal(bars[32].Time, entry.TimeUtc);
        Assert.Equal("Bearish", entry.Direction);
    }

    [Fact]
    public void NoEntry_WhileTheRejectionCandleIsStillPending_BeforeItsBreak()
    {
        var bars = BullishFixture().Take(32).ToList(); // stop right after the rejection candle forms

        var signals = new KathyLienEma20Ema200Strategy().EntrySignals(Context(bars), Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry" && s.TimeUtc >= bars[31].Time);
    }

    [Fact]
    public void TrendReversal_InvalidatesThePendingRejectionCandle_NoEntryEvenOnALaterSpikeThroughItsOldHigh()
    {
        var bars = TrendReversalFixture();

        var signals = new KathyLienEma20Ema200Strategy().EntrySignals(Context(bars), Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry" && s.Direction == "Bullish" && s.TimeUtc >= bars[31].Time);
    }

    [Fact]
    public void Direction_ShortOnly_BlocksBullishEntries()
    {
        var bars = BullishFixture();

        var signals = new KathyLienEma20Ema200Strategy().EntrySignals(Context(bars), Parameters(p => p["direction"] = 2m /* ShortOnly */));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("bearish only"));
    }

    [Fact]
    public void Direction_LongOnly_BlocksBearishEntries()
    {
        var bars = Reflect(BullishFixture());

        var signals = new KathyLienEma20Ema200Strategy().EntrySignals(Context(bars), Parameters(p => p["direction"] = 1m /* LongOnly */));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("bullish only"));
    }

    [Fact]
    public void NoSignalsAtAll_WhenTooFewBarsExistForEma200Warmup()
    {
        var bars = BullishFixture(); // 17 bars total, nowhere near enough for the real 200 EMA default

        var signals = new KathyLienEma20Ema200Strategy().EntrySignals(Context(bars), Parameters(p =>
        {
            p["fastEmaPeriod"] = 20;
            p["slowEmaPeriod"] = 200;
        }));

        Assert.Empty(signals);
    }

    [Fact]
    public void Simulate_TakesTradesOnTheBullishLeg_MatchingTheEntrySignals()
    {
        var bars = BullishFixture();

        var trades = new KathyLienEma20Ema200Strategy().Simulate(Context(bars), Parameters());

        Assert.NotEmpty(trades);
        Assert.All(trades, t => Assert.Equal("CE", t.OptionType)); // Buy + Bullish -> buy CE
    }

    [Fact]
    public void HasNoExtraConfirmationParameters_ThisIsDeliberatelyPlain()
    {
        var strategy = new KathyLienEma20Ema200Strategy();
        Assert.DoesNotContain(strategy.Parameters, p => p.Key.Contains("flow", StringComparison.OrdinalIgnoreCase) || p.Key.Contains("rsi", StringComparison.OrdinalIgnoreCase) || p.Key.Contains("adx", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(strategy.Parameters, p => p.Key == "fastEmaPeriod" && p.Default == 20);
        Assert.Contains(strategy.Parameters, p => p.Key == "slowEmaPeriod" && p.Default == 200);
        // 1:2 by default - the spec's own fallback ("at least 1:2 risk:reward").
        Assert.Contains(strategy.Parameters, p => p.Key == "slPoints" && p.Default == 10);
        Assert.Contains(strategy.Parameters, p => p.Key == "tpPoints" && p.Default == 20);
    }
}

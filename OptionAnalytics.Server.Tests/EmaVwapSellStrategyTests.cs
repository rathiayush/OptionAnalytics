using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers EmaVwapSellStrategy's entry rule: spot's own close crossing its mid EMA while the
/// mid/slow EMA trend, the mid (and by default fast) EMA's own slope, and spot-vs-session-VWAP all
/// agree. Fast/mid/slow periods are kept deliberately small (2/3/5) so the EMA values after a long
/// flat seed are hand-computable with the standard EMA formula (weight = 2/(period+1)).</summary>
public sealed class EmaVwapSellStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero); // 09:15 IST

    private static Candle Bar(int index, decimal open, decimal high, decimal low, decimal close) =>
        new(T0.AddMinutes(index), open, high, low, close);

    // 10 flat bars at a constant close of 100 - long enough to fully seed EMA2/EMA3/EMA5 at exactly
    // 100 (a constant series' EMA converges to that same constant once seeded, regardless of period).
    private static List<Candle> FlatSeed() =>
        Enumerable.Range(0, 10).Select(i => Bar(i, 100, 100, 100, 100)).ToList();

    // Real, non-zero volume behind every flat bar plus the jump bar - what VwapCalculator needs to
    // produce a defined VWAP at the jump bar. Dominated by the ten flat 100-typical-price bars, so
    // the resulting VWAP sits only slightly above 100 by the jump bar - comfortably below its own
    // Close(110), satisfying the bullish "spot above VWAP" condition.
    private static List<CandleWithVolume> VolumeBars(IReadOnlyList<Candle> bars) =>
        bars.Select(b => new CandleWithVolume(b.Time, b.Open, b.High, b.Low, b.Close, b.Close == 100 && b.High == 100 ? 10 : 100)).ToList();

    private static BacktestStrategyContext Context(IReadOnlyList<Candle> spotBars, IReadOnlyList<CandleWithVolume>? volumeBars = null) => new()
    {
        Underlying = "NIFTY",
        TimeframeMinutes = 1,
        Step = 50,
        SpotBars = spotBars,
        SpotBarsOneMinute = spotBars,
        SpotVolumeBarsOneMinute = volumeBars ?? Array.Empty<CandleWithVolume>(),
        ConfluenceSignalsAscending = Array.Empty<BacktestSignal>(),
        AllSignals = Array.Empty<BacktestSignal>(),
        ObvCeSeries = Array.Empty<ObvPoint>(),
        ObvPeSeries = Array.Empty<ObvPoint>(),
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

    private static Dictionary<string, decimal> Parameters(decimal direction = 0) => new()
    {
        ["side"] = OptionTradeSimulator.SideSell,
        ["fastEmaPeriod"] = 2,
        ["midEmaPeriod"] = 3,
        ["slowEmaPeriod"] = 5,
        ["slopeLookbackBars"] = 1,
        ["requireFastEmaSlope"] = 1,
        ["maxPrevCandleRangeMultiple"] = 0,
        ["direction"] = direction,
        ["signalStartMinutes"] = 0,
    };

    private static List<Candle> BullishCrossFixture()
    {
        var bars = FlatSeed();
        // ema2_10 ~= 106.667, ema3_10 = 105, ema5_10 ~= 103.333 - mid above slow, both mid and fast
        // rising versus the flat-seeded 100 at bar 9, and Close(110) crosses above mid(105) from
        // prevBar's Close(100) <= midPrevBar(100).
        bars.Add(Bar(10, 105, 112, 104, 110));
        return bars;
    }

    [Fact]
    public void SideDefaultsToSell_UnlikeOtherStrategiesHereDefaultingToBuy()
    {
        var side = new EmaVwapSellStrategy().Parameters.Single(p => p.Key == "side");
        Assert.Equal(OptionTradeSimulator.SideSell, side.Default);
    }

    [Fact]
    public void EntersBullish_WhenCrossTrendSlopeAndVwapAllAgree()
    {
        var bars = BullishCrossFixture();
        var context = Context(bars, VolumeBars(bars));

        var signals = new EmaVwapSellStrategy().EntrySignals(context, Parameters());

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal(bars[10].Time, entry.TimeUtc);
        Assert.Equal("Bullish", entry.Direction);
    }

    [Fact]
    public void NoEntry_WhenNoVolumeDataSoSessionVwapIsUnavailable()
    {
        var bars = BullishCrossFixture();
        // No SpotVolumeBarsOneMinute at all - the exact "this account's Dhan plan isn't delivering
        // real index volume" case VwapCalculator's own doc comment describes.
        var context = Context(bars, Array.Empty<CandleWithVolume>());

        var signals = new EmaVwapSellStrategy().EntrySignals(context, Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("VWAP"));
    }

    [Fact]
    public void NoEntry_WhenDirectionFilterExcludesTheAlignment()
    {
        var bars = BullishCrossFixture();
        var context = Context(bars, VolumeBars(bars));

        // DirectionShortOnly = 2 - a bullish alignment must be rejected outright.
        var signals = new EmaVwapSellStrategy().EntrySignals(context, Parameters(direction: 2));

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
    }

    [Fact]
    public void NoEntry_WhenThePreviousCandleLooksLikeASpike()
    {
        // Bars 0-8: a small, steady range (High/Low +-1) but the same flat Close(100) as FlatSeed -
        // EMA only ever reads Close, so this still converges fast/mid/slow to exactly 100 by bar 8,
        // same as the plain flat seed, while giving IsPrevCandleASpike a real (non-zero) baseline
        // average range to compare against.
        var bars = Enumerable.Range(0, 9).Select(i => Bar(i, 100, 101, 99, 100)).ToList();
        // Bar 9 (the PREVIOUS candle relative to the trigger bar below) - a huge High/Low swing that
        // still closes flat at 100, so it does not disturb the EMA values at all, only its own range.
        bars.Add(Bar(9, 100, 140, 60, 100));
        // Bar 10: the same trigger as BullishCrossFixture - crosses above mid, trend/slope/VWAP all
        // still agree.
        bars.Add(Bar(10, 105, 112, 104, 110));
        var context = Context(bars, VolumeBars(bars));

        var parameters = Parameters();
        parameters["maxPrevCandleRangeMultiple"] = 2;
        var signals = new EmaVwapSellStrategy().EntrySignals(context, parameters);

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Summary.Contains("spike"));
    }

    [Fact]
    public void Enters_WhenPrevCandleSpikeFilterIsOff_DespiteTheSameWidePrevCandle()
    {
        var bars = Enumerable.Range(0, 9).Select(i => Bar(i, 100, 101, 99, 100)).ToList();
        bars.Add(Bar(9, 100, 140, 60, 100));
        bars.Add(Bar(10, 105, 112, 104, 110));
        var context = Context(bars, VolumeBars(bars));

        // maxPrevCandleRangeMultiple defaults to 0 (off) in Parameters() - the filter never runs.
        var signals = new EmaVwapSellStrategy().EntrySignals(context, Parameters());

        Assert.Contains(signals, s => s.Kind == "Entry");
    }
}

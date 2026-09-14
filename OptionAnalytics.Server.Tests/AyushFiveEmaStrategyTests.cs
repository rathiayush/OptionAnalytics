using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers AyushFiveEmaStrategy's entry rule: a later candle's own CLOSE crossing
/// back through the 5 EMA, not a break of the alert candle's own high/low (the strategy's original
/// rule, changed at the user's explicit request - "entry should happen if later candle closes below
/// 5 ema"). EMA values below are hand-computed with the standard EMA(5) formula
/// (weight = 2/(period+1) = 1/3) off a flat 100-close seed, so each fixture's exact numbers are
/// deliberate, not incidental.</summary>
public sealed class AyushFiveEmaStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero); // 09:15 IST

    private static Candle Bar(int index, decimal open, decimal high, decimal low, decimal close) =>
        new(T0.AddMinutes(index), open, high, low, close);

    private static BacktestStrategyContext Context(IReadOnlyList<Candle> spotBars) => new()
    {
        Underlying = "NIFTY",
        TimeframeMinutes = 1,
        Step = 50,
        SpotBars = spotBars,
        SpotBarsOneMinute = spotBars,
        SpotVolumeBarsOneMinute = Array.Empty<CandleWithVolume>(),
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

    private static Dictionary<string, decimal> Parameters() => new()
    {
        ["emaPeriod"] = 5,
        ["direction"] = 0, // both sides
        ["alertMaxAgeBars"] = 0,
        ["signalStartMinutes"] = 0,
        ["exitOnEmaTouch"] = 1,
    };

    // 8 flat bars at a constant close of 100 - EMA(5) of a constant series is that same constant
    // forever, once seeded, regardless of exactly which bar the seed lands on.
    private static List<Candle> FlatSeed() =>
        Enumerable.Range(0, 8).Select(i => Bar(i, 100, 100, 100, 100)).ToList();

    [Fact]
    public void BreakingTheAlertCandlesLow_AloneIsNoLongerAnEntry_OnlyTheCloseCrossingTheEmaIs()
    {
        var bars = FlatSeed();

        // Bar 8: a genuine exhaustion candle, Low(120) clear above ema(~100) -> shortAlert forms.
        // ema8 = 138/3 + 100*2/3 = 112.667
        bars.Add(Bar(8, 125, 140, 120, 138));

        // Bar 9: its own Low(116) breaks bar 8's Low(120) - under the OLD rule this alone fired a
        // Bearish entry. Under the new rule it must NOT, because its Close(118) is still above
        // ema9 = 118/3 + 112.667*2/3 = 114.444 (and Low9 > ema9 too, so it rolls forward as the new
        // shortAlert rather than being cancelled by a touch).
        bars.Add(Bar(9, 119, 120, 116, 118));

        // Bar 10: a real reversal - Close(98) finally crosses below ema10 = 98/3 + 114.444*2/3 =
        // 108.963. This is the bar that must actually fire the entry.
        bars.Add(Bar(10, 118, 119, 95, 98));

        var context = Context(bars);
        var signals = new AyushFiveEmaStrategy().EntrySignals(context, Parameters());

        Assert.DoesNotContain(signals, s => s.TimeUtc == bars[9].Time && s.Kind == "Entry");

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal(bars[10].Time, entry.TimeUtc);
        Assert.Equal("Bearish", entry.Direction);
    }

    [Fact]
    public void BreakingTheAlertCandlesHigh_AloneIsNoLongerAnEntry_OnlyTheCloseCrossingTheEmaIs()
    {
        // Mirror of the bearish case: falling seed, an exhaustion candle entirely BELOW the EMA,
        // a bar whose High breaks the alert's own High without closing back above the EMA (no
        // entry), then a real reversal whose Close crosses back above the EMA (entry).
        var bars = FlatSeed();

        // ema8 = 62/3 + 100*2/3 = 87.333; High8(80) clear below ema8 -> longAlert forms.
        bars.Add(Bar(8, 75, 80, 60, 62));

        // High9(84) breaks bar 8's High(80). ema9 = 82/3+87.333*2/3 = 85.222; Close9(82) still
        // below ema9 and High9(84) < ema9 too, so no entry, and it rolls forward as the new longAlert.
        bars.Add(Bar(9, 81, 84, 80, 82));

        // ema10 = 102/3+85.222*2/3 = 90.815; Close10(102) crosses back above it - the real entry.
        bars.Add(Bar(10, 82, 105, 82, 102));

        var context = Context(bars);
        var signals = new AyushFiveEmaStrategy().EntrySignals(context, Parameters());

        Assert.DoesNotContain(signals, s => s.TimeUtc == bars[9].Time && s.Kind == "Entry");

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal(bars[10].Time, entry.TimeUtc);
        Assert.Equal("Bullish", entry.Direction);
    }

    [Fact]
    public void ATouchCancelsThePendingAlert_SoALaterCloseCrossAloneDoesNotEnter()
    {
        var bars = FlatSeed();

        // ema8 = 112.667 as before; shortAlert forms.
        bars.Add(Bar(8, 125, 140, 120, 138));

        // A bar that straddles ema9 (113.444): Low(110) <= ema9 <= High(118) - a touch, cancelling
        // the pending shortAlert outright. Its own Close(115) stays above ema9 so this is a touch,
        // not also an entry in its own right (step 1's close-cross check runs first and must stay
        // false here, or this would test nothing about touch-cancellation specifically).
        bars.Add(Bar(9, 112, 118, 110, 115));

        // Even though this bar's close would clearly cross back below whatever the EMA is now, there
        // is no pending alert left to confirm against - it was cancelled by the touch above.
        bars.Add(Bar(10, 112, 113, 90, 95));

        var context = Context(bars);
        var signals = new AyushFiveEmaStrategy().EntrySignals(context, Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
    }
}

using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers FiveEmaStrategy's entry rule: a later candle BREAKING the alert candle's own
/// low (short) or high (long) fires entry regardless of where that candle's own close ends up
/// relative to the EMA - the original Subhasish Pani rule, distinct from AyushFiveEmaStrategy's
/// close-cross variant (see that class's own tests). EMA values are hand-computed with the standard
/// EMA(5) formula (weight = 2/(period+1) = 1/3) off a flat 100-close seed.</summary>
public sealed class FiveEmaStrategyTests
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

    // Same context as Context(), but with real OBV/CDV series for the optional flow-confirmation
    // tests below - every other test in this file leaves these empty, which is exactly how the
    // filter must behave when left off (see RequireFlowConfirmation_Off... below).
    private static BacktestStrategyContext ContextWithFlow(
        IReadOnlyList<Candle> spotBars, IReadOnlyList<ObvPoint> ceSeries, IReadOnlyList<ObvPoint> peSeries) => new()
    {
        Underlying = "NIFTY",
        TimeframeMinutes = 1,
        Step = 50,
        SpotBars = spotBars,
        SpotBarsOneMinute = spotBars,
        SpotVolumeBarsOneMinute = Array.Empty<CandleWithVolume>(),
        ConfluenceSignalsAscending = Array.Empty<BacktestSignal>(),
        AllSignals = Array.Empty<BacktestSignal>(),
        ObvCeSeries = ceSeries,
        ObvPeSeries = peSeries,
        CdvCeSeries = ceSeries,
        CdvPeSeries = peSeries,
        GetOptionBars = (_, _) => Array.Empty<Candle>(),
        GetOptionBarsOneMinute = (_, _) => Array.Empty<Candle>(),
        AtmCeBars = Array.Empty<Candle>(),
        AtmPeBars = Array.Empty<Candle>(),
        AtmCeVolumeBars = Array.Empty<CandleWithVolume>(),
        AtmPeVolumeBars = Array.Empty<CandleWithVolume>(),
        AtmStrike = null,
    };

    // 8 flat bars at a constant close of 100 - EMA(5) of a constant series is that same constant
    // forever, once seeded, regardless of exactly which bar the seed lands on.
    private static List<Candle> FlatSeed() =>
        Enumerable.Range(0, 8).Select(i => Bar(i, 100, 100, 100, 100)).ToList();

    [Fact]
    public void EntersImmediately_WhenALaterCandleBreaksTheAlertCandlesLow_EvenIfItsCloseStaysAboveTheEma()
    {
        var bars = FlatSeed();

        // Bar 8: Low(120) clear above ema8 (~112.667) -> shortAlert forms.
        bars.Add(Bar(8, 125, 140, 120, 138));

        // Bar 9: Low(116) breaks bar 8's Low(120) - the OLD rule fires a Bearish entry right here,
        // even though Close(118) is still comfortably above ema9 (~114.444) and would NOT confirm
        // AyushFiveEmaStrategy's own close-cross rule (see that class's own tests using this exact
        // fixture, where this same bar does NOT produce an entry).
        bars.Add(Bar(9, 119, 120, 116, 118));

        var context = Context(bars);
        var signals = new FiveEmaStrategy().EntrySignals(context, Parameters());

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal(bars[9].Time, entry.TimeUtc);
        Assert.Equal("Bearish", entry.Direction);
    }

    [Fact]
    public void EntersImmediately_WhenALaterCandleBreaksTheAlertCandlesHigh_EvenIfItsCloseStaysBelowTheEma()
    {
        var bars = FlatSeed();

        // ema8 = 62/3 + 100*2/3 = 87.333; High8(80) clear below ema8 -> longAlert forms.
        bars.Add(Bar(8, 75, 80, 60, 62));

        // High9(84) breaks bar 8's High(80) - the OLD rule fires a Bullish entry right here, even
        // though Close(82) stays below ema9 (~85.222).
        bars.Add(Bar(9, 81, 84, 80, 82));

        var context = Context(bars);
        var signals = new FiveEmaStrategy().EntrySignals(context, Parameters());

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal(bars[9].Time, entry.TimeUtc);
        Assert.Equal("Bullish", entry.Direction);
    }

    [Fact]
    public void NoEntry_WhileTheAlertCandlesOwnLowHasNotBeenBroken()
    {
        var bars = FlatSeed();

        // shortAlert forms at bar 8 (Low 120).
        bars.Add(Bar(8, 125, 140, 120, 138));

        // Bar 9's own Low(122) stays ABOVE bar 8's Low(120) - nothing to break, so no entry, and
        // this bar itself becomes the new (higher) shortAlert.
        bars.Add(Bar(9, 128, 135, 122, 130));

        var context = Context(bars);
        var signals = new FiveEmaStrategy().EntrySignals(context, Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
    }

    [Fact]
    public void ATouchCancelsThePendingAlert_SoALaterBreakOfItsOldLevelDoesNotEnter()
    {
        var bars = FlatSeed();

        // shortAlert forms at bar 8 (Low 120).
        bars.Add(Bar(8, 125, 140, 120, 138));

        // Bar 9's own Low(120.2) stays just ABOVE bar 8's Low(120) - the old rule's break check
        // (Low < shortAlert.Low) runs BEFORE the touch check below and must stay false here, or
        // this test would just be re-proving the ordinary "break fires" case. Its Close(136) pulls
        // ema9 up to ~120.444, so Low9 <= ema9 <= High9(138) is a genuine touch, cancelling the
        // pending alert outright.
        bars.Add(Bar(9, 125, 138, 120.2m, 136));

        // This bar's Low(90) is far below bar 8's original Low(120), but there is no alert left to
        // break - it was cancelled by the touch above.
        bars.Add(Bar(10, 112, 113, 90, 95));

        var context = Context(bars);
        var signals = new FiveEmaStrategy().EntrySignals(context, Parameters());

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
    }

    // ---- Optional flow confirmation (off by default) ----------------------------------------------
    // Reuses EntersImmediately_WhenALaterCandleBreaksTheAlertCandlesLow...'s own fixture - a Bearish
    // entry at bar 9 (T0+9min) - so only the flow gate itself differs between these three tests.

    private static List<Candle> BearishBreakFixture()
    {
        var bars = FlatSeed();
        bars.Add(Bar(8, 125, 140, 120, 138)); // shortAlert forms
        bars.Add(Bar(9, 119, 120, 116, 118)); // breaks it - Bearish entry, absent any flow filter
        return bars;
    }

    [Fact]
    public void RequireFlowConfirmation_OffByDefault_EntersRegardlessOfFlow()
    {
        var bars = BearishBreakFixture();
        // CE dominant, not PE - would FAIL a bearish flow check if the filter were on.
        var ce = new[] { new ObvPoint(T0.AddMinutes(4), 50), new ObvPoint(T0.AddMinutes(9), 140) };
        var pe = new[] { new ObvPoint(T0.AddMinutes(4), 100), new ObvPoint(T0.AddMinutes(9), 100) };
        var context = ContextWithFlow(bars, ce, pe);

        var parameters = Parameters(); // requireFlowConfirmation omitted - defaults to off
        var signals = new FiveEmaStrategy().EntrySignals(context, parameters);

        Assert.Contains(signals, s => s.Kind == "Entry");
    }

    [Fact]
    public void RequireFlowConfirmation_On_RejectsWhenFlowDoesNotFavorTheDirection()
    {
        var bars = BearishBreakFixture();
        // Same non-favoring series as above, but now the filter is actually on.
        var ce = new[] { new ObvPoint(T0.AddMinutes(4), 50), new ObvPoint(T0.AddMinutes(9), 140) };
        var pe = new[] { new ObvPoint(T0.AddMinutes(4), 100), new ObvPoint(T0.AddMinutes(9), 100) };
        var context = ContextWithFlow(bars, ce, pe);

        var parameters = Parameters();
        parameters["requireFlowConfirmation"] = 1;
        var signals = new FiveEmaStrategy().EntrySignals(context, parameters);

        Assert.DoesNotContain(signals, s => s.Kind == "Entry");
        Assert.Contains(signals, s => s.Kind == "Rejected" && s.Direction == "Bearish" && s.Summary.Contains("flow"));
    }

    [Fact]
    public void RequireFlowConfirmation_On_EntersWhenFlowFavorsAndRisesTowardTheDirection()
    {
        var bars = BearishBreakFixture();
        // PE above CE and rising - favors the Bearish direction this break would enter.
        var ce = new[] { new ObvPoint(T0.AddMinutes(4), 100), new ObvPoint(T0.AddMinutes(9), 100) };
        var pe = new[] { new ObvPoint(T0.AddMinutes(4), 50), new ObvPoint(T0.AddMinutes(9), 140) };
        var context = ContextWithFlow(bars, ce, pe);

        var parameters = Parameters();
        parameters["requireFlowConfirmation"] = 1;
        var signals = new FiveEmaStrategy().EntrySignals(context, parameters);

        var entry = Assert.Single(signals, s => s.Kind == "Entry");
        Assert.Equal("Bearish", entry.Direction);
    }
}

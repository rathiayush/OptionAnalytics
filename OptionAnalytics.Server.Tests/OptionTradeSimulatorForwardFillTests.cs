using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers OptionTradeSimulator.Run's forward-fill fallback for a signal whose own bucket
/// has no option bar at all - a genuine production case: an OTM strike can sit with zero trades for
/// a few minutes (the lunch lull is the common one) even while its own contract prints normally
/// just before and after, so AggregateCandles never produces a bucket for that exact instant.
/// Before this fix, that read as "No Data" indistinguishably from a strike with no history at all;
/// now the last real print earlier the SAME day is used as the entry price (the standard
/// forward-fill convention for a quiet instrument), while the reported entry TIME still reflects
/// when the signal itself fired, not the stale bar it was priced off.</summary>
public sealed class OptionTradeSimulatorForwardFillTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero); // 09:30 IST
    private static readonly DateTimeOffset NextDay = new(2026, 1, 6, 4, 0, 0, TimeSpan.Zero); // 09:30 IST, next trading day

    private static Candle Bar(DateTimeOffset time, decimal close) => new(time, close, close, close, close);

    private static BacktestStrategyContext Context(IReadOnlyList<Candle> spotBars, IReadOnlyList<Candle> optionBars) => new()
    {
        Underlying = "NIFTY",
        TimeframeMinutes = 1,
        Step = 50,
        SpotBars = spotBars,
        SpotBarsOneMinute = spotBars,
        ConfluenceSignalsAscending = Array.Empty<BacktestSignal>(),
        AllSignals = Array.Empty<BacktestSignal>(),
        ObvCeSeries = Array.Empty<ObvPoint>(),
        ObvPeSeries = Array.Empty<ObvPoint>(),
        CdvCeSeries = Array.Empty<ObvPoint>(),
        CdvPeSeries = Array.Empty<ObvPoint>(),
        GetOptionBars = (_, _) => optionBars,
        GetOptionBarsOneMinute = (_, _) => optionBars,
        AtmCeBars = Array.Empty<Candle>(),
        AtmPeBars = Array.Empty<Candle>(),
        AtmCeVolumeBars = Array.Empty<CandleWithVolume>(),
        AtmPeVolumeBars = Array.Empty<CandleWithVolume>(),
        AtmStrike = null,
    };

    private static Dictionary<string, decimal> Parameters() => new()
    {
        ["side"] = OptionTradeSimulator.SideBuy,
        ["otmSteps"] = 0,
        ["slPoints"] = 10,
        ["tpPoints"] = 20,
    };

    [Fact]
    public void Run_NoBarAtSignalsOwnBucketButAnEarlierBarExistsSameDay_EntersAtTheLastPrintedPrice()
    {
        var signalTime = T0.AddMinutes(1); // 09:31 - the strike's own bucket is missing here
        var spotBars = new[] { Bar(T0, 24000), Bar(signalTime, 24000), Bar(T0.AddMinutes(2), 24000) };
        var optionBars = new[]
        {
            Bar(T0, 100), // last real print before the gap
            // nothing at signalTime (09:31) - thin liquidity, no trade this exact minute
            Bar(T0.AddMinutes(2), 110), // trading resumes right after
        };
        var context = Context(spotBars, optionBars);

        var trades = OptionTradeSimulator.Run(context, new[] { (signalTime, "Bullish") }, Parameters());

        var trade = Assert.Single(trades);
        Assert.NotEqual("NoData", trade.ExitReason);
        Assert.Equal(100, trade.EntryPrice); // priced off the last real print, not the missing bucket
        Assert.Equal(signalTime.AddMinutes(1), trade.EntryTimeUtc); // but timed off the signal itself
    }

    [Fact]
    public void Run_OnlyEarlierBarIsFromThePreviousDay_NeverBridgesOvernightAndReadsAsNoData()
    {
        // The only bar before this signal is on an EARLIER trading day - a premium is not "the
        // same" after a full session of theta decay and the next day's re-open, so this must NOT
        // forward-fill across the day boundary the way an intraday gap does.
        var signalTime = NextDay.AddMinutes(1); // 09:31 next day - still nothing printed this early
        var spotBars = new[] { Bar(T0, 24000), Bar(signalTime, 24000) };
        var optionBars = new[]
        {
            Bar(T0, 100), // yesterday's last print
            // nothing yet today at or before signalTime
        };
        var context = Context(spotBars, optionBars);

        var trades = OptionTradeSimulator.Run(context, new[] { (signalTime, "Bullish") }, Parameters());

        var trade = Assert.Single(trades);
        Assert.Equal("NoData", trade.ExitReason);
    }

    [Fact]
    public void Run_NoBarAtAllOnTheSignalsOwnDay_StillReadsAsNoData()
    {
        // No fallback candidate exists at all (not even an earlier one, same day) - this strike
        // genuinely has nothing for this day, the case the fix must leave alone.
        var signalTime = T0.AddMinutes(1);
        var spotBars = new[] { Bar(T0, 24000), Bar(signalTime, 24000) };
        var optionBars = Array.Empty<Candle>();
        var context = Context(spotBars, optionBars);

        var trades = OptionTradeSimulator.Run(context, new[] { (signalTime, "Bullish") }, Parameters());

        var trade = Assert.Single(trades);
        Assert.Equal("NoData", trade.ExitReason);
    }

    [Fact]
    public void Run_ExactBarAtSignalTimeExists_UsesItDirectlyNotTheFallback()
    {
        // The common case is untouched: an exact match always wins over any earlier bar.
        var signalTime = T0.AddMinutes(1);
        var spotBars = new[] { Bar(T0, 24000), Bar(signalTime, 24000), Bar(T0.AddMinutes(2), 24000) };
        var optionBars = new[] { Bar(T0, 100), Bar(signalTime, 105), Bar(T0.AddMinutes(2), 110) };
        var context = Context(spotBars, optionBars);

        var trades = OptionTradeSimulator.Run(context, new[] { (signalTime, "Bullish") }, Parameters());

        var trade = Assert.Single(trades);
        Assert.Equal(105, trade.EntryPrice);
        Assert.Equal(signalTime.AddMinutes(1), trade.EntryTimeUtc);
    }
}

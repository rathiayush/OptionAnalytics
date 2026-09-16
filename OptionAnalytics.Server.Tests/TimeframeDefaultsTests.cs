using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers the per-timeframe parameter-default mechanism (IBacktestStrategy.
/// DefaultsForTimeframe + BacktestUtil.ApplyTimeframeDefaults) added so GET .../strategies can
/// pre-fill a parameter form with values suited to whichever page timeframe is selected, rather
/// than one fixed number that only really fits one of them.</summary>
public sealed class TimeframeDefaultsTests
{
    [Theory]
    [InlineData(1, 1)]
    [InlineData(2, 2)]
    [InlineData(3, 2)]
    [InlineData(4, 3)]
    [InlineData(5, 3)]
    [InlineData(15, 3)]
    public void TimeframeScale_Buckets_AtOneThreeFiveMinutes(int timeframeMinutes, int expectedScale)
    {
        Assert.Equal(expectedScale, OptionTradeSimulator.TimeframeScale(timeframeMinutes));
    }

    [Fact]
    public void ApplyTimeframeDefaults_ReturnsParametersUnchanged_WhenNoTimeframeGiven()
    {
        var strategy = new FiveEmaStrategy();

        var result = BacktestUtil.ApplyTimeframeDefaults(strategy, null);

        Assert.Same(strategy.Parameters, result);
    }

    [Theory]
    [InlineData(1, 10, 20)]
    [InlineData(3, 20, 40)]
    [InlineData(5, 30, 60)]
    public void ApplyTimeframeDefaults_ScalesTheStandardStopAndTarget_ViaTheDefaultInterfaceImplementation(
        int timeframeMinutes, decimal expectedSl, decimal expectedTp)
    {
        // FiveEmaStrategy declares no DefaultsForTimeframe override of its own, so this exercises
        // IBacktestStrategy's own default implementation.
        var strategy = new FiveEmaStrategy();

        var result = BacktestUtil.ApplyTimeframeDefaults(strategy, timeframeMinutes);

        Assert.Equal(expectedSl, result.Single(p => p.Key == "slPoints").Default);
        Assert.Equal(expectedTp, result.Single(p => p.Key == "tpPoints").Default);
    }

    [Fact]
    public void ApplyTimeframeDefaults_SrFlowSellStrategy_AlsoScalesItsOwnExtraPointsParameters_ButNotBarCounts()
    {
        var strategy = new SrFlowSellStrategy();
        var staticSrTimeframe = strategy.Parameters.Single(p => p.Key == "srTimeframeMinutes").Default;
        var staticSrLookback = strategy.Parameters.Single(p => p.Key == "srLookbackBars").Default;

        var result = BacktestUtil.ApplyTimeframeDefaults(strategy, 5);

        Assert.Equal(30m, result.Single(p => p.Key == "slPoints").Default);
        Assert.Equal(60m, result.Single(p => p.Key == "tpPoints").Default);
        Assert.Equal(30m, result.Single(p => p.Key == "levelBreakBufferPoints").Default);
        Assert.Equal(30m, result.Single(p => p.Key == "retestTolerancePoints").Default);
        // Deliberately untouched - the S/R channel's own timeframe is independent of the page's.
        Assert.Equal(staticSrTimeframe, result.Single(p => p.Key == "srTimeframeMinutes").Default);
        Assert.Equal(staticSrLookback, result.Single(p => p.Key == "srLookbackBars").Default);
    }

    [Fact]
    public void ApplyTimeframeDefaults_RegimeAdaptiveStrategy_ScalesPointAndSlopeThresholds_NotAdxRsiOrBarCounts()
    {
        var strategy = new RegimeAdaptiveStrategy();
        var staticRegime15EmaFast = strategy.Parameters.Single(p => p.Key == "regime15EmaFast").Default;
        var staticCascadeSlopeLookbackBars = strategy.Parameters.Single(p => p.Key == "cascadeSlopeLookbackBars").Default;
        var staticEntry1CrossWithinBars = strategy.Parameters.Single(p => p.Key == "entry1CrossWithinBars").Default;
        var staticRegime15AdxMin = strategy.Parameters.Single(p => p.Key == "regime15AdxMin").Default;
        var staticEntry1AdxMin = strategy.Parameters.Single(p => p.Key == "entry1AdxMin").Default;
        var staticRangeAtrMultiple = strategy.Parameters.Single(p => p.Key == "rangeAtrMultiple").Default;
        var staticRsiNeutralLow = strategy.Parameters.Single(p => p.Key == "rsiNeutralLow").Default;
        var staticRsiNeutralHigh = strategy.Parameters.Single(p => p.Key == "rsiNeutralHigh").Default;

        var result = BacktestUtil.ApplyTimeframeDefaults(strategy, 5);

        // Points, ATR%-of-price, and the four slope-min-percent thresholds all scale by
        // sqrt(timeframeMinutes) (~2.236 at 5 minutes) - see this class's own DefaultsForTimeframe
        // doc comment for why a %-per-N-bars slope is a distance too, same as points/ATR%, and for
        // why this uses its own continuous sqrt-time factor rather than the shared
        // OptionTradeSimulator.TimeframeScale 3-step bucket.
        Assert.Equal(22.36m, result.Single(p => p.Key == "slPoints").Default);
        Assert.Equal(44.72m, result.Single(p => p.Key == "tpPoints").Default);
        Assert.Equal(3.35m, result.Single(p => p.Key == "atrNormalHighPercent").Default);
        Assert.Equal(5.59m, result.Single(p => p.Key == "atrExtremePercent").Default);
        Assert.Equal(0.112m, result.Single(p => p.Key == "regime15SlopeMinPercent").Default);
        Assert.Equal(0.056m, result.Single(p => p.Key == "confirm3SlopeMinPercent").Default);
        Assert.Equal(0.034m, result.Single(p => p.Key == "entry1SlopeMinPercent").Default);
        Assert.Equal(0.045m, result.Single(p => p.Key == "chopFlatSlopePercent").Default);
        // Deliberately untouched - EMA/lookback/cross-window BAR COUNTS already mean the same relative
        // thing once each cascade layer's own bar duration re-bases with the page timeframe, and
        // ADX/RSI are unitless 0-100 oscillators by construction - see the doc comment.
        Assert.Equal(staticRegime15EmaFast, result.Single(p => p.Key == "regime15EmaFast").Default);
        Assert.Equal(staticCascadeSlopeLookbackBars, result.Single(p => p.Key == "cascadeSlopeLookbackBars").Default);
        Assert.Equal(staticEntry1CrossWithinBars, result.Single(p => p.Key == "entry1CrossWithinBars").Default);
        Assert.Equal(staticRegime15AdxMin, result.Single(p => p.Key == "regime15AdxMin").Default);
        Assert.Equal(staticEntry1AdxMin, result.Single(p => p.Key == "entry1AdxMin").Default);
        Assert.Equal(staticRangeAtrMultiple, result.Single(p => p.Key == "rangeAtrMultiple").Default);
        Assert.Equal(staticRsiNeutralLow, result.Single(p => p.Key == "rsiNeutralLow").Default);
        Assert.Equal(staticRsiNeutralHigh, result.Single(p => p.Key == "rsiNeutralHigh").Default);
    }

    [Fact]
    public void ApplyTimeframeDefaults_RegimeAdaptiveStrategy_GivesEachOfTheFourSelectableTimeframesItsOwnDistinctSlPoints()
    {
        // TIMEFRAME_OPTIONS (shared.jsx) only ever offers 1/3/5/15 minutes - the point of this test is
        // that all four now get a DIFFERENT value, unlike OptionTradeSimulator.TimeframeScale's shared
        // 3-step bucket, which used to give 5-minute and 15-minute pages the identical 3x multiplier.
        var strategy = new RegimeAdaptiveStrategy();

        var slByTimeframe = new[] { 1, 3, 5, 15 }
            .Select(tf => BacktestUtil.ApplyTimeframeDefaults(strategy, tf).Single(p => p.Key == "slPoints").Default)
            .ToList();

        Assert.Equal(new[] { 10m, 17.32m, 22.36m, 38.73m }, slByTimeframe);
        Assert.Equal(4, slByTimeframe.Distinct().Count());
    }
}

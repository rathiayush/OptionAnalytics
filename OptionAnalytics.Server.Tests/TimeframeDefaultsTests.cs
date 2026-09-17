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

}

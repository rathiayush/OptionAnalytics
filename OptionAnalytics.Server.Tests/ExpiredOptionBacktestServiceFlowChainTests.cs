using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers ExpiredOptionBacktestService.BuildFlowChainSeries - the piece that reconstructs
/// EmaCrossAtmFlowStrategy's own AtmCeBars/AtmPeBars/ObvCeSeries/ObvPeSeries/CdvCeSeries/CdvPeSeries
/// from a wide flow-chain band, so that strategy can run against Expired Backtest too. Focused on
/// STRUCTURAL correctness (which member backs AtmCeBars, that OBV/CDV genuinely sum contributions
/// across every band member rather than reading just one) rather than exact OBV/CDV numbers - those
/// come from CdvUnderlyingState's own already-tested delta-weighting/smoothing math, reused here
/// rather than re-verified.</summary>
public sealed class ExpiredOptionBacktestServiceFlowChainTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero); // 09:15 IST

    // A bullish-shaped bar with close AT the high (not merely off a degenerate O=H=L=C bar) so
    // BarProxyDelta's buyVol/sellVol split - which depends on where close sits WITHIN the High-Low
    // range - actually attributes the bar's volume entirely to the buy side; a bar with close
    // exactly midway between high and low (e.g. close +-1) is a doji and yields zero delta too,
    // which would make CDV comparisons meaningless regardless of chain size.
    private static (CandleWithVolume Bar, decimal? Strike, decimal? Spot) Entry(DateTimeOffset time, decimal close, long volume) =>
        (new CandleWithVolume(time, close - 2m, close, close - 2m, close, volume), null, null);

    private static ExpiredOptionBacktestService.StrikeBandMember Member(int steps, params (DateTimeOffset Time, decimal Close, long Volume)[] bars)
    {
        var entries = bars.Select(b => Entry(b.Time, b.Close, b.Volume)).ToList();
        return new ExpiredOptionBacktestService.StrikeBandMember(steps, entries, entries, new List<PossibleSplice>());
    }

    private static List<Candle> SpotBars(int count, decimal start = 24000m) =>
        Enumerable.Range(0, count).Select(i => new Candle(T0.AddMinutes(i), start, start, start, start)).ToList();

    [Fact]
    public void AtmCeBarsAndAtmPeBars_ComeFromTheStepsZeroMemberSpecifically()
    {
        var ceChain = new List<ExpiredOptionBacktestService.StrikeBandMember>
        {
            Member(-1, (T0, 50m, 100)),
            Member(0, (T0, 999m, 100)), // the one that must back AtmCeBars
            Member(1, (T0, 60m, 100)),
        };
        var peChain = new List<ExpiredOptionBacktestService.StrikeBandMember>
        {
            Member(-1, (T0, 70m, 100)),
            Member(0, (T0, 888m, 100)), // the one that must back AtmPeBars
            Member(1, (T0, 80m, 100)),
        };

        var result = ExpiredOptionBacktestService.BuildFlowChainSeries("NIFTY", ceChain, peChain, SpotBars(1), step: 50);

        var ceBar = Assert.Single(result.AtmCeBars);
        Assert.Equal(999m, ceBar.Close);
        var peBar = Assert.Single(result.AtmPeBars);
        Assert.Equal(888m, peBar.Close);
    }

    [Fact]
    public void ObvAndCdv_SumContributionsAcrossTheWholeChain_NotJustOneMember()
    {
        // Both members trend the SAME direction (rising close, bullish bar shape) - a chain with TWO
        // contributing members should produce a LARGER-magnitude OBV/CDV total than a chain with
        // only one, proving the sum is genuinely across every member, not just reading one strike.
        var bars = Enumerable.Range(0, 10).Select(i => (T0.AddMinutes(i), 100m + i * 5, 1000L)).ToArray();

        var oneChain = new List<ExpiredOptionBacktestService.StrikeBandMember> { Member(0, bars) };
        var twoChain = new List<ExpiredOptionBacktestService.StrikeBandMember> { Member(0, bars), Member(1, bars) };
        var emptyPe = new List<ExpiredOptionBacktestService.StrikeBandMember> { Member(0), Member(1) };
        var spot = SpotBars(10);

        var oneResult = ExpiredOptionBacktestService.BuildFlowChainSeries("NIFTY", oneChain, new List<ExpiredOptionBacktestService.StrikeBandMember> { Member(0) }, spot, step: 50);
        var twoResult = ExpiredOptionBacktestService.BuildFlowChainSeries("NIFTY", twoChain, emptyPe, spot, step: 50);

        var oneObvLast = oneResult.ObvCeSeries[^1].Obv;
        var twoObvLast = twoResult.ObvCeSeries[^1].Obv;
        var oneCdvLast = oneResult.CdvCeSeries[^1].Obv;
        var twoCdvLast = twoResult.CdvCeSeries[^1].Obv;

        Assert.True(twoObvLast > oneObvLast, $"expected two-member OBV ({twoObvLast}) to exceed one-member OBV ({oneObvLast})");
        Assert.True(twoCdvLast > oneCdvLast, $"expected two-member CDV ({twoCdvLast}) to exceed one-member CDV ({oneCdvLast})");
    }

    [Fact]
    public void EmptyMember_IsSkippedRatherThanThrowing()
    {
        var ceChain = new List<ExpiredOptionBacktestService.StrikeBandMember>
        {
            Member(0), // no bars at all
        };
        var peChain = new List<ExpiredOptionBacktestService.StrikeBandMember> { Member(0) };

        var result = ExpiredOptionBacktestService.BuildFlowChainSeries("NIFTY", ceChain, peChain, SpotBars(1), step: 50);

        Assert.Empty(result.AtmCeBars);
        Assert.Empty(result.AtmPeBars);
        Assert.Empty(result.ObvCeSeries);
        Assert.Empty(result.CdvCeSeries);
    }

    [Fact]
    public void NoSpotHistoryOrInvalidStep_StillReturnsAtmBars_ButNoFlowSeries()
    {
        var ceChain = new List<ExpiredOptionBacktestService.StrikeBandMember> { Member(0, (T0, 100m, 10)) };
        var peChain = new List<ExpiredOptionBacktestService.StrikeBandMember> { Member(0, (T0, 200m, 10)) };

        var noSpot = ExpiredOptionBacktestService.BuildFlowChainSeries("NIFTY", ceChain, peChain, Array.Empty<Candle>(), step: 50);
        Assert.NotEmpty(noSpot.AtmCeBars);
        Assert.Empty(noSpot.ObvCeSeries);

        var badStep = ExpiredOptionBacktestService.BuildFlowChainSeries("NIFTY", ceChain, peChain, SpotBars(1), step: 0);
        Assert.NotEmpty(badStep.AtmPeBars);
        Assert.Empty(badStep.CdvPeSeries);
    }

    [Fact]
    public void ObvSeries_HasNoContributionOnTheVeryFirstBar()
    {
        // OBV needs a PREVIOUS close to compare against - the first bar of a fresh series can only
        // ever establish the baseline, matching CdvUnderlyingState.BuildAggregateObvNoLock's own
        // "first bar contributes nothing" rule.
        var bars = new[] { (T0, 100m, 500L), (T0.AddMinutes(1), 120m, 500L) };
        var ceChain = new List<ExpiredOptionBacktestService.StrikeBandMember> { Member(0, bars) };
        var peChain = new List<ExpiredOptionBacktestService.StrikeBandMember> { Member(0) };

        var result = ExpiredOptionBacktestService.BuildFlowChainSeries("NIFTY", ceChain, peChain, SpotBars(2), step: 50);

        Assert.Equal(2, result.ObvCeSeries.Count);
        Assert.Equal(0m, result.ObvCeSeries[0].Obv);
    }
}

using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Pins down the two pure formulas CDV and OBV both build on -
/// CdvUnderlyingState.BarProxyDelta (the close-in-range buy/sell volume split used for historical
/// backfill) and ComputeDeltaWeight (the sigmoid moneyness weighting both live CDV and OBV apply) -
/// neither of which had any direct test coverage before this. Made internal + this project's
/// existing InternalsVisibleTo (see AssemblyInfo.cs) to reach them without needing a live tick feed
/// just to exercise pure arithmetic.</summary>
public sealed class CdvDeltaMathTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 4, 0, 0, TimeSpan.Zero);

    [Fact]
    public void BarProxyDelta_CloseAtHigh_IsAllBuyVolume()
    {
        var bar = new CandleWithVolume(T0, Open: 100, High: 110, Low: 90, Close: 110, Volume: 1000);

        var delta = CdvUnderlyingState.BarProxyDelta(bar);

        Assert.Equal(1000m, delta);
    }

    [Fact]
    public void BarProxyDelta_CloseAtLow_IsAllSellVolume()
    {
        var bar = new CandleWithVolume(T0, Open: 100, High: 110, Low: 90, Close: 90, Volume: 1000);

        var delta = CdvUnderlyingState.BarProxyDelta(bar);

        Assert.Equal(-1000m, delta);
    }

    [Fact]
    public void BarProxyDelta_CloseAtMidpoint_NetsToZero()
    {
        var bar = new CandleWithVolume(T0, Open: 100, High: 110, Low: 90, Close: 100, Volume: 1000);

        var delta = CdvUnderlyingState.BarProxyDelta(bar);

        Assert.Equal(0m, delta);
    }

    [Fact]
    public void BarProxyDelta_CloseThreeQuartersUpTheRange_SplitsProportionally()
    {
        // Close 15 above a 20-point range's low (90..110) - 75% buy / 25% sell -> a 50% net lean.
        var bar = new CandleWithVolume(T0, Open: 100, High: 110, Low: 90, Close: 105, Volume: 1000);

        var delta = CdvUnderlyingState.BarProxyDelta(bar);

        Assert.Equal(500m, delta);
    }

    [Fact]
    public void BarProxyDelta_FlatBar_ReturnsZeroInsteadOfDividingByZero()
    {
        var bar = new CandleWithVolume(T0, Open: 100, High: 100, Low: 100, Close: 100, Volume: 5000);

        var delta = CdvUnderlyingState.BarProxyDelta(bar);

        Assert.Equal(0m, delta);
    }

    [Fact]
    public void ComputeDeltaWeight_AtTheMoney_IsExactlyHalfForBothSides()
    {
        // moneyness = 0 -> sigmoid(0) = 0.5 exactly, for both a call and a put.
        Assert.Equal(0.5m, CdvUnderlyingState.ComputeDeltaWeight(strike: 24000, spot: 24000, isCall: true));
        Assert.Equal(0.5m, CdvUnderlyingState.ComputeDeltaWeight(strike: 24000, spot: 24000, isCall: false));
    }

    [Fact]
    public void ComputeDeltaWeight_DeepItmCall_ApproachesOne()
    {
        // Strike far BELOW spot (~80% moneyness - the sigmoid's steepness constant, 8.5, needs a
        // large moneyness to actually saturate near its asymptote) - deep in the money for a call.
        var weight = CdvUnderlyingState.ComputeDeltaWeight(strike: 4000, spot: 24000, isCall: true);

        Assert.True(weight > 0.99m, $"expected close to 1, got {weight}");
    }

    [Fact]
    public void ComputeDeltaWeight_DeepOtmCall_ApproachesZero()
    {
        // Strike far ABOVE spot - deep out of the money for a call.
        var weight = CdvUnderlyingState.ComputeDeltaWeight(strike: 44000, spot: 24000, isCall: true);

        Assert.True(weight < 0.01m, $"expected close to 0, got {weight}");
    }

    [Fact]
    public void ComputeDeltaWeight_DeepItmPut_ApproachesOne()
    {
        // Strike far ABOVE spot - deep in the money for a put.
        var weight = CdvUnderlyingState.ComputeDeltaWeight(strike: 44000, spot: 24000, isCall: false);

        Assert.True(weight > 0.99m, $"expected close to 1, got {weight}");
    }

    [Fact]
    public void ComputeDeltaWeight_DeepOtmPut_ApproachesZero()
    {
        // Strike far BELOW spot - deep out of the money for a put.
        var weight = CdvUnderlyingState.ComputeDeltaWeight(strike: 4000, spot: 24000, isCall: false);

        Assert.True(weight < 0.01m, $"expected close to 0, got {weight}");
    }

    [Fact]
    public void ComputeDeltaWeight_CallAndPutAreMirrorImagesAroundAtm()
    {
        // A call ITM by X and a put ITM by that SAME distance X must weight identically - the
        // sigmoid is symmetric around moneyness=0, just evaluated on opposite sides for CE vs PE
        // (a call is ITM below spot, a put is ITM above it).
        var callItm = CdvUnderlyingState.ComputeDeltaWeight(strike: 23000, spot: 24000, isCall: true);
        var putItm = CdvUnderlyingState.ComputeDeltaWeight(strike: 25000, spot: 24000, isCall: false);
        var callOtm = CdvUnderlyingState.ComputeDeltaWeight(strike: 25000, spot: 24000, isCall: true);
        var putOtm = CdvUnderlyingState.ComputeDeltaWeight(strike: 23000, spot: 24000, isCall: false);

        Assert.Equal(callItm, putItm);
        Assert.Equal(callOtm, putOtm);
        // And the ITM side of either must weight more than the OTM side at the same distance.
        Assert.True(callItm > callOtm);
    }

    private static SpotTick Tick(uint securityId, decimal price, long volume, DateTimeOffset time) =>
        new(securityId, price, price, price, price, price, volume, 0, 0, time);

    [Fact]
    public void ApplyTick_TickRuleAccumulation_MatchesHandComputedRunningTotal()
    {
        // One ATM CE strike (strike == spot, so ComputeDeltaWeight is exactly 0.5 throughout - no
        // sigmoid arithmetic to second-guess) walked through up/down/unchanged ticks a full minute
        // apart each, so every tick closes the previous minute's bar and GetSeries() reports one
        // point per tick in order:
        //   t0 09:30 price=100 vol=1000 - FIRST tick for this strike: only seeds the volume
        //     baseline (Dhan's Volume is a day-cumulative total), contributes nothing. RunningCdv=0.
        //   t1 09:31 price=101 (UP)        vol=1500 (+500) -> +500*0.5 = +250  -> RunningCdv=250
        //   t2 09:32 price=99  (DOWN)      vol=2000 (+500) -> -500*0.5 = -250  -> RunningCdv=0
        //   t3 09:33 price=99  (UNCHANGED) vol=2500 (+500) -> carries the DOWN direction from t2,
        //                                                     -500*0.5 = -250  -> RunningCdv=-250
        const uint securityId = 1;
        var state = new CdvUnderlyingState("NIFTY");
        state.EnsureTracked(securityId, strike: 100, isCall: true);

        state.ApplyTick(Tick(securityId, 100, 1000, T0), currentSpot: 100);
        state.ApplyTick(Tick(securityId, 101, 1500, T0.AddMinutes(1)), currentSpot: 100);
        state.ApplyTick(Tick(securityId, 99, 2000, T0.AddMinutes(2)), currentSpot: 100);
        state.ApplyTick(Tick(securityId, 99, 2500, T0.AddMinutes(3)), currentSpot: 100);

        var series = state.GetSeries();

        Assert.Equal(4, series.Count);
        Assert.Equal(0m, series[0].CeCdv);
        Assert.Equal(250m, series[1].CeCdv);
        Assert.Equal(0m, series[2].CeCdv);
        Assert.Equal(-250m, series[3].CeCdv);
        // Nothing was ever tracked on the PE side.
        Assert.All(series, p => Assert.Equal(0m, p.PeCdv));
    }

    [Fact]
    public void ApplyTick_FirstTickEver_NeverCountsPriorDayVolumeAsADelta()
    {
        // Dhan's Volume field is the day's CUMULATIVE total, not a per-tick amount - the very first
        // tick this app ever sees for a contract must seed that baseline rather than treating
        // everything traded before this app subscribed as one giant fake delta on tick one.
        const uint securityId = 1;
        var state = new CdvUnderlyingState("NIFTY");
        state.EnsureTracked(securityId, strike: 100, isCall: true);

        // A contract already had 50,000 lots traded today before this app ever saw it.
        state.ApplyTick(Tick(securityId, 100, 50_000, T0), currentSpot: 100);

        var series = state.GetSeries();

        var only = Assert.Single(series);
        Assert.Equal(0m, only.CeCdv);
    }

    [Fact]
    public void GetObvSeries_SignedVolumeAccumulation_MatchesHandComputedRunningTotal()
    {
        // currentSpot is never supplied (stays 0 throughout), so BuildAggregateObvNoLock's own
        // "spot > 0 ? ComputeDeltaWeight(...) : 1m" fallback makes the weight exactly 1 - isolating
        // the sign(close-previousClose)*volume accumulation this test actually cares about from the
        // sigmoid weighting CdvDeltaMathTests's ComputeDeltaWeight tests already cover separately.
        // Four ticks, one full minute apart so each closes the previous minute's own bar:
        //   bar1 09:30 close=100 vol=0   (first-ever tick - baseline only, no delta volume)
        //   bar2 09:31 close=105 vol=300 - close > prev(100)          -> OBV += +300 -> running=300
        //   bar3 09:32 close=102 vol=500 - close < prev(105)          -> OBV += -500 -> running=-200
        //   bar4 09:33 close=102 vol=200 - close == prev(102)         -> OBV += 0    -> running=-200
        // All four land on the same IST trading day, so the daily baseline (subtracting the day's
        // own first value, 0) leaves every point unchanged, and with only 4 bars (well under
        // LookbackSmoothLen=9) the EMA has no seed yet and GetObvSeries falls back to these raw
        // baselined values directly.
        const uint securityId = 1;
        var state = new CdvUnderlyingState("NIFTY");
        state.EnsureTracked(securityId, strike: 100, isCall: true);

        state.ApplyTick(Tick(securityId, 100, 1000, T0), currentSpot: 0);
        state.ApplyTick(Tick(securityId, 105, 1300, T0.AddMinutes(1)), currentSpot: 0);
        state.ApplyTick(Tick(securityId, 102, 1800, T0.AddMinutes(2)), currentSpot: 0);
        state.ApplyTick(Tick(securityId, 102, 2000, T0.AddMinutes(3)), currentSpot: 0);

        var obv = state.GetObvSeries(isCall: true);

        Assert.Equal(4, obv.Count);
        Assert.Equal(0m, obv[0].Obv);
        Assert.Equal(300m, obv[1].Obv);
        Assert.Equal(-200m, obv[2].Obv);
        Assert.Equal(-200m, obv[3].Obv);
    }
}

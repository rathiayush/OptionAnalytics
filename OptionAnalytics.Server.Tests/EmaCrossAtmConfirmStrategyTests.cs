using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers EmaCrossAtmConfirmStrategy: CrossTimes (the one piece of logic this strategy adds
/// beyond what EmaCrossAtmFlowStrategy already has - a direction-parameterized cross-time finder,
/// needed because this strategy checks for a DOWN cross on the opposite leg, not just an up cross),
/// plus full end-to-end Simulate/EntrySignals coverage using a directly-constructed
/// BacktestStrategyContext - unlike EmaCrossAtmFlowStrategy, this strategy only ever reads SpotBars
/// and GetOptionBars(strike, isCall), both of which a test can supply directly, so its own
/// spot+ATM-confirmation gating is fully testable without a live CDV/Dhan harness.</summary>
public sealed class EmaCrossAtmConfirmStrategyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero); // 09:15 IST

    private static Candle Bar(DateTimeOffset time, decimal close) => new(time, close, close, close, close);

    // ---- CrossTimes ------------------------------------------------------------------------------

    [Fact]
    public void CrossTimes_WantBullish_OnlyReturnsUpCrosses()
    {
        var bars = new List<Candle>();
        // Flat then rising sharply (fast crosses above slow - an up cross), then falling back
        // sharply (a down cross) - both should be detectable, filtered separately by direction.
        for (var i = 0; i < 5; i++) bars.Add(Bar(T0.AddMinutes(i), 100));
        for (var i = 5; i < 15; i++) bars.Add(Bar(T0.AddMinutes(i), 100 + (i - 4) * 10)); // sharp rise
        for (var i = 15; i < 25; i++) bars.Add(Bar(T0.AddMinutes(i), 200 - (i - 14) * 10)); // sharp fall

        var upTimes = EmaCrossAtmConfirmStrategy.CrossTimes(bars, fastPeriod: 2, slowPeriod: 5, wantBullish: true);
        var downTimes = EmaCrossAtmConfirmStrategy.CrossTimes(bars, fastPeriod: 2, slowPeriod: 5, wantBullish: false);

        Assert.NotEmpty(upTimes);
        Assert.NotEmpty(downTimes);
        // Every up-cross time must come before every down-cross time in this fixture (rise then fall).
        Assert.True(upTimes.Max() < downTimes.Min());
    }

    [Fact]
    public void CrossTimes_EmptyInput_ReturnsEmpty()
    {
        Assert.Empty(EmaCrossAtmConfirmStrategy.CrossTimes(Array.Empty<Candle>(), 2, 5, wantBullish: true));
    }

    [Fact]
    public void CrossTimes_IgnoresTheFirstBarOfEachDay()
    {
        var day1 = Enumerable.Range(0, 30).Select(i => Bar(T0.AddMinutes(i), 100 - i)).ToList();
        var day2Start = T0.AddDays(1);
        var day2 = Enumerable.Range(0, 30).Select(i => Bar(day2Start.AddMinutes(i), 500 + i)).ToList();

        var upTimes = EmaCrossAtmConfirmStrategy.CrossTimes(day1.Concat(day2).ToList(), 3, 8, wantBullish: true);

        Assert.DoesNotContain(day2Start, upTimes);
    }

    // ---- Full Simulate/EntrySignals, via a directly-constructed context ------------------------

    private static BacktestStrategyContext Context(
        IReadOnlyList<Candle> spotBars, Func<decimal, bool, IReadOnlyList<Candle>> getOptionBars) => new()
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
        GetOptionBars = getOptionBars,
        GetOptionBarsOneMinute = getOptionBars,
        AtmCeBars = Array.Empty<Candle>(),
        AtmPeBars = Array.Empty<Candle>(),
        AtmCeVolumeBars = Array.Empty<CandleWithVolume>(),
        AtmPeVolumeBars = Array.Empty<CandleWithVolume>(),
        AtmStrike = null,
    };

    // A spot series clearly rising for its second half (fast crosses above slow partway through) -
    // ATM stays at 24000 throughout (close never moves 25+ points from it) so every candidate
    // crossover confirms against the SAME strike, keeping the option-side fixtures simple.
    private static List<Candle> RisingSpot()
    {
        var bars = new List<Candle>();
        for (var i = 0; i < 10; i++) bars.Add(Bar(T0.AddMinutes(i), 24000 - i)); // flat-ish, drifting down slightly
        for (var i = 10; i < 30; i++) bars.Add(Bar(T0.AddMinutes(i), 23990 + (i - 9) * 2)); // clear rise
        return bars;
    }

    private static Dictionary<string, decimal> Parameters(bool requireOppositeLeg) => new()
    {
        ["side"] = OptionTradeSimulator.SideBuy,
        ["otmSteps"] = 0,
        ["slPoints"] = 0,
        ["tpPoints"] = 0,
        ["fastEmaPeriod"] = 2,
        ["slowEmaPeriod"] = 5,
        ["atmConfirmWithinBars"] = 5,
        ["requireOppositeLegConfirm"] = requireOppositeLeg ? 1 : 0,
        ["direction"] = 0,
    };

    [Fact]
    public void BothLegsAgree_ProducesABullishEntry()
    {
        var spot = RisingSpot();
        // CE/PE share spot's own "flat, then turn at bar 10" TIMING (not just eventually crossing
        // somewhere in the series) - otherwise their own crosses land nowhere near spot's, outside
        // atmConfirmWithinBars regardless of direction. CE rises the same shape as spot from the
        // same turn (its own up cross lands close to spot's); PE falls from that same turn (its own
        // down cross, same timing) - both confirmations available for the ATM strike (24000) spot
        // settles at.
        var ceBars = spot.Select((b, i) => Bar(b.Time, i < 10 ? 100m : 100 + (i - 9) * 2)).ToList();
        var peBars = spot.Select((b, i) => Bar(b.Time, i < 10 ? 200m : 200 - (i - 9) * 2)).ToList();

        IReadOnlyList<Candle> GetOptionBars(decimal strike, bool isCall) => isCall ? ceBars : peBars;

        var context = Context(spot, GetOptionBars);
        var trades = new EmaCrossAtmConfirmStrategy().Simulate(context, Parameters(requireOppositeLeg: true));

        Assert.NotEmpty(trades);
        Assert.All(trades, t => Assert.Equal("Bullish", t.Direction));
    }

    [Fact]
    public void SameLegNeverCrosses_NoEntryEvenWithOppositeLegConfirmed()
    {
        var spot = RisingSpot();
        // CE stays FLAT (never crosses) - PE falls as before. Same-leg confirmation must fail even
        // though the opposite leg alone would have agreed.
        var flatCe = spot.Select(b => Bar(b.Time, 100)).ToList();
        var peBars = spot.Select((b, i) => Bar(b.Time, 200 - i * 2)).ToList();

        IReadOnlyList<Candle> GetOptionBars(decimal strike, bool isCall) => isCall ? flatCe : peBars;

        var context = Context(spot, GetOptionBars);
        var trades = new EmaCrossAtmConfirmStrategy().Simulate(context, Parameters(requireOppositeLeg: true));

        Assert.Empty(trades);
    }

    [Fact]
    public void OppositeLegDoesNotConfirm_RejectedWhenRequired_ButEntersWhenNotRequired()
    {
        var spot = RisingSpot();
        var ceBars = spot.Select((b, i) => Bar(b.Time, i < 10 ? 100m : 100 + (i - 9) * 2)).ToList();
        // PE also RISES from the same turn (does not cross down) - the opposite leg fails to confirm.
        var risingPe = spot.Select((b, i) => Bar(b.Time, i < 10 ? 100m : 100 + (i - 9) * 2)).ToList();

        IReadOnlyList<Candle> GetOptionBars(decimal strike, bool isCall) => isCall ? ceBars : risingPe;

        var strictContext = Context(spot, GetOptionBars);
        var strictTrades = new EmaCrossAtmConfirmStrategy().Simulate(strictContext, Parameters(requireOppositeLeg: true));
        Assert.Empty(strictTrades);

        var looseContext = Context(spot, GetOptionBars);
        var looseTrades = new EmaCrossAtmConfirmStrategy().Simulate(looseContext, Parameters(requireOppositeLeg: false));
        Assert.NotEmpty(looseTrades);
    }

    [Fact]
    public void NoOptionDataAtAll_NoEntry()
    {
        var spot = RisingSpot();
        IReadOnlyList<Candle> GetOptionBars(decimal strike, bool isCall) => Array.Empty<Candle>();

        var context = Context(spot, GetOptionBars);
        var trades = new EmaCrossAtmConfirmStrategy().Simulate(context, Parameters(requireOppositeLeg: true));

        Assert.Empty(trades);
    }

    [Fact]
    public void EntrySignals_ReportsRejectedReasonsToo()
    {
        var spot = RisingSpot();
        IReadOnlyList<Candle> GetOptionBars(decimal strike, bool isCall) => Array.Empty<Candle>();

        var context = Context(spot, GetOptionBars);
        var signals = new EmaCrossAtmConfirmStrategy().EntrySignals(context, Parameters(requireOppositeLeg: true));

        Assert.NotEmpty(signals);
        Assert.All(signals, s => Assert.Equal("Rejected", s.Kind));
        Assert.Contains(signals, s => s.Summary.Contains("made no", StringComparison.OrdinalIgnoreCase));
    }
}

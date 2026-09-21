using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers OptionTradeSimulator.Run's slPercentOfPremium/tpPercentOfPremium extension -
/// additive and OFF by default, added for a "stop/target = % of the premium actually collected"
/// risk model. Confirms it computes each trade's stop/target from THAT
/// trade's own entry price rather than a shared flat point value, and that leaving it at 0 (every
/// other strategy's own case) reproduces the pre-existing plain slPoints/tpPoints behavior exactly.</summary>
public sealed class OptionTradeSimulatorPercentOfPremiumTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 5, 3, 45, 0, TimeSpan.Zero);

    private static List<Candle> Flat(int bars, decimal price) =>
        Enumerable.Range(0, bars).Select(i => new Candle(T0.AddMinutes(i), price, price, price, price)).ToList();

    private static List<CandleWithVolume> Volume(IReadOnlyList<Candle> bars) =>
        bars.Select(b => new CandleWithVolume(b.Time, b.Open, b.High, b.Low, b.Close, 1000)).ToList();

    private static BacktestStrategyContext Context(IReadOnlyList<Candle> optionBars, IReadOnlyList<Candle> spotBars) => new()
    {
        Underlying = "NIFTY", TimeframeMinutes = 1, Step = 50,
        SpotBars = spotBars, SpotBarsOneMinute = spotBars, SpotVolumeBarsOneMinute = Volume(spotBars),
        ConfluenceSignalsAscending = Array.Empty<BacktestSignal>(), AllSignals = Array.Empty<BacktestSignal>(),
        ObvCeSeries = Array.Empty<ObvPoint>(), ObvPeSeries = Array.Empty<ObvPoint>(),
        CdvCeSeries = Array.Empty<ObvPoint>(), CdvPeSeries = Array.Empty<ObvPoint>(),
        GetOptionBars = (_, _) => optionBars, GetOptionBarsOneMinute = (_, _) => optionBars,
        AtmCeBars = Array.Empty<Candle>(), AtmPeBars = Array.Empty<Candle>(),
        AtmCeVolumeBars = Array.Empty<CandleWithVolume>(), AtmPeVolumeBars = Array.Empty<CandleWithVolume>(),
        AtmStrike = null,
        CeOiIvBand = Array.Empty<OiIvPoint>(),
        PeOiIvBand = Array.Empty<OiIvPoint>(),
    };

    [Fact]
    public void SlPercentOfPremium_ComputesStopFromThisTradesOwnEntryPrice_NotAFlatPointValue()
    {
        // Entry premium 100 (a Sell), stop = 20% of 100 = 20 points above entry -> stop price 120.
        var optionBars = Flat(10, 100m);
        optionBars[3] = new Candle(optionBars[3].Time, 100m, 121m, 100m, 100m); // bar after entry touches 121 - past the 120 stop
        var spotBars = Flat(10, 20000m);
        var parameters = new Dictionary<string, decimal> { ["side"] = OptionTradeSimulator.SideSell, ["otmSteps"] = 0, ["slPercentOfPremium"] = 20m };

        var trades = OptionTradeSimulator.Run(Context(optionBars, spotBars), new[] { (T0.AddMinutes(2), "Bullish") }, parameters);

        var trade = Assert.Single(trades);
        Assert.Equal("StopLoss", trade.ExitReason);
        Assert.Equal(120m, trade.ExitPrice);
    }

    [Fact]
    public void TpPercentOfPremium_ComputesTargetFromThisTradesOwnEntryPrice()
    {
        // Entry premium 200 (a Sell), target = 25% of 200 = 50 points below entry -> target price 150.
        var optionBars = Flat(10, 200m);
        optionBars[3] = new Candle(optionBars[3].Time, 200m, 200m, 149m, 200m); // bar after entry dips to 149 - past the 150 target
        var spotBars = Flat(10, 20000m);
        var parameters = new Dictionary<string, decimal> { ["side"] = OptionTradeSimulator.SideSell, ["otmSteps"] = 0, ["tpPercentOfPremium"] = 25m };

        var trades = OptionTradeSimulator.Run(Context(optionBars, spotBars), new[] { (T0.AddMinutes(2), "Bullish") }, parameters);

        var trade = Assert.Single(trades);
        Assert.Equal("TakeProfit", trade.ExitReason);
        Assert.Equal(150m, trade.ExitPrice);
    }

    [Fact]
    public void PercentOfPremium_OffByDefault_LeavesPlainSlPointsTpPointsBehaviourUnchanged()
    {
        var optionBars = Flat(10, 100m);
        optionBars[3] = new Candle(optionBars[3].Time, 100m, 111m, 100m, 100m); // touches 111 - past a flat 10-point stop, well short of any %-based one
        var spotBars = Flat(10, 20000m);
        var parameters = new Dictionary<string, decimal> { ["side"] = OptionTradeSimulator.SideSell, ["otmSteps"] = 0, ["slPoints"] = 10m };

        var trades = OptionTradeSimulator.Run(Context(optionBars, spotBars), new[] { (T0.AddMinutes(2), "Bullish") }, parameters);

        var trade = Assert.Single(trades);
        Assert.Equal("StopLoss", trade.ExitReason);
        Assert.Equal(110m, trade.ExitPrice);
    }
}

using System.Text;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>LiveTradingService's real-money pricing: a BUY prices off the live ASK and a SELL off the
/// BID (never the last trade), the LIMIT sits `slippage` beyond it, and target/stop-loss are measured
/// from it - plus the guards that keep an order Dhan would reject (or that has no quote) from going out.</summary>
public sealed class LiveTradingPricingTests
{
    [Fact]
    public void BuyPricesOffTheAskWithSlippageAbove()
    {
        var (prices, error) = LiveTradingService.PriceOrder(isSell: false, bestBid: 100.10m, bestAsk: 100.40m,
            slippage: 1m, stopLossPoints: 20m, targetPoints: 40m, tickSize: 0.05m);

        Assert.Null(error);
        Assert.Equal(100.40m, prices!.Reference);
        Assert.Equal(101.40m, prices.Limit);
        Assert.Equal(140.40m, prices.Target);
        Assert.Equal(80.40m, prices.StopLoss);
    }

    [Fact]
    public void SellPricesOffTheBidWithSlippageBelowAndMirroredLegs()
    {
        var (prices, error) = LiveTradingService.PriceOrder(isSell: true, bestBid: 100.10m, bestAsk: 100.40m,
            slippage: 1m, stopLossPoints: 20m, targetPoints: 40m, tickSize: 0.05m);

        Assert.Null(error);
        Assert.Equal(100.10m, prices!.Reference);
        Assert.Equal(99.10m, prices.Limit);
        Assert.Equal(60.10m, prices.Target);
        Assert.Equal(120.10m, prices.StopLoss);
    }

    [Fact]
    public void PricesSnapToTheTickSize()
    {
        var (prices, _) = LiveTradingService.PriceOrder(false, 0, 100.42m, 0.51m, 10m, 20m, 0.05m);
        Assert.Equal(100.95m, prices!.Limit);
        Assert.Equal(120.40m, prices.Target);
        Assert.Equal(90.40m, prices.StopLoss);
    }

    [Theory]
    [InlineData(false, 100, 0, "no live ask")]   // buying needs an ask
    [InlineData(true, 0, 100, "no live bid")]    // selling needs a bid
    public void NoQuoteOnTheTradedSideRefuses(bool isSell, double bid, double ask, string reason)
    {
        var (prices, error) = LiveTradingService.PriceOrder(isSell, (decimal)bid, (decimal)ask, 1m, 20m, 40m, 0.05m);
        Assert.Null(prices);
        Assert.Contains(reason, error);
    }

    [Fact]
    public void BothLegsAreRequired()
    {
        Assert.Null(LiveTradingService.PriceOrder(false, 99, 100, 1, 0, 40, 0.05m).Prices);
        Assert.Null(LiveTradingService.PriceOrder(false, 99, 100, 1, 20, 0, 0.05m).Prices);
    }

    [Fact]
    public void TargetInsideTheSlippageIsRefused()
    {
        var (prices, error) = LiveTradingService.PriceOrder(false, 99, 100, slippage: 5, stopLossPoints: 20, targetPoints: 5, tickSize: 0.05m);
        Assert.Null(prices);
        Assert.Contains("target", error);
    }

    [Fact]
    public void AStopLossBelowZeroIsRefused()
    {
        var (prices, error) = LiveTradingService.PriceOrder(false, 9, 10, slippage: 1, stopLossPoints: 15, targetPoints: 20, tickSize: 0.05m);
        Assert.Null(prices);
        Assert.Contains("zero", error);
    }

    private static DhanPosition Position(int netQty, decimal buyAvg = 0, decimal sellAvg = 0) =>
        new("1", "NIFTY-OCT2026-22600-CE", "NSE_FNO", "INTRADAY", netQty > 0 ? "LONG" : netQty < 0 ? "SHORT" : "CLOSED", netQty)
        { BuyAvg = buyAvg, SellAvg = sellAvg };

    [Fact]
    public void LongPnlIsLtpMinusBuyAverage() =>
        Assert.Equal(750m, LiveTradingService.UnrealizedPnl(Position(75, buyAvg: 100), 110));

    [Fact]
    public void ShortPnlIsSellAverageMinusLtp() =>
        Assert.Equal(-750m, LiveTradingService.UnrealizedPnl(Position(-75, sellAvg: 100), 110));

    [Fact]
    public void ClosedPositionHasNoOpenPnlAndUnknownLtpIsUnknown()
    {
        Assert.Equal(0m, LiveTradingService.UnrealizedPnl(Position(0), 110));
        Assert.Null(LiveTradingService.UnrealizedPnl(Position(75, buyAvg: 100), null));
    }

    [Theory]
    [InlineData("{\"Type\":\"order_alert\",\"Data\":{\"orderNo\":\"1\"}}", true)]
    [InlineData("{\"Type\":\"ORDER_ALERT\"}", true)]
    [InlineData("{\"Type\":\"heartbeat\"}", false)]
    [InlineData("not json", false)]
    [InlineData("[1,2]", false)]
    public void OrderAlertDetection(string json, bool expected) =>
        Assert.Equal(expected, DhanOrderUpdateFeed.IsOrderAlert(Encoding.UTF8.GetBytes(json)));
}

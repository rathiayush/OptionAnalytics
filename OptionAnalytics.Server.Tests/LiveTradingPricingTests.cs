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

    [Fact]
    public void OrderAlert_IsParsedIntoTheRestBooksSpelling()
    {
        // Shape from https://dhanhq.co/docs/v2/order-update/ - numbers sometimes arrive as strings.
        const string json = """
            {"Type":"order_alert","Data":{"Exchange":"NSE","Segment":"D","SecurityId":"40944","OrderNo":"112409","Product":"I",
             "TxnType":"S","OrderType":"SL","Quantity":195,"TradedQty":"65","RemainingQuantity":130,"Price":78,"TriggerPrice":80,
             "TradedPrice":79.5,"AvgTradedPrice":79.5,"Status":"Pending","CorrelationId":"OIRP-T15000-101500-1","Remarks":"Super Order",
             "LegNo":2,"DisplayName":"NIFTY 26000 CALL","ReasonDescription":"CONFIRMED"}}
            """;
        var u = DhanOrderUpdateFeed.Parse(Encoding.UTF8.GetBytes(json))!;
        Assert.Equal(("112409", "40944", "NSE_FNO", "INTRADAY", "SELL", "STOP_LOSS"), (u.OrderNo, u.SecurityId, u.ExchangeSegment, u.ProductType, u.TransactionType, u.OrderType));
        Assert.Equal((195, 65, 130, 79.5m, 80m), (u.Quantity, u.TradedQty, u.RemainingQuantity, u.AvgTradedPrice, u.TriggerPrice));
        Assert.Equal(("PART_TRADED", 2, true), (u.Status, u.LegNo, u.IsSuperOrder));
        Assert.Null(DhanOrderUpdateFeed.Parse(Encoding.UTF8.GetBytes("{\"Type\":\"order_alert\"}")));
        Assert.Equal("BSE_FNO", DhanOrderUpdateFeed.SegmentName("BSE", "D"));
    }

    [Theory]
    [InlineData(150, 0, 150)]     // nothing working - close it all
    [InlineData(-150, 0, 150)]    // a short closes by buying the same size
    [InlineData(150, 75, 75)]     // a working exit covers half - send only the rest
    [InlineData(150, 150, 0)]     // already fully covered (double click / Exit all after Close) - send nothing
    [InlineData(150, 300, 0)]     // never negative
    public void ExitNeverOverClosesAPositionAlreadyBeingExited(int netQty, long working, int expected) =>
        Assert.Equal(expected, LiveTradingService.ExitQuantity(netQty, working));

    [Fact]
    public void AChasedEntry_GoesToTheLatestPricePlusSlippage_ItsLegsMovedAlong_OnlyWhenTheMarketLeftIt()
    {
        // A SELL at 99 (bid 100 - 1), target 60, SL 120: the bid falls to 95 in a sudden fall - to 94, legs -5.
        var (next, why) = LiveTradingService.RepriceEntry(true, 95m, 95.5m, 99m, 60m, 120m, firstLimit: 99m, slippage: 1m, maxChase: 20m, tick: 0.05m);
        Assert.Equal(("re-priced", 94m, 55m, 115m), (why, next!.Limit, next.Target!.Value, next.StopLoss!.Value));
        // Still at the market (the bid at or above its limit): it fills there - nothing moved.
        Assert.Null(LiveTradingService.RepriceEntry(true, 99.5m, 100m, 99m, 60m, 120m, 99m, 1m, 20m, 0.05m).Next);
        // Ran past its SL distance from the first price, or no live price: not chased.
        Assert.StartsWith("the option ran", LiveTradingService.RepriceEntry(true, 70m, 70.5m, 99m, 60m, 120m, 99m, 1m, 20m, 0.05m).Why);
        Assert.Null(LiveTradingService.RepriceEntry(true, 0m, 0m, 99m, 60m, 120m, 99m, 1m, 20m, 0.05m).Next);
        // To the tick, and a leg never at or below zero.
        Assert.Equal(94.35m, LiveTradingService.RepriceEntry(true, 95.37m, 95.5m, 99m, 60m, 120m, 99m, 1m, 20m, 0.05m).Next!.Limit);
        Assert.Null(LiveTradingService.RepriceEntry(true, 95m, 95.5m, 99m, 4m, 120m, 99m, 1m, 20m, 0.05m).Next);
    }

    [Fact]
    public void AnExitsSlippage_WidensEachTry_UpToSixTimes()
    {
        Assert.Equal(new[] { 2m, 3m, 4m, 5m, 6m, 6m, 6m }, Enumerable.Range(1, 7).Select(a => LiveTradingService.ExitSlippage(1m, a)));
    }
}

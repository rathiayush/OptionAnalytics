using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// The trade notifications (LiveTradingService.TradeEventOf): what an order update from Dhan's
/// order-update socket means for an order this app placed - and the guard that keeps a Close from
/// sizing its exit off a REST position that has not caught up with a leg fill (SaferNetQty).
/// </summary>
public sealed class LiveTradeEventTests
{
    private static DhanOrderUpdate Update(string status, int legNo, int traded = 75, int quantity = 75, decimal avg = 120.5m,
        bool isSuper = true, string? tag = null, string transaction = "BUY", string? reason = null) =>
        new("ORD1", "40944", "NSE_FNO", "INTRADAY", transaction, "LIMIT", quantity, traded, quantity - traded, 120m, 0m, avg, avg,
            status, tag, legNo, isSuper, "NIFTY 25000 CE", reason);

    [Theory]
    [InlineData(1, "entry", "Entry filled")]
    [InlineData(2, "stopLoss", "Stop-loss hit")]
    [InlineData(3, "target", "Target hit")]
    public void SuperOrderLegFilling_IsReportedAsWhatItMeans(int leg, string kind, string title)
    {
        var e = LiveTradingService.TradeEventOf(Update("TRADED", leg), "OIR-20261005101500-1", "NIFTY 25000 CE", null);

        Assert.NotNull(e);
        Assert.Equal(kind, e!.Kind);
        Assert.Equal(title, e.Title);
        Assert.Contains("x75", e.Text);
        Assert.Contains("120.5", e.Text);
        Assert.Equal($"ORD1-{leg}-T", e.Id);
    }

    [Fact]
    public void AnExitOrderFilling_IsAnExit_AndAPartFillIsSaidOnceAsPartly()
    {
        var full = LiveTradingService.TradeEventOf(Update("TRADED", 0, isSuper: false, transaction: "SELL"), "OIRX-20261005-1", "NIFTY 25000 CE", null);
        var part = LiveTradingService.TradeEventOf(Update("PART_TRADED", 0, traded: 25, isSuper: false, transaction: "SELL"), "OIRX-20261005-1", "NIFTY 25000 CE", null);

        Assert.Equal("exit", full!.Kind);
        Assert.Equal("Exit filled (partly)", part!.Title);
        Assert.Contains("x25 of 75", part.Text);
        Assert.NotEqual(full.Id, part.Id); // the full fill is reported after a part fill
    }

    [Fact]
    public void ARejection_CarriesDhansReason()
    {
        var e = LiveTradingService.TradeEventOf(Update("REJECTED", 1, traded: 0, reason: "insufficient margin"), "OIR-x-1", "NIFTY 25000 CE", null);

        Assert.Equal("rejected", e!.Kind);
        Assert.Contains("insufficient margin", e.Text);
    }

    [Theory]
    [InlineData(null)]              // placed from the Dhan app - not ours
    [InlineData("trig-abc-1")]      // a strategy trigger's order - it reports its own
    public void OrdersThisAppDidNotPlace_AreNotReported(string? tag)
    {
        Assert.Null(LiveTradingService.TradeEventOf(Update("TRADED", 2), tag, "NIFTY 25000 CE", null));
    }

    [Theory]
    [InlineData("PENDING")]
    [InlineData("CANCELLED")]
    [InlineData("TRANSIT")]
    public void StatusesWithNoFill_AreNotReported(string status)
    {
        Assert.Null(LiveTradingService.TradeEventOf(Update(status, 1, traded: 0), "OIR-x-1", "NIFTY 25000 CE", null));
    }

    [Theory]
    // REST still shows the long, the socket already saw its stop-loss sell it: nothing to close.
    [InlineData(75, 0, 0)]
    // A part of it closed by a leg the REST read has not caught up with: close only what is left.
    [InlineData(150, 75, 75)]
    [InlineData(-150, -75, -75)]
    // Memory on the other side (a reversal REST has not seen): never close into it.
    [InlineData(75, -75, 0)]
    // Memory has not seen the position at all: REST is all there is.
    [InlineData(75, null, 75)]
    // Memory ahead with a NEW fill: the REST (smaller) quantity is closed - never more than both agree on.
    [InlineData(75, 150, 75)]
    public void AnExitIsSizedFromTheSmallerOfRestAndTheSocketsPosition(int rest, int? memory, int expected)
    {
        Assert.Equal(expected, LiveTradingService.SaferNetQty(rest, memory));
    }
}

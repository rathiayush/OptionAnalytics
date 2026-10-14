using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Where a live super order stands (LiveTradingService.StateOf) - what the server's own check
/// (ServerLiveService.ReconcileAsync) closes a trade on: never closed on a guess.</summary>
public sealed class LiveOrderStateTests
{
    private static readonly Dictionary<(string OrderId, int Leg), (int Qty, decimal? Avg)> NoFills = new();

    private static SuperOrderSummary Order(string status, string side = "BUY", int? filled = null, string? error = null, params SuperOrderLeg[] legs) =>
        new("o1", status, side, "NSE_FNO", "123", 75, 101, 131, 81, error, legs) { FilledQty = filled };

    private static SuperOrderLeg Leg(string name, string status, decimal price, int? triggered = null) => new(name, status, "SELL", price, null, triggered);

    [Fact]
    public void AnEntryStillWorking_IsOpen_WithNothingTraded()
    {
        var s = LiveTradingService.StateOf(Order("PENDING", legs: new[] { Leg("STOP_LOSS_LEG", "PENDING", 81), Leg("TARGET_LEG", "PENDING", 131) }), NoFills);
        Assert.Equal((true, 0, (string?)null), (s.Open, s.Filled, s.EndedBy));
        // Part traded, the quantity not known yet: traded all the same.
        Assert.Equal(1, LiveTradingService.StateOf(Order("PART_TRADED"), NoFills).Filled);
    }

    [Theory]
    [InlineData("REJECTED", "rejected", "insufficient margin")]
    [InlineData("CANCELLED", "cancelled", null)]
    [InlineData("EXPIRED", "cancelled", null)]
    public void AnEntryThatEndedBeforeAnythingTraded_IsNoTrade(string status, string endedBy, string? error)
    {
        var s = LiveTradingService.StateOf(Order(status, error: error), NoFills);
        Assert.Equal((false, 0, endedBy, error), (s.Open, s.Filled, s.EndedBy, s.Reason));
        Assert.Null(s.Pnl);
    }

    [Fact]
    public void AFilledEntry_IsOpen_WhileALegWorks_OrItsLegsAreNotListed_NeverGuessedClosed()
    {
        var withLegs = LiveTradingService.StateOf(Order("TRADED", legs: new[] { Leg("STOP_LOSS_LEG", "PENDING", 81), Leg("TARGET_LEG", "CANCELLED", 131) }), NoFills);
        Assert.Equal((true, 75, 101m), (withLegs.Open, withLegs.Filled, withLegs.EntryPrice!.Value));
        Assert.True(LiveTradingService.StateOf(Order("TRADED"), NoFills).Open);
        // Both legs gone without filling: closed by another order - P&L not known here.
        var gone = LiveTradingService.StateOf(Order("TRADED", legs: new[] { Leg("STOP_LOSS_LEG", "CANCELLED", 81), Leg("TARGET_LEG", "CANCELLED", 131) }), NoFills);
        Assert.Equal((false, "closed"), (gone.Open, gone.EndedBy));
        Assert.Null(gone.Pnl);
    }

    [Fact]
    public void ALegThatFilled_ClosesIt_AtTheFillsOwnPrices()
    {
        // Bought at 100.4 (the socket's average, not the 101 limit); the stop-loss leg filled at 80.6.
        var fills = new Dictionary<(string OrderId, int Leg), (int Qty, decimal? Avg)> { [("o1", 1)] = (75, 100.4m), [("o1", 2)] = (75, 80.6m) };
        var legs = new[] { Leg("STOP_LOSS_LEG", "TRADED", 81, 75), Leg("TARGET_LEG", "CANCELLED", 131) };
        var s = LiveTradingService.StateOf(Order("TRADED", legs: legs), fills);
        Assert.Equal((false, "stop-loss", 100.4m, 80.6m, 75), (s.Open, s.EndedBy, s.EntryPrice!.Value, s.ExitPrice!.Value, s.ExitQty));
        Assert.Equal(-1485m, s.Pnl); // (80.6 - 100.4) x 75
        // No fill prices from the socket (read from Dhan's book): the entry's limit and the leg's own price.
        var sold = LiveTradingService.StateOf(Order("TRADED", "SELL", legs: new[] { Leg("STOP_LOSS_LEG", "CANCELLED", 121), Leg("TARGET_LEG", "TRADED", 71) }), NoFills);
        Assert.Equal(("target", 101m, 71m), (sold.EndedBy, sold.EntryPrice!.Value, sold.ExitPrice!.Value));
        Assert.Equal(2250m, sold.Pnl); // a sell: (101 - 71) x 75
    }
}

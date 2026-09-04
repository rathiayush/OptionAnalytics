using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers SuperOrderSummary.IsStillOpen - the live "does this trigger already have a
/// position at Dhan" check StrategyTriggerHostedService.BuildOrderPlanAsync uses to refuse a
/// second order for the same trigger while an earlier one hasn't exited. Every case here mirrors
/// a real leg-status combination GET /super/orders can return.</summary>
public sealed class SuperOrderSummaryTests
{
    private static SuperOrderLeg Leg(string name, string status) => new(name, status, "BUY", null, null, null);

    private static SuperOrderSummary Order(string orderStatus, params SuperOrderLeg[] legs) =>
        new("order-1", orderStatus, "BUY", "NSE_FNO", "12345", 75, 100, 120, 90, null, legs, "trig-1-202609041042");

    [Fact]
    public void IsStillOpen_EntryPendingUnfilled_IsOpen()
    {
        var order = Order("PENDING", Leg("ENTRY_LEG", "PENDING"));

        Assert.True(order.IsStillOpen());
    }

    [Fact]
    public void IsStillOpen_EntryFilledNeitherExitLegTraded_IsOpen()
    {
        var order = Order("TRADED",
            Leg("ENTRY_LEG", "TRADED"),
            Leg("TARGET_LEG", "PENDING"),
            Leg("STOP_LOSS_LEG", "PENDING"));

        Assert.True(order.IsStillOpen());
    }

    [Fact]
    public void IsStillOpen_PartTraded_IsOpen()
    {
        var order = Order("PART_TRADED", Leg("ENTRY_LEG", "PART_TRADED"));

        Assert.True(order.IsStillOpen());
    }

    [Fact]
    public void IsStillOpen_EntryRejected_IsNotOpen()
    {
        var order = Order("REJECTED", Leg("ENTRY_LEG", "REJECTED"));

        Assert.False(order.IsStillOpen());
    }

    [Fact]
    public void IsStillOpen_EntryCancelled_IsNotOpen()
    {
        var order = Order("CANCELLED", Leg("ENTRY_LEG", "CANCELLED"));

        Assert.False(order.IsStillOpen());
    }

    [Fact]
    public void IsStillOpen_TargetLegTraded_IsNotOpen()
    {
        // The position exited via target - the exact case that must clear the gate for a fresh signal.
        var order = Order("TRADED",
            Leg("ENTRY_LEG", "TRADED"),
            Leg("TARGET_LEG", "TRADED"),
            Leg("STOP_LOSS_LEG", "CANCELLED"));

        Assert.False(order.IsStillOpen());
    }

    [Fact]
    public void IsStillOpen_StopLossLegTraded_IsNotOpen()
    {
        var order = Order("TRADED",
            Leg("ENTRY_LEG", "TRADED"),
            Leg("TARGET_LEG", "CANCELLED"),
            Leg("STOP_LOSS_LEG", "TRADED"));

        Assert.False(order.IsStillOpen());
    }
}

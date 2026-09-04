using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers DhanPosition.IsOpen - the ground-truth "has this position actually been
/// closed out at Dhan yet" check StrategyTriggerHostedService.BuildOrderPlanAsync uses before
/// placing a live order, instead of inferring it from a Super Order's own target/stop-loss leg
/// status.</summary>
public sealed class DhanPositionTests
{
    private static DhanPosition Position(string positionType, int netQty) =>
        new("12345", "BANKNIFTY-Sep2026-57400-PE", "NSE_FNO", "INTRADAY", positionType, netQty);

    [Fact]
    public void IsOpen_LongWithNonZeroNetQty_IsOpen()
    {
        Assert.True(Position("LONG", 90).IsOpen);
    }

    [Fact]
    public void IsOpen_ShortWithNonZeroNetQty_IsOpen()
    {
        Assert.True(Position("SHORT", -90).IsOpen);
    }

    [Fact]
    public void IsOpen_Closed_IsNotOpen()
    {
        // The stop-loss (or target) leg firing at Dhan is exactly what flips this - regardless of
        // what a Super Order's own TARGET_LEG/STOP_LOSS_LEG status happens to say.
        Assert.False(Position("CLOSED", 0).IsOpen);
    }

    [Fact]
    public void IsOpen_ClosedButNetQtyNotYetZeroed_IsNotOpen()
    {
        // Belt and braces: PositionType is Dhan's own authoritative call, even if NetQty lags it.
        Assert.False(Position("CLOSED", 90).IsOpen);
    }
}

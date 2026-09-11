using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers StrategyTriggerHostedService.HedgeStrike - the distance rule for
/// StrategyTrigger.HedgeOtmSteps' protective hedge leg: further OTM in the SAME direction the
/// sold leg already is, measured from the SOLD strike itself rather than from ATM again. Pure
/// arithmetic pulled out specifically because the rest of the live-order pipeline it feeds
/// (BuildOrderPlanAsync) depends on live Dhan/CDV state this project has no test harness for.</summary>
public sealed class StrategyTriggerHedgeStrikeTests
{
    [Fact]
    public void SoldCall_HedgeIsHigherStrike_CheaperFurtherOtm()
    {
        // Calls get cheaper as the strike rises, so the hedge for a sold CE sits ABOVE it.
        var hedgeStrike = StrategyTriggerHostedService.HedgeStrike(soldStrike: 24500, isCall: true, hedgeOtmSteps: 20, step: 50);

        Assert.Equal(25500, hedgeStrike); // 24500 + 20*50
    }

    [Fact]
    public void SoldPut_HedgeIsLowerStrike_CheaperFurtherOtm()
    {
        // Puts get cheaper as the strike falls, so the hedge for a sold PE sits BELOW it.
        var hedgeStrike = StrategyTriggerHostedService.HedgeStrike(soldStrike: 24500, isCall: false, hedgeOtmSteps: 20, step: 50);

        Assert.Equal(23500, hedgeStrike); // 24500 - 20*50
    }

    [Fact]
    public void ZeroHedgeSteps_HedgeStrikeEqualsTheSoldStrike()
    {
        // Not a real-world case (BuildOrderPlanAsync never calls this when HedgeOtmSteps == 0 -
        // that means no hedge at all) but the formula itself should degenerate sensibly rather
        // than do anything surprising at the boundary.
        Assert.Equal(24500, StrategyTriggerHostedService.HedgeStrike(24500, true, 0, 50));
        Assert.Equal(24500, StrategyTriggerHostedService.HedgeStrike(24500, false, 0, 50));
    }

    [Fact]
    public void BankNiftyStep_ScalesWithTheUnderlyingsOwnStrikeStep()
    {
        // BANKNIFTY's own strike step (100) rather than NIFTY's (50) - the formula must use
        // whatever step is passed in, not a hardcoded one.
        var hedgeStrike = StrategyTriggerHostedService.HedgeStrike(soldStrike: 51000, isCall: true, hedgeOtmSteps: 10, step: 100);

        Assert.Equal(52000, hedgeStrike); // 51000 + 10*100
    }
}

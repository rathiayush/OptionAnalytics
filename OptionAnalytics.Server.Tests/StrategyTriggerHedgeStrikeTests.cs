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

    // ---- HedgeStrikeWalkedInward: StrategyTrigger.HedgeMinOpenInterestPercent's liquidity walk ----

    /// <summary>A chain where the sold strike carries 1,000,000 of OI and each candidate hedge
    /// strike carries whatever <paramref name="hedgeOi"/> says, keyed by strike.</summary>
    private static Dictionary<decimal, long> Chain(decimal soldStrike, long soldOi, params (decimal Strike, long Oi)[] hedgeOi)
    {
        var chain = new Dictionary<decimal, long> { [soldStrike] = soldOi };
        foreach (var (strike, oi) in hedgeOi) chain[strike] = oi;
        return chain;
    }

    [Fact]
    public void RequestedStrikeIsLiquidEnough_TakesItUnchanged()
    {
        // 100,000 against a 1,000,000 sold strike is 10% - comfortably over the 5% asked for, so
        // there is nothing to walk and the configured distance stands exactly as set.
        var chain = Chain(24500, 1_000_000, (25500, 100_000));

        var strike = StrategyTriggerHostedService.HedgeStrikeWalkedInward(
            soldStrike: 24500, isCall: true, requestedSteps: 20, step: 50, chain, minOpenInterestPercent: 5);

        Assert.Equal(25500, strike);
    }

    [Fact]
    public void RequestedStrikeTooThin_WalksInwardToTheFirstLiquidOne()
    {
        // The 20-step strike is nearly dead (0.1%) and 19 is no better, but 18 clears 5% - so the
        // hedge lands there rather than on the strike the distance alone pointed at.
        var chain = Chain(24500, 1_000_000, (25500, 1_000), (25450, 2_000), (25400, 80_000));

        var strike = StrategyTriggerHostedService.HedgeStrikeWalkedInward(
            soldStrike: 24500, isCall: true, requestedSteps: 20, step: 50, chain, minOpenInterestPercent: 5);

        Assert.Equal(25400, strike); // 18 steps out, not the requested 20
    }

    [Fact]
    public void SoldPut_WalksInwardUpward_TowardTheSoldStrikeNotAwayFromIt()
    {
        // The mirror of the call case: a sold PE hedges BELOW itself, so "inward" means walking
        // back UP toward the sold strike. Getting this backwards would widen the spread instead of
        // tightening it - a worse hedge than the one asked for, silently.
        var chain = Chain(24500, 1_000_000, (23500, 1_000), (23550, 90_000));

        var strike = StrategyTriggerHostedService.HedgeStrikeWalkedInward(
            soldStrike: 24500, isCall: false, requestedSteps: 20, step: 50, chain, minOpenInterestPercent: 5);

        Assert.Equal(23550, strike); // 19 steps out and CLOSER to the sold strike, never further
    }

    [Fact]
    public void NothingLiquidWithinHalfTheDistance_ReturnsNullSoTheOrderIsAbandoned()
    {
        // Only a strike 4 steps out is liquid, which is inside the half-distance floor (10 steps of
        // the requested 20). Taking it would be a completely different spread from the configured
        // one, so the caller abandons the order instead of quietly re-pricing the trade.
        var chain = Chain(24500, 1_000_000, (24700, 500_000));

        var strike = StrategyTriggerHostedService.HedgeStrikeWalkedInward(
            soldStrike: 24500, isCall: true, requestedSteps: 20, step: 50, chain, minOpenInterestPercent: 5);

        Assert.Null(strike);
    }

    [Fact]
    public void WalkStopsExactlyAtHalfTheRequestedDistance()
    {
        // 10 steps out of a requested 20 is the floor itself - still allowed, where 9 would not be.
        var chain = Chain(24500, 1_000_000, (25000, 200_000));

        var strike = StrategyTriggerHostedService.HedgeStrikeWalkedInward(
            soldStrike: 24500, isCall: true, requestedSteps: 20, step: 50, chain, minOpenInterestPercent: 5);

        Assert.Equal(25000, strike);
    }

    [Fact]
    public void StrikeMissingFromTheChain_CountsAsFailingNotAsPassing()
    {
        // The requested strike isn't quoted at all. Absent from a chain that DID come back means
        // there is nothing to buy there - it must not be treated as "unknown, so fine".
        var chain = Chain(24500, 1_000_000, (25400, 80_000));

        var strike = StrategyTriggerHostedService.HedgeStrikeWalkedInward(
            soldStrike: 24500, isCall: true, requestedSteps: 20, step: 50, chain, minOpenInterestPercent: 5);

        Assert.Equal(25400, strike);
    }

    [Fact]
    public void EmptyChainSnapshot_LeavesTheRequestedStrikeAlone()
    {
        // No snapshot at all (rate limiter, no session, outside market hours) is "no opinion", not
        // "everything is illiquid" - refusing to trade on a missing decoration would take the
        // trigger offline every time Dhan's 3-second limiter said no.
        var strike = StrategyTriggerHostedService.HedgeStrikeWalkedInward(
            soldStrike: 24500, isCall: true, requestedSteps: 20, step: 50,
            new Dictionary<decimal, long>(), minOpenInterestPercent: 5);

        Assert.Equal(25500, strike);
    }

    [Fact]
    public void ZeroPercent_DisablesTheCheckEntirely()
    {
        // An explicit 0 opts out: take the configured distance whatever the book behind it looks
        // like, which is exactly how the hedge behaved before this check existed.
        var chain = Chain(24500, 1_000_000, (25500, 1));

        var strike = StrategyTriggerHostedService.HedgeStrikeWalkedInward(
            soldStrike: 24500, isCall: true, requestedSteps: 20, step: 50, chain, minOpenInterestPercent: 0);

        Assert.Equal(25500, strike);
    }

    [Fact]
    public void SoldStrikeHasNoOpenInterest_EverythingPassesRatherThanNothing()
    {
        // With no yardstick the threshold is 0, so the requested strike stands. Deliberate: a
        // missing sold-strike OI is a gap in the snapshot, and blocking every hedged trade on it
        // would be far worse than the thin hedge this check exists to avoid.
        var chain = new Dictionary<decimal, long> { [25500] = 1 };

        var strike = StrategyTriggerHostedService.HedgeStrikeWalkedInward(
            soldStrike: 24500, isCall: true, requestedSteps: 20, step: 50, chain, minOpenInterestPercent: 5);

        Assert.Equal(25500, strike);
    }

    [Fact]
    public void SingleStepHedge_HasNowhereToWalkAndIsAcceptedOrRejectedOutright()
    {
        // requestedSteps 1 floors to 1: the only candidate is the strike itself, so this is a
        // straight pass/fail with no walking. The floor must never reach the sold strike, which
        // would not be a hedge at all.
        var liquid = Chain(24500, 1_000_000, (24550, 200_000));
        Assert.Equal(24550, StrategyTriggerHostedService.HedgeStrikeWalkedInward(24500, true, 1, 50, liquid, 5));

        var thin = Chain(24500, 1_000_000, (24550, 10));
        Assert.Null(StrategyTriggerHostedService.HedgeStrikeWalkedInward(24500, true, 1, 50, thin, 5));
    }
}

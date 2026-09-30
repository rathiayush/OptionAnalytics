using System.Collections.Concurrent;
using OptionAnalytics.Server.Services;
using LegInfo = OptionAnalytics.Server.Services.OiReplayLiveFeedService.LegInfo;

namespace OptionAnalytics.Server.Tests;

/// <summary>OiReplayLiveFeedService.PruneLegs - what a server that stays up across expiries keeps
/// tracking. Without it every contract ever tracked stayed subscribed and re-sent to Dhan, and a
/// contract that moved from N2 to N1 kept broadcasting under N2 too.</summary>
public sealed class OiReplayLiveFeedPruneTests
{
    private static readonly DateOnly Today = new(2026, 9, 30);
    private static readonly DateOnly Yesterday = Today.AddDays(-1);
    private static readonly DateOnly NextWeek = Today.AddDays(7);
    private static readonly DateOnly TwoWeeks = Today.AddDays(14);

    private static ConcurrentDictionary<uint, ConcurrentDictionary<string, LegInfo>> Legs(params (uint Id, string Flag, DateOnly Expiry)[] legs)
    {
        var map = new ConcurrentDictionary<uint, ConcurrentDictionary<string, LegInfo>>();
        foreach (var (id, flag, expiry) in legs)
            map.GetOrAdd(id, _ => new ConcurrentDictionary<string, LegInfo>())[flag] = new LegInfo("NIFTY", flag, 25000, true, expiry);
        return map;
    }

    [Fact]
    public void ExpiredLegsAreDroppedAndReturnedForUnsubscribe()
    {
        var legs = Legs((1, "N1", Yesterday), (2, "N1", NextWeek));

        var expired = OiReplayLiveFeedService.PruneLegs(legs, new Dictionary<(string, string), DateOnly>(), Today);

        Assert.Equal(new uint[] { 1 }, expired);
        Assert.False(legs.ContainsKey(1));
        Assert.True(legs.ContainsKey(2));
    }

    [Fact]
    public void ALegExpiringTodayIsStillTracked()
    {
        var legs = Legs((1, "N1", Today));

        var expired = OiReplayLiveFeedService.PruneLegs(legs, new Dictionary<(string, string), DateOnly>(), Today);

        Assert.Empty(expired);
        Assert.True(legs.ContainsKey(1));
    }

    [Fact]
    public void AContractWhoseFlagMovedOnKeepsOnlyItsCurrentFlagAndStaysSubscribed()
    {
        // Contract 2 was N2 yesterday and is N1 today; N2 now resolves to the week after.
        var legs = Legs((2, "N2", NextWeek), (2, "N1", NextWeek), (3, "N2", TwoWeeks));
        var resolved = new Dictionary<(string, string), DateOnly> { [("NIFTY", "N1")] = NextWeek, [("NIFTY", "N2")] = TwoWeeks };

        var expired = OiReplayLiveFeedService.PruneLegs(legs, resolved, Today);

        Assert.Empty(expired);
        Assert.Equal(new[] { "N1" }, legs[2].Keys);
        Assert.Equal(new[] { "N2" }, legs[3].Keys);
    }

    [Fact]
    public void AStillTradingContractNoFlagTracksIsForgottenButNotUnsubscribed()
    {
        var legs = Legs((4, "N6", TwoWeeks));
        var resolved = new Dictionary<(string, string), DateOnly> { [("NIFTY", "N6")] = TwoWeeks.AddDays(7) };

        var expired = OiReplayLiveFeedService.PruneLegs(legs, resolved, Today);

        Assert.Empty(expired);
        Assert.False(legs.ContainsKey(4));
    }

    [Fact]
    public void ACurrentBandIsLeftUntouched()
    {
        var legs = Legs((5, "WEEK", NextWeek), (5, "N1", NextWeek), (6, "MONTH", TwoWeeks));
        var resolved = new Dictionary<(string, string), DateOnly>
        {
            [("NIFTY", "WEEK")] = NextWeek, [("NIFTY", "N1")] = NextWeek, [("NIFTY", "MONTH")] = TwoWeeks,
        };

        var expired = OiReplayLiveFeedService.PruneLegs(legs, resolved, Today);

        Assert.Empty(expired);
        Assert.Equal(2, legs[5].Count);
        Assert.Single(legs[6]);
    }
}

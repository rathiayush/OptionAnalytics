using OptionAnalytics.Server;
using OptionAnalytics.Server.Services;
using Xunit;

namespace OptionAnalytics.Server.Tests;

/// <summary>The live feed's newest reading per option leg (LiveOptionLegStore) - what GET live-legs serves.</summary>
public class LiveOptionLegStoreTests
{
    private static LiveOptionTick Tick(string u, string flag, decimal strike, string side, decimal price, DateTimeOffset at) =>
        new(u, flag, strike, side, price, price, price, price, 1000, at);

    [Fact]
    public void Keeps_the_newest_reading_per_leg_of_one_chain_and_day()
    {
        var store = new LiveOptionLegStore();
        var now = DateTimeOffset.UtcNow.ToOffset(IstClock.Offset);
        var today = DateOnly.FromDateTime(now.DateTime);
        store.Record(Tick("NIFTY", "N1", 23100, "CE", 57.55m, now.AddSeconds(-5)));
        store.Record(Tick("NIFTY", "N1", 23100, "CE", 61.2m, now));
        store.Record(Tick("NIFTY", "N1", 23100, "PE", 40m, now));
        store.Record(Tick("NIFTY", "N2", 23100, "CE", 99m, now));
        store.Record(Tick("SENSEX", "N1", 74500, "CE", 489.85m, now));
        store.Record(Tick("NIFTY", "N1", 23200, "CE", 30m, now.AddDays(-1)));

        var legs = store.Latest("nifty", "n1", today);
        Assert.Equal(2, legs.Count);
        Assert.Equal((23100m, "CE", 61.2m), (legs[0].Strike, legs[0].Side, legs[0].Price));
        Assert.Equal("PE", legs[1].Side);
        Assert.Single(store.Latest("NIFTY", "N2", today));
        Assert.Empty(store.Latest("BANKNIFTY", "N1", today));
    }
}

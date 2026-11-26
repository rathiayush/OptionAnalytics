using OptionAnalytics.Server.TrueData;
using Xunit;

namespace OptionAnalytics.Server.Tests;

public sealed class TickRateMeterTests
{
    private static readonly DateTimeOffset T0 = new(2026, 11, 25, 4, 0, 0, TimeSpan.Zero);   // 09:30 IST

    [Fact]
    public void AMessageAboutEverySecondOrSlowerReadsAsASnapshotFeed()
    {
        var m = new TickRateMeter();
        for (var i = 0; i < 120; i++) m.Record("NIFTY futures trades", T0.AddMilliseconds(i * 1500));
        var r = Assert.Single(m.Snapshot(T0.AddSeconds(180)));
        Assert.Equal(120, r.Total);
        Assert.Equal(1, r.PeakInASecond);
        Assert.StartsWith("Snapshot-like", r.Verdict);
        Assert.Equal(1500, r.MedianGapMs);
    }

    [Fact]
    public void BurstsInsideASecondReadAsTickByTick_AndTheRatesCountTheWindow()
    {
        var m = new TickRateMeter();
        for (var s = 0; s < 40; s++) for (var k = 0; k < 5; k++) m.Record("NIFTY futures trades", T0.AddSeconds(s).AddMilliseconds(k * 60));
        var r = Assert.Single(m.Snapshot(T0.AddSeconds(40)));
        Assert.Equal(200, r.Total);
        Assert.Equal(5, r.PeakInASecond);
        Assert.StartsWith("Tick by tick", r.Verdict);
        Assert.Equal(5.0, r.PerSecond10, 1);
    }

    [Fact]
    public void TooFewMessagesSaysSo_AndAStreamIsKeptApartFromAnother()
    {
        var m = new TickRateMeter();
        for (var i = 0; i < 10; i++) m.Record("a", T0.AddSeconds(i));
        m.Record("b", T0);
        var rates = m.Snapshot(T0.AddSeconds(11));
        Assert.Equal(2, rates.Count);
        Assert.StartsWith("Not enough", rates.First(r => r.Key == "a").Verdict);
    }
}

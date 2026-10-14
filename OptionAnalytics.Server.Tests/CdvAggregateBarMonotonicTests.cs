using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>A Full-mode option packet's timestamp is its LAST TRADE time - a quiet strike's can be
/// minutes old while its OI/depth keep updating. Ticks from an active and a quiet strike therefore
/// interleave two different minutes. The aggregate CDV bar used to follow whichever minute the
/// latest tick carried, so it "closed" and reopened a bar in the past on almost every tick: the
/// bar-closed event (and its full multi-day recompute, under the lock the Dhan receive thread
/// needs) fired constantly, the live feed fell tens of seconds behind, and the CDV history filled
/// with out-of-order bars.</summary>
public sealed class CdvAggregateBarMonotonicTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 1, 4, 46, 0, TimeSpan.Zero);

    private static SpotTick Tick(uint securityId, decimal price, long volume, DateTimeOffset time) =>
        new(securityId, price, price, price, price, price, volume, 0, 0, 0, time);

    [Fact]
    public void QuietStrikesOldTradeTimeNeverReopensAnEarlierBar()
    {
        var state = new CdvUnderlyingState("NIFTY");
        state.EnsureTracked(1, strike: 22600, isCall: true);   // active ATM strike, trading every second
        state.EnsureTracked(2, strike: 23200, isCall: true);   // deep OTM, last traded 5 minutes ago
        var closes = 0;
        state.AggregateBarClosed += () => closes++;

        long activeVolume = 1000, quietVolume = 500;
        for (var second = 0; second <= 120; second++)
        {
            var now = T0.AddSeconds(second);
            state.ApplyTick(Tick(1, 100 + second % 3, activeVolume += 10, now), currentSpot: 22600);
            state.ApplyTick(Tick(2, 2, quietVolume, T0.AddMinutes(-5)), currentSpot: 22600);
        }

        // 04:46 -> 04:47 -> 04:48 over two minutes: exactly two genuine closes.
        Assert.Equal(2, closes);
        var times = state.GetSeries().Select(p => p.Time).ToList();
        Assert.Equal(times.OrderBy(t => t).ToList(), times);
        Assert.Equal(times.Distinct().Count(), times.Count);
        Assert.DoesNotContain(T0.AddMinutes(-5), times);
    }
}

using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;
using Xunit;

namespace OptionAnalytics.Server.Tests;

public class OiCarryForwardTests
{
    private static readonly DateTimeOffset Open = new(2026, 10, 16, 9, 15, 0, IstClock.Offset);
    private static OiReplayPoint Point(int minute, decimal strike, long oi, decimal price = 100m, decimal? iv = 14m) =>
        new(Open.AddMinutes(minute), strike, oi, iv, price, price, price + 2, price - 2, 50);
    private static List<(DateTimeOffset, decimal)> Spot(params decimal[] closes) =>
        closes.Select((c, i) => (Open.AddMinutes(i), c)).ToList();

    [Fact]
    public void A_minute_with_no_reading_holds_the_strike_s_last_value()
    {
        var points = new[] { Point(0, 24000, 1000), Point(0, 24050, 500), Point(1, 24050, 600), Point(3, 24000, 1300) };
        var filled = OiReplayService.CarryForward(points, Spot(24010, 24010, 24010, 24010), 50, 1);

        var at24000 = filled.Where(p => p.Strike == 24000).ToList();
        Assert.Equal(new long?[] { 1000, 1000, 1000, 1300 }, at24000.Select(p => p.OpenInterest));
        Assert.Equal(Enumerable.Range(0, 4).Select(m => Open.AddMinutes(m)), at24000.Select(p => p.Time));
        var carried = at24000[1];
        Assert.Equal((100m, 100m, 100m, 100m, 0L, 14m), (carried.Price, carried.Open!.Value, carried.High!.Value, carried.Low!.Value, carried.Volume, carried.ImpliedVolatility!.Value));
        // 24050 carries its newest reading (600) on, never its older one.
        Assert.Equal(new long?[] { 500, 600, 600, 600 }, filled.Where(p => p.Strike == 24050).Select(p => p.OpenInterest));
    }

    [Fact]
    public void Nothing_is_filled_before_a_strike_s_first_reading_or_outside_the_band()
    {
        var points = new[] { Point(2, 24000, 1000), Point(0, 24500, 70) };
        var filled = OiReplayService.CarryForward(points, Spot(24000, 24000, 24000, 24000), 50, 2);

        // 24000 first read at minute 2: no earlier point appears (no look-ahead).
        Assert.Equal(new[] { Open.AddMinutes(2), Open.AddMinutes(3) }, filled.Where(p => p.Strike == 24000).Select(p => p.Time));
        // 24500 is 10 strikes from ATM - outside a 2-strike band, so it is not carried.
        Assert.Single(filled, p => p.Strike == 24500);
    }

    [Fact]
    public void The_band_follows_spot_minute_by_minute()
    {
        var points = new[] { Point(0, 24100, 900) };
        // ATM 24000 (band +-1 = 23950..24050) at minutes 1-2, then 24100 at minute 3.
        var filled = OiReplayService.CarryForward(points, Spot(24100, 24000, 24000, 24100), 50, 1);
        Assert.Equal(new[] { Open, Open.AddMinutes(3) }, filled.Where(p => p.Strike == 24100).Select(p => p.Time));
    }
}

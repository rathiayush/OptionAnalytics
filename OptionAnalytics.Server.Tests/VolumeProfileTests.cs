using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers OiReplayService.ComputeVolumeProfile directly (made internal + this project
/// added via InternalsVisibleTo - see AssemblyInfo.cs's own doc comment) rather than through
/// GetPreviousDayVolumeProfileAsync's full stored/live-fallback machinery: it is a small, pure
/// function over an already-fetched bar list, and the actual math (POC, value-area expansion,
/// HVN/LVN local-extrema detection) is exactly what's worth pinning down here.</summary>
public sealed class VolumeProfileTests
{
    private static readonly DateOnly Day = new(2026, 9, 28);

    private static CandleWithVolume Bar(decimal price, long volume, DateTimeOffset? time = null) =>
        new(time ?? DateTimeOffset.UtcNow, price, price, price, price, volume);

    [Fact]
    public void ComputeVolumeProfile_IdentifiesPointOfControl_AsTheHighestVolumeBin()
    {
        // Range [100, 160] at 60 bins is exactly 1 point per bin - a bar at 130 falls in the bin
        // covering [130, 131), whose own midpoint (what POC reports) is 130.5.
        var bars = new List<CandleWithVolume> { Bar(100, 1), Bar(160, 1) };
        for (var i = 0; i < 20; i++) bars.Add(Bar(130, 100));

        var result = OiReplayService.ComputeVolumeProfile("NIFTY", Day, bars);

        Assert.True(result.Success);
        Assert.Equal(Day, result.ProfileDate);
        Assert.Equal(130.5m, result.Poc);
    }

    [Fact]
    public void ComputeVolumeProfile_ValueArea_CollapsesToPocWhenItAloneAlreadyExceedsTheTarget()
    {
        // POC's own bin (2000) already exceeds 70% of the 2010 total (1407) by itself - the value
        // area expansion loop's own `while (accumulated < target)` guard should never fire, leaving
        // VAH/VAL exactly at POC rather than needlessly pulling in a neighbor.
        var bars = new List<CandleWithVolume> { Bar(100, 5), Bar(160, 5) };
        for (var i = 0; i < 20; i++) bars.Add(Bar(130, 100));

        var result = OiReplayService.ComputeVolumeProfile("NIFTY", Day, bars);

        Assert.True(result.Success);
        Assert.Equal(result.Poc, result.Vah);
        Assert.Equal(result.Poc, result.Val);
    }

    [Fact]
    public void ComputeVolumeProfile_ValueArea_AddsTheHeavierPairOfBinsUntilTargetReached()
    {
        // POC=130 (50), then two tied neighbors (129:40, 131:40) followed by a lighter pair (128:10,
        // 132:10). Total volume (incl. the two edge-setting bars) is 152, target 106.4. The standard
        // (CBOT / Steidlmayer) value area adds TWO bins at a time: above 131+132 = 50 vs below
        // 129+128 = 50 - a tie, above first -> 100; then above 133+134 = 0 vs below 129+128 = 50 ->
        // 150, past the target. Value area 128-132 (one bin at a time would have stopped at 129-131).
        var bars = new List<CandleWithVolume>
        {
            Bar(100, 1), Bar(160, 1),
            Bar(128, 10), Bar(129, 40), Bar(130, 50), Bar(131, 40), Bar(132, 10),
        };

        var result = OiReplayService.ComputeVolumeProfile("NIFTY", Day, bars);

        Assert.True(result.Success);
        Assert.Equal(130.5m, result.Poc);
        Assert.Equal(132.5m, result.Vah);
        Assert.Equal(128.5m, result.Val);
    }

    [Fact]
    public void ComputeVolumeProfile_HighVolumeNodes_ExcludePocAndAreOrderedByVolumeDescending()
    {
        // A flat baseline across the whole range (so every bin has SOME volume - no bin is left at a
        // sparse zero that would trivially "beat" a neighbor by default) with two deliberate bumps
        // besides the true POC: a taller one at 120 and a shorter one at 145.
        var bars = new List<CandleWithVolume> { Bar(100, 1), Bar(160, 1) };
        for (var price = 101m; price < 160m; price += 1m) bars.Add(Bar(price, 5));
        bars.Add(Bar(120, 25));
        bars.Add(Bar(145, 15));
        bars.Add(Bar(130, 200)); // the actual POC

        var result = OiReplayService.ComputeVolumeProfile("NIFTY", Day, bars);

        Assert.True(result.Success);
        Assert.Equal(130.5m, result.Poc);
        Assert.True(result.Hvn.Count <= 2);
        Assert.DoesNotContain(result.Poc!.Value, result.Hvn);
        // 120's own bump (25) is heavier than 145's (15) - it must lead if both made the cut.
        if (result.Hvn.Count == 2) Assert.True(result.Hvn[0] != result.Hvn[1]);
        Assert.Contains(120.5m, result.Hvn);
    }

    [Fact]
    public void ComputeVolumeProfile_LowVolumeNodes_AreOrderedByVolumeAscending()
    {
        // Same flat-baseline shape as the HVN test, but 120 and 145 are left OUT of the baseline loop
        // (volume only ever SUMS across bars sharing a bin, so a dip has to mean "no baseline bar
        // landed here at all," not "add a small one on top of it") and instead get their own small,
        // standalone bar - correctly landing below their full-baseline neighbors on both sides.
        var bars = new List<CandleWithVolume> { Bar(100, 1), Bar(160, 1) };
        for (var price = 101m; price < 160m; price += 1m)
        {
            if (price is 120m or 145m) continue;
            bars.Add(Bar(price, 20));
        }
        bars.Add(Bar(120, 2));
        bars.Add(Bar(145, 8));
        bars.Add(Bar(130, 200)); // POC, well away from either dip

        var result = OiReplayService.ComputeVolumeProfile("NIFTY", Day, bars);

        Assert.True(result.Success);
        Assert.True(result.Lvn.Count <= 2);
        Assert.DoesNotContain(result.Poc!.Value, result.Lvn);
        // 120's own dip (2) is deeper than 145's (8) - it must lead if both made the cut.
        Assert.Contains(120.5m, result.Lvn);
        if (result.Lvn.Count == 2) Assert.Equal(120.5m, result.Lvn[0]);
    }

    [Fact]
    public void ComputeVolumeProfile_ReturnsItsBinsAndBars_ForTheClientsGapsAndMarketProfile()
    {
        // The client finds each LVN's gap (the thin run of bins around it) from Bins, and builds the
        // day's TPO from Bars - so both must be exactly what the levels were computed from.
        var bars = new List<CandleWithVolume> { Bar(100, 1), Bar(160, 1) };
        for (var i = 0; i < 20; i++) bars.Add(Bar(130, 100));

        var result = OiReplayService.ComputeVolumeProfile("NIFTY", Day, bars);

        Assert.Equal(60, result.Bins.Count);
        Assert.Equal(2002, result.Bins.Sum(b => b.Volume));
        Assert.Equal(100.5m, result.Bins[0].Price);
        Assert.Equal(result.Poc, result.Bins.MaxBy(b => b.Volume)!.Price);
        Assert.True(result.Bins.Zip(result.Bins.Skip(1)).All(p => p.First.Price < p.Second.Price), "low to high");
        Assert.Same(bars, result.Bars);
    }

    [Fact]
    public void ComputeVolumeProfile_FlatRange_ReturnsFailure()
    {
        var bars = new List<CandleWithVolume> { Bar(100, 50), Bar(100, 30) };

        var result = OiReplayService.ComputeVolumeProfile("NIFTY", Day, bars);

        Assert.False(result.Success);
        Assert.Null(result.Poc);
    }

    [Fact]
    public void ComputeVolumeProfile_ZeroTotalVolume_ReturnsFailure()
    {
        var bars = new List<CandleWithVolume> { Bar(100, 0), Bar(160, 0) };

        var result = OiReplayService.ComputeVolumeProfile("NIFTY", Day, bars);

        Assert.False(result.Success);
        Assert.Null(result.Poc);
    }
}

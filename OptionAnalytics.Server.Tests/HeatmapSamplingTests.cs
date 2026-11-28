using OptionAnalytics.Server.Services.OrderFlow;
using Xunit;

namespace OptionAnalytics.Server.Tests;

/// <summary>The heatmap's columns are picked by the CLOCK, not by a stride over what is recorded: the live scan (part of the
/// day) and a backtest (the whole day) must read the same columns for the same minutes.</summary>
public class HeatmapSamplingTests
{
    private static readonly DateTimeOffset Open = new(2026, 11, 27, 9, 15, 0, TimeSpan.FromHours(5.5));

    private static List<OrderFlowEngine.DepthSnapshot> Day(int seconds) =>
        Enumerable.Range(0, seconds).Select(i => new OrderFlowEngine.DepthSnapshot(Open.AddSeconds(i), new[] { new HeatRow(i, 1) }, Array.Empty<HeatRow>())).ToList();

    [Fact]
    public void AColumnIsTheSameWhateverPartOfTheDayIsRecorded()
    {
        var whole = OrderFlowEngine.SampleByClock(Day(375 * 60), 750);
        Assert.InRange(whole.Count, 700, 751);
        foreach (var cutMinutes in new[] { 20, 61, 133, 250 })
        {
            var part = OrderFlowEngine.SampleByClock(Day(cutMinutes * 60), 750);
            // every column but the forming (last) one is exactly the whole day's
            foreach (var c in part.Take(part.Count - 1)) Assert.Contains(whole, w => w.Time == c.Time);
        }
    }

    [Fact]
    public void ShortDayKeepsEverySnapshotWhenTheyFit()
    {
        Assert.Equal(60, OrderFlowEngine.SampleByClock(Day(60), 22500).Count);
        Assert.Empty(OrderFlowEngine.SampleByClock(new List<OrderFlowEngine.DepthSnapshot>(), 750));
    }
}

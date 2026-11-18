using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services.OrderFlow;

namespace OptionAnalytics.Server.Tests;

/// <summary>The footprint's COT high / low (Sierra Chart's "Commitment of Traders"): each minute bar's delta traded AFTER its
/// last new high and after its last new low - kept with the day, none for a minute saved before it was kept.</summary>
public sealed class OrderFlowCotTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 5, 4, 0, 0, TimeSpan.Zero); // 09:30 IST

    private static readonly DepthLevel[] Bids = { new(100.00m, 750, 5) };
    private static readonly DepthLevel[] Asks = { new(100.05m, 750, 5) };

    private static OrderFlowEngine NewEngine() => new("NIFTY", 35001, "NIFTY-Oct2026-FUT", "NSE_FNO", 0.05m, 75);

    private static SpotTick Tick(decimal price, long volume, DateTimeOffset at) =>
        new(35001, price, 0, 0, 0, 0, volume, 100.00m, 100.05m, 0, at) { Bids = Bids, Asks = Asks };

    private static OrderFlowEngine Traded()
    {
        var engine = NewEngine();
        engine.OnTick(Tick(100.00m, 1000, T0), T0);                                      // the baseline
        engine.OnTick(Tick(100.05m, 1150, T0.AddSeconds(1)), T0.AddSeconds(1));          // buy 150 - the bar's high and low
        engine.OnTick(Tick(100.10m, 1225, T0.AddSeconds(2)), T0.AddSeconds(2));          // buy 75 - a new high: after it 0; after the low +75
        engine.OnTick(Tick(100.00m, 1525, T0.AddSeconds(3)), T0.AddSeconds(3));          // sell 300 - a new low: after it 0; after the high -300
        engine.OnTick(Tick(100.05m, 1600, T0.AddSeconds(4)), T0.AddSeconds(4));          // buy 75: after the high -225, after the low +75
        return engine;
    }

    [Fact]
    public void Cot_is_the_delta_after_the_bars_last_new_high_and_low()
    {
        var bar = Assert.Single(Traded().Snapshot(rowSize: 0, minTradeQty: 1, heatmapColumns: 10).Bars);
        Assert.Equal((100.10m, 100.00m), (bar.High, bar.Low));
        Assert.Equal(300 - 300, bar.Buy - bar.Sell);
        Assert.Equal(-225L, bar.CotHigh);
        Assert.Equal(75L, bar.CotLow);
    }

    [Fact]
    public void Cot_is_kept_with_the_day_and_a_day_saved_before_it_has_none()
    {
        var day = Traded().ExportDay()!;
        var restored = Assert.Single(OrderFlowEngine.FromDay(day).Snapshot(rowSize: 0, minTradeQty: 1, heatmapColumns: 10).Bars);
        Assert.Equal((-225L, 75L), (restored.CotHigh!.Value, restored.CotLow!.Value));

        for (var i = 0; i < day.Bars.Count; i++) day.Bars[i] = day.Bars[i] with { Cot = null };   // as saved before
        var old = OrderFlowEngine.FromDay(day);
        Assert.Null(Assert.Single(old.Snapshot(rowSize: 0, minTradeQty: 1, heatmapColumns: 10).Bars).CotHigh);
        // Traded on in the same minute: still none - the part of the minute before the save is not known.
        old.OnTick(Tick(100.05m, 1600, T0.AddSeconds(5)), T0.AddSeconds(5));
        old.OnTick(Tick(100.05m, 1675, T0.AddSeconds(6)), T0.AddSeconds(6));
        var after = Assert.Single(old.Snapshot(rowSize: 0, minTradeQty: 1, heatmapColumns: 10).Bars);
        Assert.Null(after.CotHigh);
        Assert.Null(after.CotLow);
    }
}

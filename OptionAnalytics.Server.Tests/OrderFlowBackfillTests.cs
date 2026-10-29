using OptionAnalytics.Server.Services;
using OptionAnalytics.Server.Services.OrderFlow;

namespace OptionAnalytics.Server.Tests;

/// <summary>A day the Order Flow engine only started recording part way (a restart, a deploy): the minutes before are
/// estimated from Dhan's 1-minute candles (OrderFlowHistory.WithBackfillAsync). A server started after the close recorded
/// none of the session - the whole of it is the estimate, or the Profiles page had no futures of the day at all.</summary>
public class OrderFlowBackfillTests
{
    private static readonly DateOnly Day = new(2026, 10, 29);
    private static DateTimeOffset Ist(int h, int m, int s = 0) => new(2026, 10, 29, h, m, s, IstClock.Offset);

    [Fact]
    public void Recording_from_before_the_open_needs_no_estimate()
    {
        Assert.Null(OrderFlowHistory.BackfillCutoff(Ist(8, 59), Day));
        Assert.Null(OrderFlowHistory.BackfillCutoff(Ist(9, 15), Day));
    }

    [Fact]
    public void A_restart_part_way_is_estimated_up_to_the_first_whole_minute_it_recorded()
    {
        Assert.Equal(Ist(13, 5), OrderFlowHistory.BackfillCutoff(Ist(13, 5, 1), Day));   // joined on the minute
        Assert.Equal(Ist(13, 6), OrderFlowHistory.BackfillCutoff(Ist(13, 5, 30), Day));  // that minute is incomplete too
    }

    [Fact]
    public void A_restart_after_the_close_has_the_whole_session_estimated()
    {
        var cutoff = OrderFlowHistory.BackfillCutoff(Ist(20, 30, 12), Day);
        Assert.NotNull(cutoff);
        Assert.True(cutoff >= Ist(15, 30));
    }

    [Fact]
    public void The_whole_bars_go_out_only_when_asked_the_minutes_always()
    {
        var meta = default(OrderFlowMeta)!;
        var snapshot = new OrderFlowSnapshot(meta, 1, Array.Empty<OrderFlowBar>(), Array.Empty<OrderFlowTrade>(), Array.Empty<OrderFlowIceberg>(),
            Array.Empty<HeatmapColumn>(), new OrderFlowBook(Array.Empty<BookLevel>(), Array.Empty<BookLevel>()));
        var minutes = new[] { new OrderFlowBackfillMinute(Ist(9, 15), 10, 5) };
        var bars = new[] { new OrderFlowBar(Ist(9, 15), 100, 102, 99, 101, 10, 5, 0, new[] { new FootprintLevel(100, 10, 5) }) };

        var plain = OrderFlowHistory.AttachBackfill(snapshot, Ist(20, 30), minutes, bars, includeBars: false);
        Assert.Single(plain.Backfill);
        Assert.Empty(plain.BackfillBars);
        Assert.Empty(plain.Bars); // the recorded bars are never touched

        var asked = OrderFlowHistory.AttachBackfill(snapshot, Ist(20, 30), minutes, bars, includeBars: true);
        Assert.Single(asked.BackfillBars);
        Assert.Equal(Ist(20, 30), asked.RecordedFrom);
        Assert.Empty(asked.Bars);
    }
}

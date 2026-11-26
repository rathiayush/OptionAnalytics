using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>A CDV rebuild that never ends (its Dhan calls hung) left today's totals frozen for hours; and a tick filed under a
/// stale exchange time left the line at an old minute.</summary>
public sealed class CdvStalledBackfillTests
{
    private static readonly DateTimeOffset T0 = new(2026, 11, 26, 9, 43, 0, IstClock.Offset);
    private const decimal Spot = 25_900;

    private static SpotTick Tick(decimal price, long vol, DateTimeOffset exchange, DateTimeOffset? arrived = null) =>
        new(1, price, price, price, price, price, vol, 0, 0, 0, exchange) { ReceivedAt = arrived };

    [Fact]
    public void A_rebuild_pending_too_long_is_dropped_and_ticks_draw_again()
    {
        var state = new CdvUnderlyingState("NIFTY");
        state.EnsureTracked(1, 25_900, isCall: true);
        state.BeginCdvBackfill(T0);
        state.ApplyTick(Tick(100, 1_000, T0.AddSeconds(5)), Spot);
        state.ApplyTick(Tick(101, 2_000, T0.AddSeconds(65)), Spot);
        Assert.Empty(state.GetSeries());

        Assert.False(state.AbandonStalledBackfill(TimeSpan.FromMinutes(6), T0.AddMinutes(5)));
        Assert.NotNull(state.BackfillPendingSince);
        Assert.True(state.AbandonStalledBackfill(TimeSpan.FromMinutes(6), T0.AddMinutes(7)));
        Assert.Null(state.BackfillPendingSince);

        state.ApplyTick(Tick(102, 3_000, T0.AddMinutes(8)), Spot);
        Assert.NotEmpty(state.GetSeries().Append(state.ToSnapshot().CurrentBar!.Value));
    }

    [Fact]
    public void A_tick_with_a_stale_exchange_time_is_filed_by_its_arrival()
    {
        var state = new CdvUnderlyingState("NIFTY");
        state.EnsureTracked(1, 25_900, isCall: true);
        state.ApplyTick(Tick(100, 1_000, T0, T0), Spot);
        var now = T0.AddHours(5);
        state.ApplyTick(Tick(101, 2_000, T0, now), Spot);
        Assert.True(state.ToSnapshot().CurrentBar!.Value.Time >= now.AddMinutes(-1));
    }
}

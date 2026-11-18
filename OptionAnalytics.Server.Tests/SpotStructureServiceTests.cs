using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>The Spot structure page's candles (SpotStructureService): session-anchored buckets (a 4-hour candle is 09:15 -
/// 13:15 and 13:15 - 15:30), past days asked in pieces Dhan serves and held for the day, today from the feed.</summary>
public sealed class SpotStructureServiceTests
{
    private static readonly TimeSpan Ist = TimeSpan.FromHours(5.5);
    private static DateTimeOffset At(int day, int hour, int minute) => new(2026, 11, day, hour, minute, 0, Ist);
    private static CandleWithVolume C(DateTimeOffset t, decimal o, decimal h, decimal l, decimal c, long v = 10) => new(t, o, h, l, c, v);

    [Fact]
    public void Candles_are_bucketed_on_the_session_from_0915()
    {
        // Hourly candles of one day (Dhan's 60-minute interval): 09:15 ... 15:15.
        var hours = Enumerable.Range(0, 7).Select(i => C(At(16, 9, 15).AddHours(i), 100 + i, 105 + i, 95 + i, 101 + i)).ToList();
        var fourHour = SpotStructureService.Aggregate(hours, 240);
        Assert.Equal(new[] { At(16, 9, 15), At(16, 13, 15) }, fourHour.Select(c => c.Time));
        Assert.Equal((100m, 108m, 95m, 104m, 40L), (fourHour[0].Open, fourHour[0].High, fourHour[0].Low, fourHour[0].Close, fourHour[0].Volume));
        Assert.Equal((104m, 111m, 99m, 107m, 30L), (fourHour[1].Open, fourHour[1].High, fourHour[1].Low, fourHour[1].Close, fourHour[1].Volume));
        var day = Assert.Single(SpotStructureService.Aggregate(hours, 1440));
        Assert.Equal((At(16, 9, 15), 100m, 111m, 95m, 107m, 70L), (day.Time, day.Open, day.High, day.Low, day.Close, day.Volume));
        Assert.Equal(7, SpotStructureService.Aggregate(hours, 60).Count);
    }

    [Fact]
    public void Minutes_outside_the_session_and_repeated_minutes_are_left_out()
    {
        var minutes = new[]
        {
            C(At(16, 9, 14), 1, 1000, 1, 1),         // before the open
            C(At(16, 9, 15), 100, 101, 99, 100),
            C(At(16, 9, 16), 100, 102, 100, 102),
            C(At(16, 9, 16), 100, 102, 100, 102),    // the same minute twice (read and fed)
            C(At(16, 9, 17), 102, 103, 101, 101),
            C(At(16, 15, 30), 1, 2000, 1, 1),        // after the close
        };
        var three = Assert.Single(SpotStructureService.Aggregate(minutes, 3));
        Assert.Equal((100m, 103m, 99m, 101m, 30L), (three.Open, three.High, three.Low, three.Close, three.Volume));
    }

    [Fact]
    public void Past_days_are_asked_in_pieces_dhan_serves_ending_on_the_last_weekday()
    {
        Assert.Equal(new DateOnly(2026, 11, 13), SpotStructureService.LastWeekdayBefore(new DateOnly(2026, 11, 16)));   // Monday -> Friday
        Assert.Equal(new DateOnly(2026, 11, 17), SpotStructureService.LastWeekdayBefore(new DateOnly(2026, 11, 18)));
        var chunks = SpotStructureService.Chunks(new DateOnly(2026, 1, 1), new DateOnly(2026, 6, 30)).ToList();
        Assert.All(chunks, c => Assert.True(c.To.DayNumber - c.From.DayNumber + 1 <= SpotStructureService.ChunkDays));
        Assert.Equal(new DateOnly(2026, 1, 1), chunks[0].From);
        Assert.Equal(new DateOnly(2026, 6, 30), chunks[^1].To);
        for (var i = 1; i < chunks.Count; i++) Assert.Equal(chunks[i - 1].To.AddDays(1), chunks[i].From);
    }

    [Fact]
    public async Task Past_days_are_held_for_the_day_today_comes_from_the_feed_and_a_failure_is_not_held()
    {
        var asked = new List<(DateOnly, DateOnly, int)>();
        var todayAsked = 0;
        var fail = false;
        var now = At(18, 10, 0);
        var service = new SpotStructureService(
            (u, from, to, interval, ct) =>
            {
                asked.Add((from, to, interval));
                return Task.FromResult<(IReadOnlyList<CandleWithVolume>, string?)>(fail
                    ? (Array.Empty<CandleWithVolume>(), "Dhan is not authenticated")
                    : (new[] { C(At(17, 9, 15), 100, 110, 90, 105) }, null));
            },
            (u, date, ct) => { todayAsked++; return Task.FromResult<(IReadOnlyList<CandleWithVolume>, string?)>((new[] { C(At(18, 9, 15), 105, 120, 104, 118) }, null)); },
            () => now);

        var first = await service.CandlesAsync("nifty", 1440, 30, default);
        Assert.Equal(2, first.Candles.Count);
        Assert.True(first.TodayIncluded);
        Assert.Null(first.Error);
        Assert.Equal((new DateOnly(2026, 10, 19), new DateOnly(2026, 11, 17), 60), Assert.Single(asked));
        // The page's refresh: the past from memory, today read again; the hourly view the same held days.
        await service.CandlesAsync("NIFTY", 1440, 30, default);
        await service.CandlesAsync("NIFTY", 60, 30, default);
        Assert.Single(asked);
        Assert.Equal(3, todayAsked);

        // A failure is said and not held - the next load asks again.
        fail = true;
        var failed = await service.CandlesAsync("NIFTY", 15, 30, default);
        Assert.Contains("Dhan is not authenticated", failed.Error);
        await service.CandlesAsync("NIFTY", 15, 30, default);
        Assert.Equal(3, asked.Count);

        // A Sunday: no today asked.
        now = At(22, 12, 0);
        fail = false;
        var sunday = await service.CandlesAsync("NIFTY", 1440, 30, default);
        Assert.False(sunday.TodayIncluded);
        Assert.Equal(new DateOnly(2026, 11, 20), asked[^1].Item2);
        Assert.Equal(5, todayAsked);
    }
}

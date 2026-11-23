using OptionAnalytics.Server.Dhan;
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
    public void A_window_of_past_days_ends_on_the_last_weekday()
    {
        Assert.Equal(new DateOnly(2026, 11, 13), SpotStructureService.LastWeekdayBefore(new DateOnly(2026, 11, 16)));   // Monday -> Friday
        Assert.Equal(new DateOnly(2026, 11, 17), SpotStructureService.LastWeekdayBefore(new DateOnly(2026, 11, 18)));
    }

    [Fact]
    public void History_counts_trading_days_so_a_Monday_still_has_the_sessions_before_it()
    {
        // "2 days" on Monday 23 Nov = Thursday and Friday (calendar days were Saturday and Sunday - no past session at all).
        Assert.Equal(new[] { new DateOnly(2026, 11, 19), new DateOnly(2026, 11, 20) }, SpotStructureService.PastWeekdays(new DateOnly(2026, 11, 23), 2));
        Assert.Equal(new[] { new DateOnly(2026, 11, 13), new DateOnly(2026, 11, 16), new DateOnly(2026, 11, 17) }, SpotStructureService.PastWeekdays(new DateOnly(2026, 11, 18), 3));
        Assert.Equal(new[] { new DateOnly(2026, 11, 20) }, SpotStructureService.PastWeekdays(new DateOnly(2026, 11, 22), 1));   // a Sunday
    }

    // One session of 1-minute candles (09:15 - 15:29) of `day`, rising a point a minute from `from`.
    private static IEnumerable<CandleWithVolume> Session(int day, decimal from) =>
        Enumerable.Range(0, 375).Select(i => C(At(day, 9, 15).AddMinutes(i), from + i, from + i + 1, from + i - 1, from + i + 0.5m, 1));

    [Fact]
    public async Task Every_timeframe_is_built_from_the_held_1_minute_days_and_the_past_is_asked_once_a_day()
    {
        var asked = new List<(DateOnly From, DateOnly To)>();
        var todayAsked = 0;
        string? fail = null;
        var now = At(18, 10, 0);   // Wednesday 18 Nov, 10:00
        var service = new SpotStructureService(
            (u, from, to, ct) =>
            {
                asked.Add((from, to));
                var candles = fail is null ? Session(16, 100).Concat(Session(17, 200)).Where(c => IstDate(c.Time) >= from && IstDate(c.Time) <= to).ToList() : new List<CandleWithVolume>();
                return Task.FromResult(new DhanHistoricalDataService.IndexRange(candles, fail, fail is null ? 2 : 0, 0));
            },
            (u, date, ct) => { todayAsked++; return Task.FromResult<(IReadOnlyList<CandleWithVolume>, string?)>((Session(18, 300).Take(45).ToList(), null)); },
            () => now);

        var day = await service.CandlesAsync("nifty", 1440, 2, default);
        Assert.Equal((new DateOnly(2026, 11, 16), new DateOnly(2026, 11, 17)), Assert.Single(asked));   // the 2 weekdays before Wednesday
        Assert.Equal(3, day.Candles.Count);                                                               // Mon, Tue and today so far
        Assert.Equal((100m, 475m, 99m, 474.5m), (day.Candles[0].Open, day.Candles[0].High, day.Candles[0].Low, day.Candles[0].Close));
        Assert.Equal(375L, day.Candles[0].Volume);
        Assert.True(day.TodayIncluded);
        Assert.Equal((0, 2, 0), (day.DaysHeld, day.DaysFromDisk, day.DaysAskedOfDhan));

        // 4H / 1H / 15m / 5m / 3m / 1m of the same held days: nothing asked again, each bucketed on the session.
        var fourHour = await service.CandlesAsync("NIFTY", 240, 2, default);
        Assert.Equal(new[] { At(16, 9, 15), At(16, 13, 15), At(17, 9, 15), At(17, 13, 15), At(18, 9, 15) }, fourHour.Candles.Select(c => c.Time));
        Assert.Equal(7 * 2 + 1, (await service.CandlesAsync("NIFTY", 60, 2, default)).Candles.Count);
        Assert.Equal(25 * 2 + 3, (await service.CandlesAsync("NIFTY", 15, 2, default)).Candles.Count);
        Assert.Equal(125 * 2 + 15, (await service.CandlesAsync("NIFTY", 3, 2, default)).Candles.Count);
        var one = await service.CandlesAsync("NIFTY", 1, 2, default);
        Assert.Equal(375 * 2 + 45, one.Candles.Count);
        Assert.Equal((2, 0, 0), (one.DaysHeld, one.DaysFromDisk, one.DaysAskedOfDhan));
        Assert.Single(asked);
        Assert.Equal(6, todayAsked);

        // A failure is said and the days are not held - the next load asks again.
        var other = new SpotStructureService((u, from, to, ct) => { asked.Add((from, to)); return Task.FromResult(new DhanHistoricalDataService.IndexRange(Array.Empty<CandleWithVolume>(), "Not sent", 0, 2)); },
            (u, date, ct) => Task.FromResult<(IReadOnlyList<CandleWithVolume>, string?)>((Array.Empty<CandleWithVolume>(), null)), () => now);
        Assert.Contains("Not sent", (await other.CandlesAsync("NIFTY", 60, 3, default)).Error);
        await other.CandlesAsync("NIFTY", 60, 3, default);
        Assert.Equal(3, asked.Count);

        // A Sunday: today is not asked, the window ends on Friday.
        now = At(22, 12, 0);
        var sunday = await service.CandlesAsync("NIFTY", 1440, 3, default);
        Assert.False(sunday.TodayIncluded);
        Assert.Equal(new DateOnly(2026, 11, 20), asked[^1].To);
        Assert.Equal(6, todayAsked);
    }

    private static DateOnly IstDate(DateTimeOffset t) => DateOnly.FromDateTime(t.ToOffset(Ist).DateTime);
}

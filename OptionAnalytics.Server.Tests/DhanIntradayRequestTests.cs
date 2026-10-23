using OptionAnalytics.Server;
using OptionAnalytics.Server.Dhan;
using Xunit;

namespace OptionAnalytics.Server.Tests;

/// <summary>Where an intraday request to Dhan ends (DhanHistoricalDataService.IntradayToDate): a past day at the close,
/// today - while the session is on - at the minute after now, never in the future.</summary>
public class DhanIntradayRequestTests
{
    private static readonly DateOnly Today = new(2026, 10, 23);
    private static DateTimeOffset Ist(int day, int h, int m, int s = 0) => new(2026, 10, day, h, m, s, IstClock.Offset);

    [Fact]
    public void A_past_day_ends_at_the_close()
    {
        Assert.Equal("2026-10-22 15:30:00", DhanHistoricalDataService.IntradayToDate(new DateOnly(2026, 10, 22), Ist(23, 11, 3)));
    }

    [Fact]
    public void Today_ends_at_the_minute_after_now_while_the_session_is_on()
    {
        Assert.Equal("2026-10-23 11:04:00", DhanHistoricalDataService.IntradayToDate(Today, Ist(23, 11, 3, 42)));
        // UTC clock, IST day: 05:33 UTC is 11:03 IST.
        Assert.Equal("2026-10-23 11:04:00", DhanHistoricalDataService.IntradayToDate(Today, new DateTimeOffset(2026, 10, 23, 5, 33, 10, TimeSpan.Zero)));
    }

    [Fact]
    public void Before_the_open_never_before_9_16_and_after_the_close_the_close()
    {
        Assert.Equal("2026-10-23 09:16:00", DhanHistoricalDataService.IntradayToDate(Today, Ist(23, 8, 0)));
        Assert.Equal("2026-10-23 15:30:00", DhanHistoricalDataService.IntradayToDate(Today, Ist(23, 15, 30)));
        Assert.Equal("2026-10-23 15:30:00", DhanHistoricalDataService.IntradayToDate(Today, Ist(23, 18, 0)));
    }
}

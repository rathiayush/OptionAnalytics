using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>The OI Replay options' expiry date (the GEX card's time to expiry): the weekday rule - NIFTY / BANKNIFTY on
/// Tuesday, SENSEX on Thursday from 1 Sep 2025, the older weekdays before - Dhan's own list from today on, and a past rule
/// day Dhan has no trading for moved back to the trading day before (a holiday).</summary>
public sealed class OptionExpiryResolverTests
{
    private static DateOnly D(int y, int m, int d) => new(y, m, d);

    [Fact]
    public void Nifty_ExpiresTuesday_Sensex_Thursday_BankniftyMonthly_TheLastTuesday()
    {
        // October 2026: Tuesdays 6, 13, 20, 27; Thursdays 1, 8, 15, 22, 29.
        Assert.Equal(D(2026, 10, 20), ExpiryCalendar.NearestOptionExpiry("NIFTY", D(2026, 10, 19), "WEEK"));
        Assert.Equal(D(2026, 10, 20), ExpiryCalendar.NearestOptionExpiry("NIFTY", D(2026, 10, 20), "WEEK")); // the expiry day itself
        Assert.Equal(D(2026, 10, 27), ExpiryCalendar.NearestOptionExpiry("NIFTY", D(2026, 10, 21), "WEEK"));
        Assert.Equal(D(2026, 10, 22), ExpiryCalendar.NearestOptionExpiry("SENSEX", D(2026, 10, 19), "WEEK"));
        Assert.Equal(D(2026, 10, 29), ExpiryCalendar.NearestOptionExpiry("SENSEX", D(2026, 10, 23), "WEEK"));
        Assert.Equal(D(2026, 10, 27), ExpiryCalendar.NearestOptionExpiry("BANKNIFTY", D(2026, 10, 5), "MONTH"));
        Assert.Equal(D(2026, 11, 24), ExpiryCalendar.NearestOptionExpiry("BANKNIFTY", D(2026, 10, 28), "MONTH"));
        Assert.Equal(D(2026, 10, 27), ExpiryCalendar.NearestOptionExpiry("NIFTY", D(2026, 10, 5), "MONTH"));
    }

    [Fact]
    public void BeforeSeptember2025_TheOlderWeekdays_AndTheChangeoverWeek()
    {
        // NSE on Thursday until the end of August 2025; the first Tuesday expiry was 2 September.
        Assert.Equal(D(2025, 8, 28), ExpiryCalendar.NearestOptionExpiry("NIFTY", D(2025, 8, 25), "WEEK"));
        Assert.Equal(D(2025, 9, 2), ExpiryCalendar.NearestOptionExpiry("NIFTY", D(2025, 8, 29), "WEEK"));
        Assert.Equal(D(2025, 8, 28), ExpiryCalendar.NearestOptionExpiry("BANKNIFTY", D(2025, 8, 1), "MONTH"));
        // SENSEX on Tuesday in 2025 until August, Friday before 2025; Thursday from 4 September 2025.
        Assert.Equal(D(2025, 8, 26), ExpiryCalendar.NearestOptionExpiry("SENSEX", D(2025, 8, 25), "WEEK"));
        Assert.Equal(D(2025, 9, 4), ExpiryCalendar.NearestOptionExpiry("SENSEX", D(2025, 8, 27), "WEEK"));
        Assert.Equal(D(2024, 12, 20), ExpiryCalendar.NearestOptionExpiry("SENSEX", D(2024, 12, 16), "WEEK"));
    }

    private static OptionExpiryResolver Resolver(DateOnly today, IReadOnlyList<DateOnly>? listed = null, Func<DateOnly, bool?>? traded = null, List<DateOnly>? asked = null) =>
        new(
            (_, _) => Task.FromResult(listed ?? (IReadOnlyList<DateOnly>)Array.Empty<DateOnly>()),
            (_, day, _) => { asked?.Add(day); return Task.FromResult(traded is null ? true : traded(day)); },
            () => today);

    [Fact]
    public async Task FromToday_TheExpiryIsDhans_HolidayMovesIncluded()
    {
        // Tuesday 20 Oct a holiday: Dhan lists Monday 19 Oct as the week's expiry.
        var resolver = Resolver(D(2026, 10, 16), listed: new[] { D(2026, 10, 19), D(2026, 10, 27), D(2026, 11, 3) });
        Assert.Equal((D(2026, 10, 19), OptionExpiryResolver.FromDhan), await resolver.ResolveAsync("NIFTY", D(2026, 10, 16), "WEEK", default));
        // Nothing listed: the rule's date.
        var empty = Resolver(D(2026, 10, 16));
        Assert.Equal((D(2026, 10, 20), OptionExpiryResolver.FromCalendar), await empty.ResolveAsync("NIFTY", D(2026, 10, 16), "WEEK", default));
    }

    [Fact]
    public async Task APastRuleDay_ThatTraded_IsTheExpiry_AHoliday_MovesItToTheTradingDayBefore()
    {
        var asked = new List<DateOnly>();
        var traded = Resolver(D(2026, 11, 2), asked: asked);
        Assert.Equal((D(2026, 10, 22), OptionExpiryResolver.FromCalendar), await traded.ResolveAsync("SENSEX", D(2026, 10, 19), "WEEK", default));
        Assert.Equal(new[] { D(2026, 10, 22) }, asked);
        // Kept: asked once.
        await traded.ResolveAsync("SENSEX", D(2026, 10, 19), "WEEK", default);
        Assert.Single(asked);

        // Tuesday 20 Oct and Monday 19 Oct holidays: the expiry was Friday 16 Oct (the weekend skipped).
        asked.Clear();
        var holidays = Resolver(D(2026, 11, 2), traded: d => d != D(2026, 10, 20) && d != D(2026, 10, 19), asked: asked);
        Assert.Equal((D(2026, 10, 16), OptionExpiryResolver.FromCalendarHoliday), await holidays.ResolveAsync("NIFTY", D(2026, 10, 14), "WEEK", default));
        Assert.Equal(new[] { D(2026, 10, 20), D(2026, 10, 19), D(2026, 10, 16) }, asked);

        // Never before the replayed day: it traded, so stepping back to it makes it the expiry.
        var toDay = Resolver(D(2026, 11, 2), traded: d => d != D(2026, 10, 20));
        Assert.Equal((D(2026, 10, 19), OptionExpiryResolver.FromCalendarHoliday), await toDay.ResolveAsync("NIFTY", D(2026, 10, 19), "WEEK", default));
    }

    [Fact]
    public async Task WhenDhanCannotSay_TheRulesDateStands_AndIsAskedAgainNextTime()
    {
        var asked = new List<DateOnly>();
        var unsure = Resolver(D(2026, 11, 2), traded: _ => null, asked: asked);
        Assert.Equal((D(2026, 10, 20), OptionExpiryResolver.FromCalendar), await unsure.ResolveAsync("NIFTY", D(2026, 10, 19), "WEEK", default));
        await unsure.ResolveAsync("NIFTY", D(2026, 10, 19), "WEEK", default);
        Assert.Equal(2, asked.Count);
    }
}

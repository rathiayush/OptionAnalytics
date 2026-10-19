using OptionAnalytics.Server.Services;
using Xunit;

namespace OptionAnalytics.Server.Tests;

/// <summary>Today's Dhan answers shared for a minute (TodayFetchShare) - an OI Replay page reloading, another tab
/// or another index's seed does not ask Dhan for the whole day again.</summary>
public class TodayFetchShareTests
{
    private static readonly DateOnly Today = new(2026, 10, 19);

    [Fact]
    public async Task Todays_answer_is_reused_within_the_window_and_asked_again_after_it()
    {
        var now = DateTimeOffset.Parse("2026-10-19T05:00:00Z");
        var share = new TodayFetchShare(TimeSpan.FromSeconds(60), () => now);
        var calls = 0;
        Task<int[]> Fetch(CancellationToken _) { calls++; return Task.FromResult(new[] { calls }); }

        Assert.Equal(1, (await share.ReuseAsync("opt|1|CE", Today, Today, Fetch, r => r.Length > 0, default))[0]);
        now = now.AddSeconds(59);
        Assert.Equal(1, (await share.ReuseAsync("opt|1|CE", Today, Today, Fetch, r => r.Length > 0, default))[0]);
        Assert.Equal(1, calls);
        // Another series is its own ask.
        await share.ReuseAsync("opt|1|PE", Today, Today, Fetch, r => r.Length > 0, default);
        Assert.Equal(2, calls);
        now = now.AddSeconds(2); // past the window
        Assert.Equal(3, (await share.ReuseAsync("opt|1|CE", Today, Today, Fetch, r => r.Length > 0, default))[0]);
    }

    [Fact]
    public async Task An_empty_answer_and_other_days_are_not_reused()
    {
        var share = new TodayFetchShare();
        var calls = 0;
        Task<int[]> Empty(CancellationToken _) { calls++; return Task.FromResult(Array.Empty<int>()); }
        await share.ReuseAsync("spot|1", Today, Today, Empty, r => r.Length > 0, default);
        await share.ReuseAsync("spot|1", Today, Today, Empty, r => r.Length > 0, default);
        Assert.Equal(2, calls);
        var past = 0;
        Task<int[]> Past(CancellationToken _) { past++; return Task.FromResult(new[] { 1 }); }
        await share.ReuseAsync("spot|1", Today.AddDays(-1), Today, Past, r => r.Length > 0, default);
        await share.ReuseAsync("spot|1", Today.AddDays(-1), Today, Past, r => r.Length > 0, default);
        Assert.Equal(2, past);
    }

    [Fact]
    public async Task Requests_arriving_together_share_one_fetch()
    {
        var share = new TodayFetchShare();
        var calls = 0;
        var gate = new TaskCompletionSource<int[]>();
        Task<int[]> Slow(CancellationToken _) { Interlocked.Increment(ref calls); return gate.Task; }
        var a = share.ReuseAsync("fut|NIFTY", Today, Today, Slow, r => r.Length > 0, default);
        var b = share.ReuseAsync("fut|NIFTY", Today, Today, Slow, r => r.Length > 0, default);
        gate.SetResult(new[] { 7 });
        Assert.Equal(7, (await a)[0]);
        Assert.Equal(7, (await b)[0]);
        Assert.Equal(1, calls);
    }
}

public class TodayFetchShareDayTests
{
    private static readonly DateOnly Today = new(2026, 10, 19);

    [Fact]
    public async Task A_backfill_kept_for_the_day_is_asked_once_until_refreshed()
    {
        var now = DateTimeOffset.Parse("2026-10-19T04:00:00Z");
        var share = new TodayFetchShare(clock: () => now);
        var calls = 0;
        Task<int[]> Fetch(CancellationToken _) { calls++; return Task.FromResult(new[] { calls }); }
        var (first, at) = await share.ReuseWithTimeAsync("NIFTY|opt|WEEK|ATM|CALL", Today, Today, Fetch, r => r.Length > 0, default, TimeSpan.MaxValue);
        Assert.Equal(now, at);
        now = now.AddHours(5);
        var (again, at2) = await share.ReuseWithTimeAsync("NIFTY|opt|WEEK|ATM|CALL", Today, Today, Fetch, r => r.Length > 0, default, TimeSpan.MaxValue);
        Assert.Equal((1, 1, at), (first[0], again[0], at2));
        share.Invalidate("SENSEX|");
        await share.ReuseWithTimeAsync("NIFTY|opt|WEEK|ATM|CALL", Today, Today, Fetch, r => r.Length > 0, default, TimeSpan.MaxValue);
        Assert.Equal(1, calls);
        share.Invalidate("NIFTY|");
        await share.ReuseWithTimeAsync("NIFTY|opt|WEEK|ATM|CALL", Today, Today, Fetch, r => r.Length > 0, default, TimeSpan.MaxValue);
        Assert.Equal(2, calls);
    }
}

public class TodayWarmupWindowTests
{
    [Theory]
    [InlineData("2026-10-19T09:15:00+05:30", false)] // before the first minute has closed
    [InlineData("2026-10-19T09:16:00+05:30", true)]
    [InlineData("2026-10-19T13:00:00+05:30", true)]
    [InlineData("2026-10-19T15:35:00+05:30", true)]
    [InlineData("2026-10-19T15:40:00+05:30", false)]
    [InlineData("2026-10-18T11:00:00+05:30", false)] // Sunday
    public void Warms_only_on_a_weekday_in_market_hours(string at, bool expected) =>
        Assert.Equal(expected, TodayWarmupService.InWindow(DateTimeOffset.Parse(at)));

    [Fact]
    public void Warms_every_index_the_live_page_shows() =>
        Assert.Equal(new[] { "NIFTY", "BANKNIFTY", "SENSEX" }, TodayWarmupService.Chains.Select(c => c.Underlying));
}

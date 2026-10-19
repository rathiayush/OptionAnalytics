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

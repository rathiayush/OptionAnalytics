using System.Diagnostics;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;
using Xunit;

namespace OptionAnalytics.Server.Tests;

public class DhanRateLimiterTests
{
    private static DhanDataApiRateLimiter Limiter() =>
        new(Options.Create(new DhanOptions { DataApiRequestsPerSecond = 5 }), NullLogger<DhanDataApiRateLimiter>.Instance);

    [Fact]
    public async Task A_page_load_uses_all_five_permits_a_second_when_nothing_else_runs()
    {
        using var limiter = Limiter();
        var clock = Stopwatch.StartNew();
        await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => limiter.WaitForPermitAsync(true, CancellationToken.None)));
        Assert.True(clock.Elapsed < TimeSpan.FromMilliseconds(800), $"5 interactive permits took {clock.Elapsed.TotalMilliseconds:0} ms");
    }

    [Fact]
    public async Task Never_more_than_five_a_second_in_all()
    {
        using var limiter = Limiter();
        var clock = Stopwatch.StartNew();
        var times = new System.Collections.Concurrent.ConcurrentBag<TimeSpan>();
        var calls = Enumerable.Range(0, 12).Select(async i =>
        {
            await limiter.WaitForPermitAsync(i % 3 != 0, CancellationToken.None);
            times.Add(clock.Elapsed);
        });
        await Task.WhenAll(calls);
        var sorted = times.OrderBy(t => t).ToList();
        // Any 6 consecutive permits span at least (almost) a second.
        for (var i = 5; i < sorted.Count; i++)
            Assert.True(sorted[i] - sorted[i - 5] >= TimeSpan.FromMilliseconds(900), $"6 permits within {(sorted[i] - sorted[i - 5]).TotalMilliseconds:0} ms");
    }

    [Fact]
    public async Task Background_work_leaves_a_permit_free_for_a_page()
    {
        using var limiter = Limiter();
        // Background asks for many: it is held to its own lane (one a second - two can land either side of the lane's refill).
        var clock = Stopwatch.StartNew();
        var background = Enumerable.Range(0, 4).Select(_ => limiter.WaitForPermitAsync(false, CancellationToken.None)).ToList();
        await Task.Delay(150);
        Assert.True(background.Count(t => t.IsCompleted) <= 2, "background is held to its own lane");
        // A page load arriving now is served at once.
        var page = Stopwatch.StartNew();
        await limiter.WaitForPermitAsync(true, CancellationToken.None);
        Assert.True(page.Elapsed < TimeSpan.FromMilliseconds(600), $"page waited {page.Elapsed.TotalMilliseconds:0} ms");
    }
}

using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Tests;

/// <summary>What counts as Dhan's rate limit (retried after a wait), the wait, and the background-priority scope a
/// request opens with "X-Request-Priority: background" (the strategy tuning job in market hours).</summary>
public sealed class DhanRateLimitTests
{
    [Theory]
    [InlineData(429, null, true)]
    [InlineData(429, "", true)]
    [InlineData(400, "DH-904: Too many requests", true)]
    [InlineData(400, "Rate limit exceeded", true)]
    [InlineData(500, "too many requests, slow down", true)]
    [InlineData(400, "805: Too many requests or connections. Further requests may result in the user being blocked.", true)]
    [InlineData(400, "{\"errorCode\":\"805\"}", true)]
    [InlineData(400, "DH-905: Missing required fields", false)]
    [InlineData(400, "Invalid SecurityId 8050", false)]
    [InlineData(400, "No data present", false)]
    [InlineData(401, "Invalid token", false)]
    public void IsRateLimited_StatusOrDhansOwnWords(int status, string? message, bool expected) =>
        Assert.Equal(expected, DhanDataApiRateLimiter.IsRateLimited(status, message));

    [Fact]
    public void Backoff_IsShort_HalfASecondToTwo_AndAWaitingPageRetriesLess()
    {
        // Dhan's limit is per second: half a second already clears most of the window. A page load (or the live scanner)
        // waits ~1.5 s in all before it gives up; background work, which nobody is waiting on, ~3.5 s.
        Assert.Equal(new[] { 500, 1_000, 2_000 }, new[] { 0, 1, 2 }.Select(i => (int)DhanDataApiRateLimiter.RateLimitBackoff(i).TotalMilliseconds));
        Assert.Equal(2, DhanDataApiRateLimiter.RateLimitRetries);
        using (DhanDataApiRateLimiter.BackgroundScope()) Assert.Equal(3, DhanDataApiRateLimiter.RateLimitRetries);
        var waited = new[] { 0, 1 }.Sum(i => DhanDataApiRateLimiter.RateLimitBackoff(i).TotalMilliseconds);
        Assert.True(waited <= 1_500, $"a waiting page would be held up {waited} ms");
    }

    private static DhanDataApiRateLimiter Limiter() => new(Microsoft.Extensions.Options.Options.Create(new DhanOptions { DataApiRequestsPerSecond = 5, DataApiRequestsPerDay = 100_000 }),
        Microsoft.Extensions.Logging.Abstractions.NullLogger<DhanDataApiRateLimiter>.Instance);

    [Fact]
    public async Task Background_UsesTheWholeAllowedRate_WhileTheLiveAppIsIdle()
    {
        using var limiter = Limiter();
        Assert.True(limiter.InteractiveIdle, "nothing interactive has asked yet");
        var watch = System.Diagnostics.Stopwatch.StartNew();
        // Dhan allows 5 a second: with the app idle a long job uses all five inside the first second.
        await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => limiter.WaitForPermitAsync(interactive: false, CancellationToken.None)));
        Assert.True(watch.ElapsedMilliseconds < 900, $"5 background calls took {watch.ElapsedMilliseconds} ms - not the full 5/s");
        // Never more than 5 a second, though.
        await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => limiter.WaitForPermitAsync(interactive: false, CancellationToken.None)));
        Assert.True(watch.ElapsedMilliseconds >= 700, $"10 calls in {watch.ElapsedMilliseconds} ms - over 5/s");
    }

    [Fact]
    public async Task Background_UsesThePermitsTheLiveAppIsNotUsing_ButNeverTheLastOne()
    {
        using var limiter = Limiter();
        // The live app has just asked for something: the reservation is in force.
        await limiter.WaitForPermitAsync(interactive: true, CancellationToken.None);
        Assert.False(limiter.InteractiveIdle);
        var watch = System.Diagnostics.Stopwatch.StartNew();
        // Background work takes the spare permits but leaves the last one, so a page load arriving right after is served
        // at once instead of waiting out the window behind a long job.
        await Task.WhenAll(Enumerable.Range(0, 3).Select(_ => limiter.WaitForPermitAsync(interactive: false, CancellationToken.None)));
        var page = System.Diagnostics.Stopwatch.StartNew();
        await limiter.WaitForPermitAsync(interactive: true, CancellationToken.None);
        Assert.True(page.ElapsedMilliseconds < 250, $"the page waited {page.ElapsedMilliseconds} ms behind background work");
        // Never over 5 a second in all.
        await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => limiter.WaitForPermitAsync(interactive: false, CancellationToken.None)));
        Assert.True(watch.ElapsedMilliseconds >= 700, $"10 calls in {watch.ElapsedMilliseconds} ms - over 5/s");
    }

    [Fact]
    public async Task EveryPermit_IsCountedAgainstDhansDailyLimit()
    {
        using var limiter = Limiter();
        Assert.Equal((0L, 100_000), (limiter.Usage().Calls, limiter.Usage().DailyLimit));
        await limiter.WaitForPermitAsync(interactive: true, CancellationToken.None);
        using (DhanDataApiRateLimiter.BackgroundScope()) await limiter.WaitForPermitAsync(interactive: true, CancellationToken.None);
        await limiter.WaitForPermitAsync(interactive: false, CancellationToken.None);
        Assert.Equal(3L, limiter.Usage().Calls);
    }

    [Fact]
    public async Task BackgroundCalls_AreCountedSeparately_SoALongJobCanSayHowManyItCaused()
    {
        // A tuning job's every request asks for background priority, so the background counter read
        // before and after it is how many Dhan calls the job itself caused - the plain total is
        // account-wide and moves with whatever the live app is doing at the same time.
        using var limiter = Limiter();
        Assert.Equal((0L, 0L), (limiter.Usage().Calls, limiter.Usage().BackgroundCalls));

        await limiter.WaitForPermitAsync(interactive: true, CancellationToken.None);     // a page load
        await limiter.WaitForPermitAsync(interactive: false, CancellationToken.None);    // a hosted service
        using (DhanDataApiRateLimiter.BackgroundScope())                                 // a request that asked for background
            await limiter.WaitForPermitAsync(interactive: true, CancellationToken.None);

        Assert.Equal(3L, limiter.Usage().Calls);
        Assert.Equal(2L, limiter.Usage().BackgroundCalls);
    }

    [Fact]
    public async Task BackgroundScope_FlowsIntoTheRequestsOwnTasks_AndEndsWithIt()
    {
        Assert.False(DhanDataApiRateLimiter.IsBackgroundRequest);
        using (DhanDataApiRateLimiter.BackgroundScope())
        {
            Assert.True(DhanDataApiRateLimiter.IsBackgroundRequest);
            // The concurrent strike fetches a request starts see it too.
            var seen = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => Task.Run(() => DhanDataApiRateLimiter.IsBackgroundRequest)));
            Assert.All(seen, Assert.True);
        }
        Assert.False(DhanDataApiRateLimiter.IsBackgroundRequest);
        // Another request running alongside is not affected.
        var other = await Task.Run(() => DhanDataApiRateLimiter.IsBackgroundRequest);
        Assert.False(other);
    }
}

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
    public void Backoff_IsShort_1_2_4_Seconds_DhansLimitIsPerSecond()
    {
        Assert.Equal(new[] { 1, 2, 4 }, new[] { 0, 1, 2 }.Select(i => (int)DhanDataApiRateLimiter.RateLimitBackoff(i).TotalSeconds));
    }

    private static DhanDataApiRateLimiter Limiter() => new(Microsoft.Extensions.Options.Options.Create(new DhanOptions { DataApiRequestsPerSecond = 5, DataApiRequestsPerDay = 100_000 }),
        Microsoft.Extensions.Logging.Abstractions.NullLogger<DhanDataApiRateLimiter>.Instance);

    [Fact]
    public async Task Background_UsesThePermitsTheLiveAppIsNotUsing_UpToTheFull5PerSecond()
    {
        using var limiter = Limiter();
        var watch = System.Diagnostics.Stopwatch.StartNew();
        // Five background calls while nothing interactive runs: the interactive lane's 4 spare + the background's own 1,
        // all inside the first second (at the old fixed 1/s share they took 4+ s).
        await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => limiter.WaitForPermitAsync(interactive: false, CancellationToken.None)));
        Assert.True(watch.ElapsedMilliseconds < 900, $"took {watch.ElapsedMilliseconds} ms");
        // Never more than 5 a second in all: the next five wait for the window to move on.
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

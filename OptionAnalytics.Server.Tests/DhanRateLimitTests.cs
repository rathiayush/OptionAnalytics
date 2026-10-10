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
    [InlineData(400, "DH-905: Missing required fields", false)]
    [InlineData(400, "No data present", false)]
    [InlineData(401, "Invalid token", false)]
    public void IsRateLimited_StatusOrDhansOwnWords(int status, string? message, bool expected) =>
        Assert.Equal(expected, DhanDataApiRateLimiter.IsRateLimited(status, message));

    [Fact]
    public void Backoff_Grows_2_4_8_Seconds()
    {
        Assert.Equal(new[] { 2, 4, 8 }, new[] { 0, 1, 2 }.Select(i => (int)DhanDataApiRateLimiter.RateLimitBackoff(i).TotalSeconds));
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

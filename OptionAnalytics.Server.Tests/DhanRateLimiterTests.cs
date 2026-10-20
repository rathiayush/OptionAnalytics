using System.Diagnostics;
using System.Net;
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
    public void Calls_are_given_evenly_spaced_slots_never_six_within_a_second()
    {
        var now = new DateTimeOffset(2026, 10, 19, 4, 0, 0, TimeSpan.Zero);
        using var limiter = new DhanDataApiRateLimiter(Options.Create(new DhanOptions { DataApiRequestsPerSecond = 5 }), NullLogger<DhanDataApiRateLimiter>.Instance, () => now);
        // Twelve calls all asking at the same instant: one slot every 220 ms (5/s with a 10% margin).
        var slots = Enumerable.Range(0, 12).Select(i => limiter.Reserve(background: i % 4 == 0)).ToList();
        Assert.Equal(Enumerable.Range(0, 12).Select(i => TimeSpan.FromMilliseconds(220 * i)), slots);
        for (var i = 5; i < slots.Count; i++) Assert.True(slots[i] - slots[i - 5] > TimeSpan.FromSeconds(1));
        // "Too many requests": the next slot is after the pause, not straight after the last one.
        limiter.NoteRateLimited();
        Assert.True(limiter.Reserve(background: false) >= DhanDataApiRateLimiter.RateLimitPause);
    }

    [Fact]
    public async Task A_page_load_is_not_held_behind_background_work()
    {
        using var limiter = Limiter();
        var background = Enumerable.Range(0, 6).Select(_ => limiter.WaitForPermitAsync(false, CancellationToken.None)).ToList();
        await Task.Delay(50);
        // Background has taken at most its own one slot; a page load now waits at most a slot or two, not behind the rest.
        var page = Stopwatch.StartNew();
        await limiter.WaitForPermitAsync(true, CancellationToken.None);
        Assert.True(page.Elapsed < TimeSpan.FromMilliseconds(700), $"page waited {page.Elapsed.TotalMilliseconds:0} ms");
        Assert.True(background.Count(t => t.IsCompleted) <= 2);
    }

    [Fact]
    public async Task After_too_many_requests_every_call_waits_out_the_pause()
    {
        using var limiter = Limiter();
        await limiter.WaitForPermitAsync(true, CancellationToken.None);
        limiter.NoteRateLimited();
        var clock = Stopwatch.StartNew();
        await limiter.WaitForPermitAsync(true, CancellationToken.None);
        Assert.True(clock.Elapsed >= DhanDataApiRateLimiter.RateLimitPause - TimeSpan.FromMilliseconds(50));
    }

    [Theory]
    [InlineData(429, null, true)]
    [InlineData(400, "Data_Error: Too many requests on server from single user breaching rate limits. Try throttling API calls.", true)]
    [InlineData(400, "DH-904", true)]
    [InlineData(400, "805: Too many requests or connections. Further requests may result in the user being blocked.", true)]
    [InlineData(400, "Data_Error: Invalid SecurityId", false)]
    [InlineData(200, "No data for 18085", false)]
    public void Dhan_s_rate_limit_answers_are_recognised(int status, string? message, bool limited) =>
        Assert.Equal(limited, DhanDataApiRateLimiter.IsRateLimited((HttpStatusCode)status, message));
}

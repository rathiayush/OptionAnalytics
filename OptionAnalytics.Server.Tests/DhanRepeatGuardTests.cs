using System.Net;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Controllers;
using OptionAnalytics.Server.Dhan;
using Xunit;

namespace OptionAnalytics.Server.Tests;

/// <summary>Dhan support: "requests running in a loop ... hitting the rate limit". A data request that FAILED is not sent
/// again, identically, until its back-off (1 min, doubling to 30) has passed - every timer and page asking for it gets the
/// failure at once; a success clears it. The call log shows what reached Dhan.</summary>
public class DhanRepeatGuardTests
{
    private static readonly IOptions<DhanOptions> Options =
        Microsoft.Extensions.Options.Options.Create(new DhanOptions { RestBaseUrl = "https://dhan.test", AccessToken = "t", ClientId = "c", DataApiRequestsPerSecond = 200 });

    private sealed class Dhan(Func<int, HttpStatusCode> status) : HttpMessageHandler
    {
        // Calls to the endpoint under test - not the profile read a failed data call adds.
        public int Calls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.RequestUri!.AbsolutePath.EndsWith("/profile"))
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.BadRequest) { Content = new StringContent("{}", Encoding.UTF8, "application/json") });
            var n = Interlocked.Increment(ref Calls);
            var code = status(n);
            var body = code == HttpStatusCode.OK ? "{\"open\":[],\"close\":[],\"timestamp\":[]}" : "{\"errorCode\":\"DH-905\",\"errorMessage\":\"Input_Exception: Missing required fields\"}";
            return Task.FromResult(new HttpResponseMessage(code) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }
    }

    private static (DhanApiClient Api, DhanRestRateLimiter Limiter, Func<DateTimeOffset> Set) Client(Dhan dhan, Func<DateTimeOffset> clock)
    {
        var limiter = new DhanRestRateLimiter(new DhanDataApiRateLimiter(Options, NullLogger<DhanDataApiRateLimiter>.Instance)) { Clock = clock };
        return (new DhanApiClient(new HttpClient(dhan), Options, new DhanSession(Options), NullLogger<DhanApiClient>.Instance, limiter), limiter, clock);
    }

    // The volume refresh's request: today's candles, toDate moving with the clock.
    private static object Today(int minute) => new { securityId = "13", exchangeSegment = "IDX_I", fromDate = "2026-10-23 09:15:00", toDate = $"2026-10-23 11:{minute:00}:00" };

    [Fact]
    public async Task A_failed_data_request_is_held_back_and_its_wait_doubles()
    {
        var now = new DateTimeOffset(2026, 10, 23, 5, 30, 0, TimeSpan.Zero);
        var dhan = new Dhan(_ => HttpStatusCode.BadRequest);
        var (api, limiter, _) = Client(dhan, () => now);

        using (var first = await api.SendAsync(HttpMethod.Post, "/charts/intraday", Today(0), "spot", CancellationToken.None)) Assert.False(first.Success);
        Assert.Equal(1, dhan.Calls);

        // Asked again by every timer within the minute - the same request (toDate moved on): not sent.
        for (var i = 1; i <= 5; i++)
        {
            now = now.AddSeconds(10);
            using var again = await api.SendAsync(HttpMethod.Post, "/charts/intraday", Today(i), "spot", CancellationToken.None);
            Assert.False(again.Success);
            Assert.Contains("Input_Exception", again.ErrorMessage);
            Assert.Contains("not asked again before", again.ErrorMessage);
        }
        Assert.Equal(1, dhan.Calls);
        Assert.Equal(5, limiter.HeldBackCount);

        // After the minute it is asked once more; it fails again - now held back two minutes.
        now = now.AddSeconds(15);
        using (var second = await api.SendAsync(HttpMethod.Post, "/charts/intraday", Today(7), "spot", CancellationToken.None)) Assert.False(second.Success);
        Assert.Equal(2, dhan.Calls);
        now = now.AddSeconds(90);
        using (var held = await api.SendAsync(HttpMethod.Post, "/charts/intraday", Today(9), "spot", CancellationToken.None)) Assert.False(held.Success);
        Assert.Equal(2, dhan.Calls);
        now = now.AddSeconds(40);
        using (var third = await api.SendAsync(HttpMethod.Post, "/charts/intraday", Today(10), "spot", CancellationToken.None)) Assert.False(third.Success);
        Assert.Equal(3, dhan.Calls);

        // A different request (another instrument) is not held back by it.
        using (var other = await api.SendAsync(HttpMethod.Post, "/charts/intraday", new { securityId = "25", exchangeSegment = "IDX_I" }, "bank", CancellationToken.None)) Assert.False(other.Success);
        Assert.Equal(4, dhan.Calls);
    }

    [Fact]
    public async Task A_success_clears_it_and_orders_are_never_held_back()
    {
        var now = new DateTimeOffset(2026, 10, 23, 5, 30, 0, TimeSpan.Zero);
        var dhan = new Dhan(n => n == 1 ? HttpStatusCode.BadRequest : HttpStatusCode.OK);
        var (api, _, _) = Client(dhan, () => now);
        using (var failed = await api.SendAsync(HttpMethod.Post, "/charts/intraday", Today(0), "spot", CancellationToken.None)) Assert.False(failed.Success);
        now = now.AddMinutes(2);
        using (var ok = await api.SendAsync(HttpMethod.Post, "/charts/intraday", Today(2), "spot", CancellationToken.None)) Assert.True(ok.Success);
        using (var again = await api.SendAsync(HttpMethod.Post, "/charts/intraday", Today(2), "spot", CancellationToken.None)) Assert.True(again.Success);
        Assert.Equal(3, dhan.Calls);

        // An order the user sends again is always sent - never answered from a remembered failure.
        var orderDhan = new Dhan(_ => HttpStatusCode.BadRequest);
        var (orders, _, _) = Client(orderDhan, () => now);
        for (var i = 0; i < 3; i++)
            using (var order = await orders.SendAsync(HttpMethod.Post, "/orders", new { securityId = "1" }, "order", CancellationToken.None)) Assert.False(order.Success);
        Assert.Equal(3, orderDhan.Calls);
    }

    [Fact]
    public void The_call_report_shows_a_request_asked_again_and_again()
    {
        var now = DateTimeOffset.UtcNow;
        var calls = Enumerable.Range(0, 6).Select(i => new DhanRestRateLimiter.DhanCall(now.AddSeconds(-30 * i), DhanApiCategory.Data, "POST", "/charts/intraday", "spot candles (IDX_I:13)", false, "DH-905"))
            .Append(new DhanRestRateLimiter.DhanCall(now, DhanApiCategory.NonTrading, "GET", "/positions", "listing positions", true, null))
            .OrderBy(c => c.At).ToList();
        var report = SystemController.DhanCallsReportOf(calls, heldBack: 4, now);
        Assert.Equal(7, report.Last15Minutes);
        Assert.Equal(4, report.HeldBack);
        Assert.Equal("/charts/intraday", report.Endpoints[0].Path);
        Assert.Equal(6, report.Endpoints[0].Failed);
        var loop = Assert.Single(report.Repeated);
        Assert.Equal(("spot candles (IDX_I:13)", 6, "DH-905"), (loop.Context, loop.Times, loop.LastError));
    }
}

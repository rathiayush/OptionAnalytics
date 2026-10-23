using System.Net;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Controllers;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services;
using Xunit;

namespace OptionAnalytics.Server.Tests;

/// <summary>Dhan support: "requests running in a loop ... hitting the rate limit". Failures are NOT cached - every call
/// goes to Dhan - but a background timer whose call failed slows down (RetryBackoff / KeyedBackoff) instead of asking again
/// at its normal pace. The call log shows what reached Dhan.</summary>
public class DhanRepeatGuardTests
{
    private static readonly IOptions<DhanOptions> Options =
        Microsoft.Extensions.Options.Options.Create(new DhanOptions { RestBaseUrl = "https://dhan.test", AccessToken = "t", ClientId = "c", DataApiRequestsPerSecond = 200 });

    private sealed class FailingDhan : HttpMessageHandler
    {
        public int ChartCalls, ProfileCalls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.RequestUri!.AbsolutePath.EndsWith("/profile")) Interlocked.Increment(ref ProfileCalls);
            else Interlocked.Increment(ref ChartCalls);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.BadRequest)
            {
                Content = new StringContent("{\"errorCode\":\"DH-905\",\"errorMessage\":\"Input_Exception: Missing required fields\"}", Encoding.UTF8, "application/json"),
            });
        }
    }

    [Fact]
    public async Task A_failed_request_is_not_cached_but_the_profile_is_not_read_on_every_failure()
    {
        var dhan = new FailingDhan();
        var api = new DhanApiClient(new HttpClient(dhan), Options, new DhanSession(Options), NullLogger<DhanApiClient>.Instance);
        for (var i = 0; i < 4; i++)
            using (var failed = await api.SendAsync(HttpMethod.Post, "/charts/intraday", new { securityId = "13" }, "spot", CancellationToken.None))
            {
                Assert.False(failed.Success);
                Assert.Contains("Input_Exception", failed.ErrorMessage);
            }
        Assert.Equal(4, dhan.ChartCalls); // every call went to Dhan - no remembered failure
        Assert.Equal(1, dhan.ProfileCalls); // the profile is asked once per 10 minutes, not once per failure
        Assert.Equal(5, api.RateLimiter.RecentCalls().Count);
    }

    [Fact]
    public void A_failing_timer_slows_down_doubling_to_its_cap()
    {
        var first = TimeSpan.FromSeconds(30);
        var cap = TimeSpan.FromMinutes(30);
        Assert.Equal(TimeSpan.Zero, RetryBackoff.After(0, first, cap));
        Assert.Equal(new[] { 30, 60, 120, 240, 480, 960, 1800, 1800 }.Select(s => TimeSpan.FromSeconds(s)),
            Enumerable.Range(1, 8).Select(n => RetryBackoff.After(n, first, cap)));
        Assert.Equal(cap, RetryBackoff.After(500, first, cap));
    }

    [Fact]
    public void Each_index_backs_off_on_its_own_and_a_success_resets_it()
    {
        var now = new DateTimeOffset(2026, 10, 23, 5, 0, 0, TimeSpan.Zero);
        var backoff = new KeyedBackoff(TimeSpan.FromMinutes(10), TimeSpan.FromHours(1), () => now);
        Assert.True(backoff.Due("NIFTY"));
        Assert.Equal(TimeSpan.FromMinutes(10), backoff.Failed("NIFTY"));
        Assert.False(backoff.Due("NIFTY"));
        Assert.True(backoff.Due("BANKNIFTY")); // another index is not held by NIFTY's failure
        now = now.AddMinutes(10);
        Assert.True(backoff.Due("NIFTY"));
        Assert.Equal(TimeSpan.FromMinutes(20), backoff.Failed("NIFTY"));
        now = now.AddMinutes(19);
        Assert.False(backoff.Due("NIFTY"));
        now = now.AddMinutes(1);
        backoff.Succeeded("NIFTY");
        Assert.True(backoff.Due("NIFTY"));
        Assert.Equal(TimeSpan.FromMinutes(10), backoff.Failed("NIFTY")); // a success starts it over
    }

    [Fact]
    public void The_call_report_shows_a_request_asked_again_and_again()
    {
        var now = DateTimeOffset.UtcNow;
        var calls = Enumerable.Range(0, 6).Select(i => new DhanRestRateLimiter.DhanCall(now.AddSeconds(-30 * i), DhanApiCategory.Data, "POST", "/charts/intraday", "spot candles (IDX_I:13)", false, "DH-905"))
            .Append(new DhanRestRateLimiter.DhanCall(now, DhanApiCategory.NonTrading, "GET", "/positions", "listing positions", true, null))
            .OrderBy(c => c.At).ToList();
        var report = SystemController.DhanCallsReportOf(calls, now);
        Assert.Equal((7, 7), (report.Last15Minutes, report.LastHour));
        Assert.Equal("/charts/intraday", report.Endpoints[0].Path);
        Assert.Equal(6, report.Endpoints[0].Failed);
        var loop = Assert.Single(report.Repeated);
        Assert.Equal(("spot candles (IDX_I:13)", 6, "DH-905"), (loop.Context, loop.Times, loop.LastError));
    }

    [Fact]
    public async Task The_call_log_keeps_the_body_as_sent_with_the_client_id_masked()
    {
        var dhan = new FailingDhan();
        var api = new DhanApiClient(new HttpClient(dhan), Options, new DhanSession(Options), NullLogger<DhanApiClient>.Instance);
        using (await api.SendAsync(HttpMethod.Post, "/charts/rollingoption", new { securityId = "13", strike = "ATM+7", fromDate = "2026-10-23", toDate = "2026-10-24" }, "CE ATM+7", CancellationToken.None)) { }
        using (await api.SendAsync(HttpMethod.Post, "/orders", new { securityId = "1" }, "order", CancellationToken.None)) { }
        var calls = api.RateLimiter.RecentCalls();
        var rolling = calls.First(c => c.Path == "/charts/rollingoption");
        Assert.Equal((400, false), (rolling.Status, rolling.Success));
        Assert.Contains("\"fromDate\":\"2026-10-23\"", rolling.Body);
        // Dhan's answer exactly as it came, and its error code read from it.
        Assert.Contains("\"errorCode\":\"DH-905\"", rolling.Response);
        var entry = SystemController.DhanCallsReportOf(calls, DateTimeOffset.UtcNow).Recent.First(e => e.Path == "/charts/rollingoption");
        Assert.Equal(("DH-905", false), (entry.ErrorCode, entry.Success));
        Assert.Contains("Input_Exception", entry.Response);
        Assert.Contains("Input_Exception", rolling.Error);
        var order = calls.First(c => c.Path == "/orders");
        Assert.Contains("\"dhanClientId\":\"***\"", order.Body); // the account id is not shown
    }

    [Theory]
    [InlineData("{\"toDate\":\"2026-10-24\",\"fromDate\":\"2026-10-23\"}", "is in the future")]
    [InlineData("{\"toDate\":\"2026-10-23 16:00:00\",\"fromDate\":\"2026-10-23 09:15:00\"}", "is in the future")]
    [InlineData("{\"toDate\":\"2026-10-18\",\"fromDate\":\"2026-10-17\"}", "is a weekend")]
    [InlineData("{\"toDate\":\"2026-10-23\",\"fromDate\":\"2026-10-22\"}", "nothing in the payload stands out")]
    public void A_DH905_failure_is_explained_from_its_body(string body, string expected)
    {
        var now = new DateTimeOffset(2026, 10, 23, 15, 0, 0, TimeSpan.FromHours(5.5)); // Friday 15:00 IST
        var call = new DhanRestRateLimiter.DhanCall(now, DhanApiCategory.Data, "POST", "/charts/rollingoption", "CE ATM", false,
            "Input_Exception: Missing required fields, bad values for parameters etc.", 400, body);
        Assert.Contains(expected, SystemController.Diagnose(call, now));
    }
}


using System.Net;
using System.Security.Claims;
using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>After the close nothing in the background calls Dhan (MarketHours): the window is IST weekdays 09:00 - 16:00,
/// and a background Dhan REST call outside it - positions, orders, candles, anything - is not sent. A page's own request
/// still goes.</summary>
public sealed class MarketHoursTests
{
    private static DateTimeOffset Ist(int day, int hour, int minute) => new(2026, 10, day, hour, minute, 0, IstClock.Offset);

    [Theory]
    [InlineData(23, 8, 59, false)]  // Friday, before 09:00
    [InlineData(23, 9, 0, true)]
    [InlineData(23, 12, 0, true)]
    [InlineData(23, 15, 59, true)]
    [InlineData(23, 16, 0, false)]  // 4 PM: stopped
    [InlineData(23, 21, 30, false)]
    [InlineData(24, 11, 0, false)]  // Saturday
    [InlineData(25, 11, 0, false)]  // Sunday
    [InlineData(26, 9, 30, true)]   // Monday
    public void The_window_is_IST_weekdays_9_to_4(int day, int hour, int minute, bool open) =>
        Assert.Equal(open, MarketHours.IsOpen(Ist(day, hour, minute)));

    [Fact]
    public void After_the_close_it_waits_for_the_next_weekday_open()
    {
        Assert.Equal(TimeSpan.Zero, MarketHours.UntilOpen(Ist(23, 10, 0)));
        Assert.Equal(TimeSpan.FromHours(1), MarketHours.UntilOpen(Ist(23, 8, 0)));
        // Friday 16:00 -> Monday 09:00.
        Assert.Equal(Ist(26, 9, 0), Ist(23, 16, 0) + MarketHours.UntilOpen(Ist(23, 16, 0)));
        Assert.Equal(Ist(26, 9, 0), Ist(24, 11, 0) + MarketHours.UntilOpen(Ist(24, 11, 0)));
    }

    [Fact]
    public void Only_background_work_is_held_to_the_window()
    {
        Assert.Null(MarketHours.BlockReason(Ist(23, 18, 0)));   // a page's request
        using (MarketHours.BackgroundScope())
        {
            Assert.NotNull(MarketHours.BlockReason(Ist(23, 18, 0)));
            Assert.Null(MarketHours.BlockReason(Ist(23, 11, 0)));
        }
        Assert.False(MarketHours.InBackground);
    }

    [Fact]
    public async Task The_background_scope_flows_into_the_work_it_starts()
    {
        Task<bool> started;
        using (MarketHours.BackgroundScope()) started = Task.Run(async () => { await Task.Yield(); return MarketHours.InBackground; });
        Assert.True(await started);
        Assert.False(await Task.Run(() => MarketHours.InBackground));
    }

    [Theory]
    [InlineData("GET", "/positions")]
    [InlineData("GET", "/orders")]
    [InlineData("GET", "/super/orders")]
    [InlineData("POST", "/charts/intraday")]
    [InlineData("POST", "/optionchain")]
    [InlineData("POST", "/orders")]
    public async Task After_4_PM_a_background_Dhan_call_is_not_sent(string method, string path)
    {
        var dhan = new CountingDhan();
        var api = Client(dhan, Ist(23, 16, 5));

        DhanApiResponse response;
        using (MarketHours.BackgroundScope())
            response = await api.SendAsync(new HttpMethod(method), path, new { }, "test", CancellationToken.None);

        Assert.False(response.Success);
        Assert.Contains("market hours", response.ErrorMessage);
        Assert.Equal(0, dhan.Sent);
        Assert.DoesNotContain(api.RateLimiter.RecentCalls(), c => c.Path == path);
    }

    [Fact]
    public async Task In_market_hours_background_calls_go_and_a_page_call_goes_at_any_hour()
    {
        var dhan = new CountingDhan();
        using (MarketHours.BackgroundScope())
            Assert.True((await Client(dhan, Ist(23, 11, 0)).SendAsync(HttpMethod.Get, "/positions", null, "test", CancellationToken.None)).Success);
        Assert.True((await Client(dhan, Ist(23, 20, 0)).SendAsync(HttpMethod.Get, "/positions", null, "test", CancellationToken.None)).Success);
        Assert.Equal(2, dhan.Sent);
    }

    [Theory]
    [InlineData(null, false, false)]       // a page's own load or click
    [InlineData("1", false, true)]         // a page's timer refresh (X-Poll)
    [InlineData(null, true, true)]         // the server scanner
    public async Task A_timer_refresh_and_the_server_scanner_are_background_requests(string? poll, bool runner, bool background)
    {
        using var host = await new HostBuilder().ConfigureWebHost(web => web.UseTestServer().Configure(app =>
        {
            app.Use(async (context, next) =>
            {
                if (runner) context.User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim(ClaimTypes.Role, Auth.ScannerRunnerKey.Role) }, "test"));
                await next();
            });
            app.UseBackgroundRequests();
            app.Run(context => context.Response.WriteAsync(MarketHours.InBackground ? "background" : "page"));
        })).StartAsync();
        var request = new HttpRequestMessage(HttpMethod.Get, "/api/cdv/NIFTY/chain");
        if (poll is not null) request.Headers.Add(MarketHours.PollHeader, poll);

        var answer = await (await host.GetTestClient().SendAsync(request)).Content.ReadAsStringAsync();

        Assert.Equal(background ? "background" : "page", answer);
    }

    private static DhanApiClient Client(CountingDhan dhan, DateTimeOffset now)
    {
        var options = Options.Create(new DhanOptions { RestBaseUrl = "https://dhan.test", AccessToken = "t", ClientId = "c" });
        return new DhanApiClient(new HttpClient(dhan), options, new DhanSession(options), NullLogger<DhanApiClient>.Instance) { Clock = () => now };
    }

    private sealed class CountingDhan : HttpMessageHandler
    {
        private int _sent;
        public int Sent => _sent;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _sent);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("[]", Encoding.UTF8, "application/json") });
        }
    }
}

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

/// <summary>After the close nothing in the background POLLS Dhan (MarketHours): the window is IST weekdays 09:00 - 16:00,
/// and a background polling call outside it - positions, orders, the option chain (OI) - is not sent. Candle backfills
/// (/charts/...) and a page's own request still go.</summary>
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

    [Theory]
    [InlineData(23, 9, 14, false)]   // Friday, before the open
    [InlineData(23, 9, 15, true)]
    [InlineData(23, 15, 29, true)]   // the last minute
    [InlineData(23, 15, 30, false)]  // the close
    [InlineData(23, 15, 40, false)]
    [InlineData(24, 11, 0, false)]   // Saturday
    public void The_trading_session_the_charts_show_is_weekdays_9_15_to_15_30(int day, int hour, int minute, bool open) =>
        Assert.Equal(open, MarketHours.InTradingSession(Ist(day, hour, minute)));

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
        Assert.Null(MarketHours.BlockReason(Ist(23, 18, 0), "/positions"));   // a page's request
        using (MarketHours.BackgroundScope())
        {
            Assert.NotNull(MarketHours.BlockReason(Ist(23, 18, 0), "/positions"));
            Assert.Null(MarketHours.BlockReason(Ist(23, 11, 0), "/positions"));
            Assert.Null(MarketHours.BlockReason(Ist(23, 18, 0), "/charts/intraday"));   // a backfill
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
    [InlineData("POST", "/optionchain")]
    [InlineData("POST", "/marketfeed/quote")]
    [InlineData("POST", "/orders")]
    public async Task After_4_PM_background_polling_is_not_sent(string method, string path)
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

    [Theory]
    [InlineData("/charts/intraday")]
    [InlineData("/charts/historical")]
    [InlineData("/charts/rollingoption")]
    public async Task Candle_backfills_still_go_after_4_PM(string path)
    {
        var dhan = new CountingDhan();
        using (MarketHours.BackgroundScope())
            Assert.True((await Client(dhan, Ist(23, 21, 0)).SendAsync(HttpMethod.Post, path, new { }, "test", CancellationToken.None)).Success);
        Assert.Equal(1, dhan.Sent);
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

    // ---- Dhan:IntradayQuietHours (asked for - "charts intraday call should not go after 8 pm and should start at 8 am") ----

    [Theory]
    [InlineData(23, 19, 59, true)]   // Friday evening: still goes
    [InlineData(23, 20, 0, false)]   // 8 PM: stopped
    [InlineData(23, 23, 30, false)]
    [InlineData(24, 0, 0, false)]    // midnight
    [InlineData(24, 7, 59, false)]
    [InlineData(24, 8, 0, true)]     // 8 AM: goes again (a Saturday too - only the hours are held)
    [InlineData(26, 12, 0, true)]    // Monday noon
    public async Task Intraday_candles_are_not_asked_between_8_PM_and_8_AM_IST(int day, int hour, int minute, bool sent)
    {
        foreach (var background in new[] { false, true })
        {
            var dhan = new CountingDhan();
            var api = Client(dhan, Ist(day, hour, minute), "20:00-08:00");

            DhanApiResponse response;
            using (background ? MarketHours.BackgroundScope() : null)
                response = await api.SendAsync(HttpMethod.Post, "/charts/intraday", new { }, "test", CancellationToken.None);

            Assert.Equal(sent, response.Success);
            Assert.Equal(sent ? 1 : 0, dhan.Sent);
            if (!sent)
            {
                Assert.True(MarketHours.IsIntradayQuiet(response.ErrorMessage), response.ErrorMessage);
                Assert.Contains("20:00 and 08:00 IST", response.ErrorMessage);
                Assert.DoesNotContain(api.RateLimiter.RecentCalls(), c => c.Path == "/charts/intraday");
            }
        }
    }

    [Theory]
    [InlineData("/charts/rollingoption")]
    [InlineData("/charts/historical")]
    [InlineData("/positions")]
    public async Task Only_the_intraday_candles_are_held_at_night(string path)
    {
        var dhan = new CountingDhan();
        Assert.True((await Client(dhan, Ist(23, 21, 0), "20:00-08:00").SendAsync(HttpMethod.Post, path, new { }, "test", CancellationToken.None)).Success);
        Assert.Equal(1, dhan.Sent);
    }

    [Fact]
    public async Task A_past_day_asked_at_night_is_not_kept_and_is_asked_of_Dhan_from_8_AM()
    {
        var dir = Path.Combine(Path.GetTempPath(), $"oa-quiet-{Guid.NewGuid():N}");
        try
        {
            var cache = new DhanDataCache(dir, NullLogger<DhanDataCache>.Instance, () => new DateOnly(2026, 10, 24));
            var night = new DhanHistoricalDataService(Client(new CountingDhan(), Ist(23, 21, 0), "20:00-08:00"), NullLogger<DhanHistoricalDataService>.Instance, cache);
            var (none, error) = await night.GetIntradayCandlesAsync(13, "IDX_I", new DateOnly(2026, 10, 22), new DateOnly(2026, 10, 22), 1, CancellationToken.None);
            Assert.Empty(none);
            Assert.True(MarketHours.IsIntradayQuiet(error), error);
            Assert.Equal(0, cache.CountKept().Files);

            var dhan = new CountingDhan(DayOfCandles(new DateOnly(2026, 10, 22)));
            var morning = new DhanHistoricalDataService(Client(dhan, Ist(24, 8, 0), "20:00-08:00"), NullLogger<DhanHistoricalDataService>.Instance, cache);
            var (candles, ok) = await morning.GetIntradayCandlesAsync(13, "IDX_I", new DateOnly(2026, 10, 22), new DateOnly(2026, 10, 22), 1, CancellationToken.None);
            Assert.Null(ok);
            Assert.Equal(375, candles.Count);
            Assert.Equal(1, dhan.Sent);
            Assert.True(cache.CountKept().Files > 0, "the day Dhan sent is kept");
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }
    }

    [Theory]
    [InlineData("20:00-08:00", true, 20, 8)]
    [InlineData(" 8:00 - 20:00 ", true, 8, 20)]
    [InlineData("", false, 0, 0)]
    [InlineData(null, false, 0, 0)]
    [InlineData("20:00", false, 0, 0)]
    [InlineData("08:00-08:00", false, 0, 0)]
    [InlineData("25:00-08:00", false, 0, 0)]
    public void The_quiet_hours_setting_is_read_as_from_and_until(string? text, bool ok, int from, int until)
    {
        Assert.Equal(ok, MarketHours.TryQuietHours(text, out var f, out var u));
        if (ok) Assert.Equal((TimeSpan.FromHours(from), TimeSpan.FromHours(until)), (f, u));
        // No setting holds nothing.
        Assert.Null(MarketHours.IntradayQuietReason(Ist(23, 23, 0), "/charts/intraday", ok ? null : text));
    }

    // A whole session of 1-minute index candles for `day` (09:15 - 15:29 IST), as Dhan's /charts/intraday answers.
    private static string DayOfCandles(DateOnly day)
    {
        var open = new DateTimeOffset(day.Year, day.Month, day.Day, 9, 15, 0, IstClock.Offset).ToUnixTimeSeconds();
        var times = Enumerable.Range(0, 375).Select(i => open + i * 60).ToList();
        string Arr(Func<int, string> v) => "[" + string.Join(",", times.Select((_, i) => v(i))) + "]";
        return $"{{\"open\":{Arr(_ => "100")},\"high\":{Arr(_ => "101")},\"low\":{Arr(_ => "99")},\"close\":{Arr(_ => "100.5")},\"volume\":{Arr(_ => "10")},\"timestamp\":{Arr(i => times[i].ToString())}}}";
    }

    private static DhanApiClient Client(CountingDhan dhan, DateTimeOffset now, string? intradayQuietHours = null)
    {
        var options = Options.Create(new DhanOptions { RestBaseUrl = "https://dhan.test", AccessToken = "t", ClientId = "c", IntradayQuietHours = intradayQuietHours });
        return new DhanApiClient(new HttpClient(dhan), options, new DhanSession(options), NullLogger<DhanApiClient>.Instance) { Clock = () => now };
    }

    private sealed class CountingDhan(string answer = "[]") : HttpMessageHandler
    {
        private int _sent;
        public int Sent => _sent;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _sent);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(answer, Encoding.UTF8, "application/json") });
        }
    }
}

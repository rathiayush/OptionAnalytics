using System.Diagnostics;
using System.Net;
using System.Text;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;
using Xunit;

namespace OptionAnalytics.Server.Tests;

/// <summary>Dhan's rate limits are per account: every Dhan REST call - orders, data, quotes, the rest - takes a slot on the
/// ONE shared DhanRestRateLimiter, inside DhanApiClient, each category on its own limits.</summary>
public class DhanDataApiSharedLimitTests
{
    private static readonly IOptions<DhanOptions> Options5 =
        Options.Create(new DhanOptions { RestBaseUrl = "https://dhan.test", AccessToken = "t", ClientId = "c", DataApiRequestsPerSecond = 5 });

    private static DhanDataApiRateLimiter DataLimiter() => new(Options5, NullLogger<DhanDataApiRateLimiter>.Instance);

    /// <summary>Records when each call reaches "Dhan"; answers success (or, `failFirst` times, `failStatus`).</summary>
    private sealed class RecordingDhan(int failFirst = 0, HttpStatusCode failStatus = HttpStatusCode.Unauthorized) : HttpMessageHandler
    {
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private int _failures = failFirst;
        public List<(TimeSpan At, string Path)> Calls { get; } = new();

        public List<TimeSpan> TimesOf(string pathEnd) { lock (Calls) return Calls.Where(c => c.Path.EndsWith(pathEnd)).Select(c => c.At).OrderBy(t => t).ToList(); }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            lock (Calls) Calls.Add((_clock.Elapsed, request.RequestUri!.AbsolutePath));
            if (Interlocked.Decrement(ref _failures) >= 0)
                return Task.FromResult(new HttpResponseMessage(failStatus)
                {
                    Content = new StringContent(failStatus == HttpStatusCode.TooManyRequests
                        ? "{\"errorCode\":\"DH-904\",\"errorMessage\":\"Too many requests on server from single user breaching rate limits.\"}"
                        : "{\"errorCode\":\"DH-901\",\"errorMessage\":\"Invalid Token\"}", Encoding.UTF8, "application/json"),
                });
            var path = request.RequestUri.AbsolutePath;
            var body = path.EndsWith("rollingoption") ? "{\"data\":{\"ce\":null,\"pe\":null}}"
                : path.Contains("/charts/") ? "{\"open\":[],\"high\":[],\"low\":[],\"close\":[],\"volume\":[],\"timestamp\":[]}"
                : path.EndsWith("/orders") && request.Method == HttpMethod.Post ? "{\"orderId\":\"1\",\"orderStatus\":\"PENDING\"}"
                : "[]";
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }
    }

    // Any `limit + 1` consecutive calls span at least `span`: never more than `limit` within it.
    private static void NeverMoreThan(int limit, TimeSpan span, List<TimeSpan> at)
    {
        for (var i = limit; i < at.Count; i++)
            Assert.True(at[i] - at[i - limit] >= span, $"calls {i - limit}..{i} within {(at[i] - at[i - limit]).TotalMilliseconds:0} ms");
    }

    [Fact]
    public async Task Intraday_and_expired_option_calls_together_never_reach_Dhan_more_than_5_in_a_second()
    {
        var dhan = new RecordingDhan();
        var data = DataLimiter();
        var api = new DhanApiClient(new HttpClient(dhan), Options5, new DhanSession(Options5), NullLogger<DhanApiClient>.Instance, new DhanRestRateLimiter(data));
        var history = new DhanHistoricalDataService(api, NullLogger<DhanHistoricalDataService>.Instance);
        var rolling = new DhanRollingOptionDataService(api, NullLogger<DhanRollingOptionDataService>.Instance);
        var day = new DateOnly(2026, 10, 20);

        // Two services, twelve calls at once - spot / futures candles and option strikes, as an OI Replay load asks them.
        var calls = Enumerable.Range(0, 6).Select(i => (Task)history.GetIntradayCandlesAsync(13u + (uint)i, "IDX_I", day, day, 1, CancellationToken.None))
            .Concat(Enumerable.Range(0, 6).Select(i => (Task)rolling.GetRollingOptionCandlesAsync("NIFTY", 13, "WEEK", 1, $"ATM+{i}", "CALL", day, day, 1, CancellationToken.None)))
            .ToList();
        await Task.WhenAll(calls);

        var at = dhan.Calls.Select(c => c.At).OrderBy(t => t).ToList();
        Assert.Equal(12, at.Count);
        Assert.Equal(6, dhan.TimesOf("/charts/intraday").Count);
        Assert.Equal(6, dhan.TimesOf("/charts/rollingoption").Count);
        NeverMoreThan(5, TimeSpan.FromMilliseconds(1000), at);
        Assert.Equal(12, data.PermitsGiven);
    }

    [Fact]
    public async Task A_call_sent_again_after_a_stale_token_takes_its_own_slot()
    {
        var dhan = new RecordingDhan(failFirst: 1);
        var limiter = new DhanRestRateLimiter(DataLimiter());
        var api = new DhanApiClient(new HttpClient(dhan), Options5, new DhanSession(Options5), NullLogger<DhanApiClient>.Instance, limiter)
        {
            AuthRetryDelay = TimeSpan.FromMilliseconds(10),
        };
        var history = new DhanHistoricalDataService(api, NullLogger<DhanHistoricalDataService>.Instance);
        var day = new DateOnly(2026, 10, 20);

        await history.GetIntradayCandlesAsync(13, "IDX_I", day, day, 1, CancellationToken.None);

        Assert.Equal(2, dhan.Calls.Count); // the refused call and its retry
        Assert.Equal(2, limiter.Sent(DhanApiCategory.Data)); // each with its own slot
        Assert.True(dhan.Calls[1].At - dhan.Calls[0].At >= TimeSpan.FromMilliseconds(200), "the retry waited for the next slot");
    }

    [Theory]
    [InlineData("POST", "/orders", DhanApiCategory.Order)]
    [InlineData("PUT", "/orders/1234", DhanApiCategory.Order)]
    [InlineData("DELETE", "/orders/1234", DhanApiCategory.Order)]
    [InlineData("POST", "/super/orders", DhanApiCategory.Order)]
    [InlineData("PUT", "/super/orders/1234", DhanApiCategory.Order)]
    [InlineData("DELETE", "/super/orders/1234/ENTRY_LEG", DhanApiCategory.Order)]
    [InlineData("DELETE", "/positions", DhanApiCategory.Order)]
    [InlineData("GET", "/orders", DhanApiCategory.NonTrading)]
    [InlineData("GET", "/super/orders", DhanApiCategory.NonTrading)]
    [InlineData("GET", "/positions", DhanApiCategory.NonTrading)]
    [InlineData("POST", "/killswitch?killSwitchStatus=ACTIVATE", DhanApiCategory.NonTrading)]
    [InlineData("POST", "/pnlExit", DhanApiCategory.NonTrading)]
    [InlineData("GET", "/profile", DhanApiCategory.NonTrading)]
    [InlineData("POST", "/charts/intraday", DhanApiCategory.Data)]
    [InlineData("POST", "/charts/rollingoption", DhanApiCategory.Data)]
    [InlineData("POST", "/optionchain", DhanApiCategory.Data)]
    [InlineData("POST", "/marketfeed/ltp", DhanApiCategory.Quote)]
    public void Every_Dhan_call_has_its_category(string method, string path, DhanApiCategory category) =>
        Assert.Equal(category, DhanRestRateLimiter.CategoryOf(new HttpMethod(method), path));

    [Fact]
    public async Task Orders_never_reach_Dhan_more_than_8_in_a_second()
    {
        var dhan = new RecordingDhan();
        var limiter = new DhanRestRateLimiter(DataLimiter());
        var api = new DhanApiClient(new HttpClient(dhan), Options5, new DhanSession(Options5), NullLogger<DhanApiClient>.Instance, limiter);

        await Task.WhenAll(Enumerable.Range(0, 12).Select(i => api.SendAsync(HttpMethod.Post, "/orders", new { i }, "placing an order", CancellationToken.None)));

        var at = dhan.TimesOf("/orders");
        Assert.Equal(12, at.Count);
        Assert.True(at[7] - at[0] < TimeSpan.FromMilliseconds(300), "the first 8 go at once - no added latency");
        NeverMoreThan(8, TimeSpan.FromMilliseconds(1000), at);
        Assert.Equal(12, limiter.Sent(DhanApiCategory.Order));
    }

    [Fact]
    public async Task An_order_never_waits_behind_data_calls()
    {
        var limiter = new DhanRestRateLimiter(DataLimiter());
        // Twenty data calls queued (about 4.4 s of them at 5 a second)...
        var data = Enumerable.Range(0, 20).Select(_ => limiter.WaitAsync(DhanApiCategory.Data, true, CancellationToken.None)).ToList();
        await Task.Delay(50);
        // ...an order and a positions read go straight away.
        var clock = Stopwatch.StartNew();
        Assert.Null(await limiter.WaitAsync(DhanApiCategory.Order, true, CancellationToken.None));
        Assert.Null(await limiter.WaitAsync(DhanApiCategory.NonTrading, true, CancellationToken.None));
        Assert.True(clock.Elapsed < TimeSpan.FromMilliseconds(100), $"waited {clock.Elapsed.TotalMilliseconds:0} ms");
        Assert.True(data.Count(t => t.IsCompleted) < 20);
    }

    [Fact]
    public async Task An_order_past_Dhan_s_minute_limit_is_refused_not_held()
    {
        var now = new DateTimeOffset(2026, 10, 23, 4, 0, 0, TimeSpan.Zero);
        var limiter = new DhanRestRateLimiter(DataLimiter(), () => now);
        // 240 orders over 48 s (5 a second - inside the per-second limit).
        for (var i = 0; i < 240; i++)
        {
            Assert.Null(await limiter.WaitAsync(DhanApiCategory.Order, true, CancellationToken.None));
            now = now.AddSeconds(0.2);
        }
        var refused = await limiter.WaitAsync(DhanApiCategory.Order, true, CancellationToken.None);
        Assert.NotNull(refused);
        Assert.Contains("250 a minute", refused);
        // A minute after the first, there is room again.
        now = now.AddSeconds(12.5);
        Assert.Null(await limiter.WaitAsync(DhanApiCategory.Order, true, CancellationToken.None));
    }

    [Fact]
    public async Task The_data_day_cap_refuses_and_a_new_day_starts_afresh()
    {
        var now = new DateTimeOffset(2026, 10, 23, 4, 0, 0, TimeSpan.Zero);
        var limiter = new DhanRestRateLimiter(DataLimiter(), () => now) { DataToday = DhanRestRateLimiter.DataDayLimit };
        Assert.Contains("100,000 a day", await limiter.WaitAsync(DhanApiCategory.Data, true, CancellationToken.None));
        now = now.AddDays(1);
        Assert.Null(await limiter.WaitAsync(DhanApiCategory.Data, true, CancellationToken.None));
    }

    [Fact]
    public async Task Dhan_s_too_many_requests_pauses_that_category()
    {
        var dhan = new RecordingDhan(failFirst: 1, failStatus: HttpStatusCode.TooManyRequests);
        var limiter = new DhanRestRateLimiter(DataLimiter());
        var api = new DhanApiClient(new HttpClient(dhan), Options5, new DhanSession(Options5), NullLogger<DhanApiClient>.Instance, limiter);

        using (var first = await api.SendAsync(HttpMethod.Get, "/positions", null, "listing positions", CancellationToken.None)) Assert.False(first.Success);
        using (var second = await api.SendAsync(HttpMethod.Get, "/positions", null, "listing positions", CancellationToken.None)) Assert.True(second.Success);

        Assert.True(dhan.Calls[1].At - dhan.Calls[0].At >= DhanDataApiRateLimiter.RateLimitPause - TimeSpan.FromMilliseconds(50));
    }

    [Fact]
    public void The_app_shares_one_limiter_across_every_Dhan_client()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton(Options5);
        services.AddSingleton<DhanSession>();
        services.AddSingleton<DhanDataApiRateLimiter>();
        services.AddSingleton<DhanRestRateLimiter>();
        services.AddHttpClient<DhanApiClient>();
        using var provider = services.BuildServiceProvider();

        // DhanApiClient is a transient typed client - every one gets the same singleton limiter.
        var first = provider.GetRequiredService<DhanApiClient>();
        var second = provider.GetRequiredService<DhanApiClient>();
        Assert.NotSame(first, second);
        Assert.Same(provider.GetRequiredService<DhanRestRateLimiter>(), first.RateLimiter);
        Assert.Same(first.RateLimiter, second.RateLimiter);
        Assert.Same(provider.GetRequiredService<DhanDataApiRateLimiter>(), first.RateLimiter.Data);
    }
}

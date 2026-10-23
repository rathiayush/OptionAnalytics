using System.Diagnostics;
using System.Net;
using System.Text;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;
using Xunit;

namespace OptionAnalytics.Server.Tests;

/// <summary>Dhan's Data APIs allow 5 calls a second for the whole account: every data call - intraday charts, the rolling
/// (expired) option chain, an auth retry - waits on the ONE shared DhanDataApiRateLimiter.</summary>
public class DhanDataApiSharedLimitTests
{
    private static readonly IOptions<DhanOptions> Options5 =
        Options.Create(new DhanOptions { RestBaseUrl = "https://dhan.test", AccessToken = "t", ClientId = "c", DataApiRequestsPerSecond = 5 });

    /// <summary>Records when each call reaches "Dhan"; answers an empty candle set (or, `authFailuresFirst` times, 401).</summary>
    private sealed class RecordingDhan(int authFailuresFirst = 0) : HttpMessageHandler
    {
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private int _authFailures = authFailuresFirst;
        public List<(TimeSpan At, string Path)> Calls { get; } = new();

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            lock (Calls) Calls.Add((_clock.Elapsed, request.RequestUri!.AbsolutePath));
            if (Interlocked.Decrement(ref _authFailures) >= 0)
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Unauthorized) { Content = new StringContent("{\"errorCode\":\"DH-901\",\"errorMessage\":\"Invalid Token\"}", Encoding.UTF8, "application/json") });
            var body = request.RequestUri.AbsolutePath.EndsWith("rollingoption")
                ? "{\"data\":{\"ce\":null,\"pe\":null}}"
                : "{\"open\":[],\"high\":[],\"low\":[],\"close\":[],\"volume\":[],\"timestamp\":[]}";
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }
    }

    [Fact]
    public async Task Intraday_and_expired_option_calls_together_never_reach_Dhan_more_than_5_in_a_second()
    {
        var dhan = new RecordingDhan();
        var limiter = new DhanDataApiRateLimiter(Options5, NullLogger<DhanDataApiRateLimiter>.Instance);
        var api = new DhanApiClient(new HttpClient(dhan), Options5, new DhanSession(Options5), NullLogger<DhanApiClient>.Instance, limiter);
        var history = new DhanHistoricalDataService(api, limiter, NullLogger<DhanHistoricalDataService>.Instance);
        var rolling = new DhanRollingOptionDataService(api, limiter, NullLogger<DhanRollingOptionDataService>.Instance);
        var day = new DateOnly(2026, 10, 20);

        // Two services, twelve calls at once - spot / futures candles and option strikes, as an OI Replay load asks them.
        var calls = Enumerable.Range(0, 6).Select(i => (Task)history.GetIntradayCandlesAsync(13u + (uint)i, "IDX_I", day, day, 1, CancellationToken.None))
            .Concat(Enumerable.Range(0, 6).Select(i => (Task)rolling.GetRollingOptionCandlesAsync("NIFTY", 13, "WEEK", 1, $"ATM+{i}", "CALL", day, day, 1, CancellationToken.None)))
            .ToList();
        await Task.WhenAll(calls);

        var at = dhan.Calls.Select(c => c.At).OrderBy(t => t).ToList();
        Assert.Equal(12, at.Count);
        Assert.Contains(dhan.Calls, c => c.Path.EndsWith("/charts/intraday"));
        Assert.Contains(dhan.Calls, c => c.Path.EndsWith("/charts/rollingoption"));
        // Any 6 consecutive calls span more than a second: never 6 within one second.
        for (var i = 5; i < at.Count; i++)
            Assert.True(at[i] - at[i - 5] >= TimeSpan.FromMilliseconds(1000), $"calls {i - 5}..{i} within {(at[i] - at[i - 5]).TotalMilliseconds:0} ms");
        Assert.Equal(12, limiter.PermitsGiven);
    }

    [Fact]
    public async Task A_data_call_sent_again_after_a_stale_token_takes_its_own_slot()
    {
        var dhan = new RecordingDhan(authFailuresFirst: 1);
        var limiter = new DhanDataApiRateLimiter(Options5, NullLogger<DhanDataApiRateLimiter>.Instance);
        var api = new DhanApiClient(new HttpClient(dhan), Options5, new DhanSession(Options5), NullLogger<DhanApiClient>.Instance, limiter)
        {
            AuthRetryDelay = TimeSpan.FromMilliseconds(10),
        };
        var history = new DhanHistoricalDataService(api, limiter, NullLogger<DhanHistoricalDataService>.Instance);
        var day = new DateOnly(2026, 10, 20);

        await history.GetIntradayCandlesAsync(13, "IDX_I", day, day, 1, CancellationToken.None);

        Assert.Equal(2, dhan.Calls.Count); // the refused call and its retry
        Assert.Equal(2, limiter.PermitsGiven); // each with its own slot
        Assert.True(dhan.Calls[1].At - dhan.Calls[0].At >= TimeSpan.FromMilliseconds(200), "the retry waited for the next slot");
    }

    [Fact]
    public void The_app_wires_one_limiter_into_the_Dhan_client()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton(Options5);
        services.AddSingleton<DhanSession>();
        services.AddSingleton<DhanDataApiRateLimiter>();
        services.AddHttpClient<DhanApiClient>();
        using var provider = services.BuildServiceProvider();

        var api = provider.GetRequiredService<DhanApiClient>();
        Assert.Same(provider.GetRequiredService<DhanDataApiRateLimiter>(), api.DataApiLimiter);
    }
}

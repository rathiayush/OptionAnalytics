using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// DhanDataCache: every past-day Dhan Data API response (intraday spot / futures / option candles, the rolling /
/// expired-option chain) is kept on disk and the same request is answered from there - across restarts, and with no
/// Dhan session. Only what can never change is kept: a window that has closed, with data in it (a full session's bars
/// for the candles). Today, an empty answer, a half day, a failed call are asked of Dhan again.
/// </summary>
public sealed class DhanDataCacheTests : IDisposable
{
    private static readonly DateOnly PastDay = new(2025, 9, 15);
    private readonly string _dir = Path.Combine(Path.GetTempPath(), $"dhan-cache-{Guid.NewGuid():N}");

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    private DhanDataCache Cache(DateOnly? today = null) => new(_dir, NullLogger<DhanDataCache>.Instance, () => today ?? new DateOnly(2026, 10, 12));

    [Fact]
    public void AClosedWindowWithData_IsKept_AndReadBack_ByItsRequest()
    {
        var cache = Cache();
        var payload = new { securityId = "13", fromDate = "2025-09-15 09:15:00", toDate = "2025-09-15 15:30:00" };
        using var doc = JsonDocument.Parse("""{"close":[1,2],"timestamp":[1,2]}""");
        cache.Put("/charts/intraday", payload, PastDay, doc.RootElement, hasData: true);

        using var back = cache.TryGet("/charts/intraday", payload, PastDay);
        Assert.NotNull(back);
        Assert.Equal(doc.RootElement.GetRawText(), back!.RootElement.GetRawText());
        Assert.Equal((1, 1), (cache.Writes, cache.Hits));
        Assert.Null(cache.TryGet("/charts/intraday", new { securityId = "14", fromDate = "2025-09-15 09:15:00", toDate = "2025-09-15 15:30:00" }, PastDay));
        Assert.Null(cache.TryGet("/charts/rollingoption", payload, PastDay));
        // On disk as gzip JSON with the request beside the response - readable on the Data files page.
        var file = cache.FileOf("/charts/intraday", payload, PastDay);
        Assert.Contains(Path.Combine("v1", "charts-intraday", "2025-09"), file);
        Assert.EndsWith(".json.gz", file);
    }

    [Fact]
    public void Today_AnEmptyAnswer_AndABrokenFile_AreNeverServed()
    {
        var today = new DateOnly(2026, 10, 12);
        var cache = Cache(today);
        var payload = new { securityId = "13" };
        using var doc = JsonDocument.Parse("""{"timestamp":[1]}""");
        cache.Put("/charts/intraday", payload, today, doc.RootElement, hasData: true);
        Assert.Null(cache.TryGet("/charts/intraday", payload, today));
        Assert.False(Directory.Exists(_dir), "today is still forming - nothing written");

        cache.Put("/charts/intraday", payload, PastDay, doc.RootElement, hasData: false);
        Assert.Null(cache.TryGet("/charts/intraday", payload, PastDay));

        cache.Put("/charts/intraday", payload, PastDay, doc.RootElement, hasData: true);
        var file = cache.FileOf("/charts/intraday", payload, PastDay);
        File.WriteAllText(file, "not gzip");
        Assert.Null(cache.TryGet("/charts/intraday", payload, PastDay));
        Assert.False(File.Exists(file), "a broken file is deleted, so the day is fetched again");
    }

    [Fact]
    public async Task APastDaysSpotCandles_AreAskedOfDhanOnce_ThenServedFromDisk_EvenWithNoSession()
    {
        var requests = new List<string>();
        var service = Historical(requests, Cache(), session: true);
        var (first, error) = await service.GetIntradayCandlesAsync(13, "IDX_I", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Null(error);
        Assert.Equal(375, first.Count);
        var (again, _) = await service.GetIntradayCandlesAsync(13, "IDX_I", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Single(requests);
        Assert.Equal(first.Select(c => (c.Time, c.Close)), again.Select(c => (c.Time, c.Close)));

        // A restart, and Dhan not logged in: the closed day still comes from disk.
        var offline = Historical(requests, Cache(), session: false);
        var (fromDisk, offlineError) = await offline.GetIntradayCandlesAsync(13, "IDX_I", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Null(offlineError);
        Assert.Equal(375, fromDisk.Count);
        Assert.Single(requests);
        // A day never fetched, with no session: the usual error.
        var (_, notThere) = await offline.GetIntradayCandlesAsync(13, "IDX_I", PastDay.AddDays(-3), PastDay.AddDays(-3), 1, CancellationToken.None);
        Assert.Equal("Dhan is not authenticated", notThere);
    }

    [Fact]
    public async Task FuturesCandles_AreKeptToo_WithTheirOi()
    {
        var requests = new List<string>();
        var service = Historical(requests, Cache(), session: true);
        var (bars, oiPresent, _) = await service.GetIntradayFuturesCandlesAsync(55, "NSE_FNO", PastDay, PastDay, 1, CancellationToken.None);
        var (again, oiAgain, _) = await service.GetIntradayFuturesCandlesAsync(55, "NSE_FNO", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Single(requests);
        Assert.True(oiPresent && oiAgain);
        Assert.Equal(bars.Select(b => b.OpenInterest), again.Select(b => b.OpenInterest));
    }

    [Fact]
    public async Task Today_AHalfDay_AndAnEmptyDay_AreAskedAgain()
    {
        var requests = new List<string>();
        var today = new DateOnly(2026, 10, 12);
        var service = Historical(requests, Cache(today), session: true);
        await service.GetIntradayCandlesAsync(13, "IDX_I", today, today, 1, CancellationToken.None);
        await service.GetIntradayCandlesAsync(13, "IDX_I", today, today, 1, CancellationToken.None);
        Assert.Equal(2, requests.Count);

        requests.Clear();
        var half = Historical(requests, Cache(today), session: true, bars: 120);
        await half.GetIntradayCandlesAsync(13, "IDX_I", PastDay, PastDay, 1, CancellationToken.None);
        await half.GetIntradayCandlesAsync(13, "IDX_I", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Equal(2, requests.Count);

        requests.Clear();
        var empty = Historical(requests, Cache(today), session: true, bars: 0);
        await empty.GetIntradayCandlesAsync(14, "IDX_I", PastDay, PastDay, 1, CancellationToken.None);
        await empty.GetIntradayCandlesAsync(14, "IDX_I", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Equal(2, requests.Count);
    }

    [Fact]
    public async Task TheExpiredOptionChain_IsKeptPerChunk()
    {
        var requests = new List<string>();
        var service = Rolling(requests, Cache(), session: true);
        var (bars, error) = await service.GetRollingOptionCandlesAsync("NIFTY", 13, "WEEK", 1, "ATM", "CALL", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Null(error);
        Assert.NotEmpty(bars);
        var (again, _) = await Rolling(requests, Cache(), session: false).GetRollingOptionCandlesAsync("NIFTY", 13, "WEEK", 1, "ATM", "CALL", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Single(requests);
        Assert.Equal(bars.Select(b => (b.Bar.Close, b.OpenInterest)), again.Select(b => (b.Bar.Close, b.OpenInterest)));
        // The other side, or another strike, is its own request.
        await service.GetRollingOptionCandlesAsync("NIFTY", 13, "WEEK", 1, "ATM", "PUT", PastDay, PastDay, 1, CancellationToken.None);
        await service.GetRollingOptionCandlesAsync("NIFTY", 13, "WEEK", 1, "ATM+1", "CALL", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Equal(3, requests.Count);
        // A day Dhan sent only part of is asked again.
        requests.Clear();
        var (api, limiter) = Api(requests, session: true, bars: 90);
        var half = new DhanRollingOptionDataService(api, limiter, NullLogger<DhanRollingOptionDataService>.Instance, Cache());
        await half.GetRollingOptionCandlesAsync("NIFTY", 13, "WEEK", 1, "ATM-2", "CALL", PastDay, PastDay, 1, CancellationToken.None);
        await half.GetRollingOptionCandlesAsync("NIFTY", 13, "WEEK", 1, "ATM-2", "CALL", PastDay, PastDay, 1, CancellationToken.None);
        Assert.Equal(2, requests.Count);
    }

    [Fact]
    public void CompleteDays_NeedsAFullSessionOnEveryDay()
    {
        var start = new DateTimeOffset(2025, 9, 15, 9, 15, 0, TimeSpan.FromMinutes(330));
        var day = Enumerable.Range(0, 375).Select(i => start.AddMinutes(i)).ToList();
        Assert.True(DhanHistoricalDataService.CompleteDays(day, 1));
        Assert.False(DhanHistoricalDataService.CompleteDays(day.Take(200), 1));
        Assert.False(DhanHistoricalDataService.CompleteDays(day.Concat(day.Take(50).Select(t => t.AddDays(1))), 1), "the second day is half there");
        Assert.True(DhanHistoricalDataService.CompleteDays(day.Where((_, i) => i % 5 == 0), 5));
        Assert.False(DhanHistoricalDataService.CompleteDays(Array.Empty<DateTimeOffset>(), 1));
    }

    private static (DhanApiClient Api, DhanDataApiRateLimiter Limiter) Api(List<string> requests, bool session, int bars)
    {
        var options = Options.Create(new DhanOptions { RestBaseUrl = "https://dhan.test", AccessToken = session ? "t" : "", ClientId = "c", DataApiRequestsPerSecond = 200 });
        var api = new DhanApiClient(new HttpClient(new FakeDhan(requests, bars)), options, new DhanSession(options), NullLogger<DhanApiClient>.Instance);
        return (api, new DhanDataApiRateLimiter(options, NullLogger<DhanDataApiRateLimiter>.Instance));
    }

    private static DhanHistoricalDataService Historical(List<string> requests, DhanDataCache cache, bool session, int bars = 375)
    {
        var (api, limiter) = Api(requests, session, bars);
        return new DhanHistoricalDataService(api, limiter, NullLogger<DhanHistoricalDataService>.Instance, cache);
    }

    private static DhanRollingOptionDataService Rolling(List<string> requests, DhanDataCache cache, bool session)
    {
        var (api, limiter) = Api(requests, session, 375);
        return new DhanRollingOptionDataService(api, limiter, NullLogger<DhanRollingOptionDataService>.Instance, cache);
    }

    /// <summary>A day of 1-minute bars from 09:15 IST of the request's first date (`bars` of them), as Dhan sends them:
    /// intraday as parallel arrays (with open_interest), the rolling option chain under data.ce / data.pe.</summary>
    private sealed class FakeDhan(List<string> requests, int bars) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!;
            lock (requests) requests.Add($"{request.RequestUri!.AbsolutePath} {body.ToJsonString()}");
            var date = DateOnly.Parse(body["fromDate"]!.ToString()[..10]);
            var open = new DateTimeOffset(date.Year, date.Month, date.Day, 9, 15, 0, TimeSpan.FromMinutes(330)).ToUnixTimeSeconds();
            JsonArray Arr(Func<int, double> f) => new(Enumerable.Range(0, bars).Select(i => (JsonNode)JsonValue.Create(f(i))!).ToArray());
            var series = new JsonObject
            {
                ["open"] = Arr(i => 100 + i), ["high"] = Arr(i => 101 + i), ["low"] = Arr(i => 99 + i), ["close"] = Arr(i => 100.5 + i),
                ["volume"] = Arr(_ => 10), ["timestamp"] = Arr(i => open + 60 * i), ["open_interest"] = Arr(i => 1000 + i),
            };
            JsonNode json = request.RequestUri.AbsolutePath.EndsWith("rollingoption")
                ? new JsonObject
                {
                    ["data"] = new JsonObject
                    {
                        [body["drvOptionType"]!.ToString() == "PUT" ? "pe" : "ce"] = new JsonObject
                        {
                            ["open"] = Arr(i => 50 + i * 0.1), ["high"] = Arr(i => 51 + i * 0.1), ["low"] = Arr(i => 49 + i * 0.1), ["close"] = Arr(i => 50.5 + i * 0.1),
                            ["volume"] = Arr(_ => 5), ["timestamp"] = Arr(i => open + 60 * i), ["oi"] = Arr(i => 2000 + i), ["iv"] = Arr(_ => 12),
                            ["strike"] = Arr(_ => 25000), ["spot"] = Arr(_ => 25010),
                        },
                    },
                }
                : series;
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json.ToJsonString(), Encoding.UTF8, "application/json") };
        }
    }
}

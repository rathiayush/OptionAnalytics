using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Tests;

/// <summary>
/// PastFuturesCandleCache: a PAST day's futures candles are fetched once however many parts of the
/// app want them. Two endpoints do want the same contract-day - OI Replay's own futures fetch
/// (OiReplayService.GetFuturesAsync) and the Order Flow page's Load day (OrderFlowHistory) - and a
/// strategy tuning job in Futures + OI mode asks for both for every day it scans, so the second
/// fetch was a Dhan call bought twice. Today is deliberately NOT cached (it is still forming).
/// </summary>
public sealed class PastFuturesCandleCacheTests
{
    private static readonly DateOnly PastDay = new(2025, 9, 15);

    private static DhanFuturesInstrument Contract(uint id = 100) => new(id, "NIFTY-Oct2025-FUT", "NIFTY", IstClock.Today().AddDays(20), "NSE_FNO", 75, 0.1m);

    [Fact]
    public async Task APastDayAskedForTwice_IsFetchedOnce()
    {
        var (service, requests) = Create(withCandles: true);
        var cache = new PastFuturesCandleCache();
        var contract = Contract();

        var first = await cache.FetchAsync(service, contract, Array.Empty<DhanFuturesInstrument>(), PastDay, CancellationToken.None);
        var second = await cache.FetchAsync(service, contract, Array.Empty<DhanFuturesInstrument>(), PastDay, CancellationToken.None);

        Assert.Equal(2, first.Bars.Count);
        Assert.Equal(first.Bars.Count, second.Bars.Count);
        Assert.Single(requests);
        Assert.Equal(1, cache.Hits);
    }

    [Fact]
    public async Task TwoCallersAtOnceForTheSamePastDay_ShareOneFetch()
    {
        var (service, requests) = Create(withCandles: true);
        var cache = new PastFuturesCandleCache();
        var contract = Contract();

        var both = await Task.WhenAll(
            cache.FetchAsync(service, contract, Array.Empty<DhanFuturesInstrument>(), PastDay, CancellationToken.None),
            cache.FetchAsync(service, contract, Array.Empty<DhanFuturesInstrument>(), PastDay, CancellationToken.None));

        Assert.All(both, r => Assert.Equal(2, r.Bars.Count));
        Assert.Single(requests);
    }

    [Fact]
    public async Task Today_IsNeverCached()
    {
        // Today's candles are still forming: a second ask must reach Dhan again.
        var (service, requests) = Create(withCandles: true);
        var cache = new PastFuturesCandleCache();
        var contract = Contract();

        await cache.FetchAsync(service, contract, Array.Empty<DhanFuturesInstrument>(), IstClock.Today(), CancellationToken.None);
        await cache.FetchAsync(service, contract, Array.Empty<DhanFuturesInstrument>(), IstClock.Today(), CancellationToken.None);

        Assert.Equal(2, requests.Count);
        Assert.Equal(0, cache.Hits);
    }

    [Fact]
    public async Task ADayThatCameBackEmpty_IsAskedAgain()
    {
        // No bars may simply be NSE having been unreachable for a moment - never kept as a fact.
        var (service, requests) = Create(withCandles: false);
        var cache = new PastFuturesCandleCache();
        var contract = Contract();

        await cache.FetchAsync(service, contract, Array.Empty<DhanFuturesInstrument>(), PastDay, CancellationToken.None);
        await cache.FetchAsync(service, contract, Array.Empty<DhanFuturesInstrument>(), PastDay, CancellationToken.None);

        Assert.Equal(2, requests.Count);
    }

    [Fact]
    public async Task DifferentContracts_AreSeparateEntries()
    {
        var (service, requests) = Create(withCandles: true);
        var cache = new PastFuturesCandleCache();

        await cache.FetchAsync(service, Contract(100), Array.Empty<DhanFuturesInstrument>(), PastDay, CancellationToken.None);
        await cache.FetchAsync(service, Contract(200), Array.Empty<DhanFuturesInstrument>(), PastDay, CancellationToken.None);

        Assert.Equal(new[] { "100", "200" }, requests);
    }

    private static (DhanHistoricalDataService Service, List<string> Requests) Create(bool withCandles)
    {
        var requests = new List<string>();
        var options = Options.Create(new DhanOptions { RestBaseUrl = "https://dhan.test", AccessToken = "t", ClientId = "c", DataApiRequestsPerSecond = 200 });
        var http = new HttpClient(new Handler(withCandles, requests));
        var api = new DhanApiClient(http, options, new DhanSession(options), NullLogger<DhanApiClient>.Instance);
        return (new DhanHistoricalDataService(api, new DhanDataApiRateLimiter(options, NullLogger<DhanDataApiRateLimiter>.Instance), NullLogger<DhanHistoricalDataService>.Instance), requests);
    }

    private sealed class Handler(bool withCandles, List<string> requests) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!;
            lock (requests) requests.Add(body["securityId"]!.ToString());
            var ts = new DateTimeOffset(2025, 9, 15, 3, 45, 0, TimeSpan.Zero).ToUnixTimeSeconds();
            JsonNode json = withCandles
                ? new JsonObject { ["open"] = new JsonArray(1, 2), ["high"] = new JsonArray(1, 2), ["low"] = new JsonArray(1, 2), ["close"] = new JsonArray(1, 2), ["volume"] = new JsonArray(10, 20), ["timestamp"] = new JsonArray(ts, ts + 60) }
                : new JsonObject { ["open"] = new JsonArray(), ["high"] = new JsonArray(), ["low"] = new JsonArray(), ["close"] = new JsonArray(), ["volume"] = new JsonArray(), ["timestamp"] = new JsonArray() };
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json.ToJsonString(), Encoding.UTF8, "application/json") };
        }
    }
}

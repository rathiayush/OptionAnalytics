using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Tests;

/// <summary>Dhan has no intraday history for an expired futures contract - the next contract that traded
/// that day (still live) is used instead, and the result says so.</summary>
public sealed class PastFuturesCandlesTests
{
    private static readonly DateOnly Day = new(2025, 9, 15);

    [Fact]
    public async Task AnExpiredContractWithNoCandles_FallsBackToTheNextOneListedThatDay()
    {
        var (service, requests) = Create(withCandles: new HashSet<string> { "200" });
        var expired = Contract(100, "NIFTY-Sep2025-FUT", new DateOnly(2025, 9, 30));
        var next = Contract(200, "NIFTY-Oct2025-FUT", IstClock.Today().AddDays(20));
        var far = Contract(300, "NIFTY-Nov2025-FUT", IstClock.Today().AddDays(50));

        var result = await PastFuturesCandles.FetchAsync(service, expired, new[] { far, expired, next }, Day, CancellationToken.None);

        Assert.Equal(200u, result.Contract.SecurityId);
        Assert.Equal(2, result.Bars.Count);
        Assert.Contains("NIFTY-Oct2025-FUT", result.Note);
        Assert.Equal(new[] { "100", "200" }, requests); // nearest expiry first, stops at the first with data
    }

    [Fact]
    public async Task ALiveContract_IsNeverSwapped()
    {
        var (service, requests) = Create(withCandles: new HashSet<string>());
        var live = Contract(200, "NIFTY-Oct2025-FUT", IstClock.Today().AddDays(20));

        var result = await PastFuturesCandles.FetchAsync(service, live, new[] { Contract(300, "X", IstClock.Today().AddDays(50)) }, Day, CancellationToken.None);

        Assert.Equal(200u, result.Contract.SecurityId);
        Assert.Null(result.Note);
        Assert.Single(requests);
    }

    private static DhanFuturesInstrument Contract(uint id, string symbol, DateOnly expiry) => new(id, symbol, "NIFTY", expiry, "NSE_FNO", 75, 0.1m);

    private static (DhanHistoricalDataService Service, List<string> Requests) Create(HashSet<string> withCandles)
    {
        var requests = new List<string>();
        var options = Options.Create(new DhanOptions { RestBaseUrl = "https://dhan.test", AccessToken = "t", ClientId = "c" });
        var http = new HttpClient(new Handler(withCandles, requests));
        var api = new DhanApiClient(http, options, new DhanSession(options), NullLogger<DhanApiClient>.Instance);
        return (new DhanHistoricalDataService(api, NullLogger<DhanHistoricalDataService>.Instance), requests);
    }

    private sealed class Handler(HashSet<string> withCandles, List<string> requests) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!;
            var id = body["securityId"]!.ToString();
            lock (requests) requests.Add(id);
            var ts = new DateTimeOffset(2025, 9, 15, 3, 45, 0, TimeSpan.Zero).ToUnixTimeSeconds();
            JsonNode json = withCandles.Contains(id)
                ? new JsonObject { ["open"] = new JsonArray(1, 2), ["high"] = new JsonArray(1, 2), ["low"] = new JsonArray(1, 2), ["close"] = new JsonArray(1, 2), ["volume"] = new JsonArray(10, 20), ["timestamp"] = new JsonArray(ts, ts + 60) }
                : new JsonObject { ["open"] = new JsonArray(), ["high"] = new JsonArray(), ["low"] = new JsonArray(), ["close"] = new JsonArray(), ["volume"] = new JsonArray(), ["timestamp"] = new JsonArray() };
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json.ToJsonString(), Encoding.UTF8, "application/json") };
        }
    }
}

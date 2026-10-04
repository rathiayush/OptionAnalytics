using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Tests;

/// <summary>An expired futures contract's past day from NSE's chart data - Dhan keeps no intraday
/// history for expired contracts - tried before falling back to another contract listed that day.</summary>
public sealed class NseChartHistoryTests
{
    private static readonly DateOnly Day = new(2026, 9, 25);
    private static readonly TimeSpan Ist = TimeSpan.FromMinutes(330);

    [Fact]
    public void Ticker_IsNsesFuturesSymbol()
    {
        Assert.Equal("NIFTY26SEPFUT", NseChartHistory.Ticker(Contract(68407, "NIFTY-Sep2026-FUT", new DateOnly(2026, 9, 29))));
        Assert.Equal("BANKNIFTY26OCTFUT", NseChartHistory.Ticker(new DhanFuturesInstrument(1, "x", "BankNifty", new DateOnly(2026, 10, 27), "NSE_FNO", 30, 0.2m)));
    }

    [Fact]
    public void Parse_ReadsIstWallClockStamps_AndRealUtcStamps_KeepingOnlyThatSession()
    {
        // NSE's chart writes 09:15 IST as 09:15 "UTC"; a true UTC stamp of 09:16 IST is 03:46Z.
        long WallClock(int h, int m) => new DateTimeOffset(2026, 9, 25, h, m, 0, TimeSpan.Zero).ToUnixTimeMilliseconds();
        var realUtc = new DateTimeOffset(2026, 9, 25, 9, 16, 0, Ist).ToUnixTimeMilliseconds();
        var body = new JsonObject
        {
            ["status"] = true,
            ["data"] = new JsonArray(
                Bar(WallClock(9, 15), 25000, 25010, 24990, 25005, 6500),
                Bar(realUtc, 25005, 25020, 25000, 25015, 1300),
                new JsonObject { ["time"] = WallClock(9, 17), ["open"] = "25015", ["high"] = "25030", ["low"] = "25010", ["close"] = "25025", ["volume"] = "650" },
                Bar(WallClock(15, 30), 25100, 25100, 25100, 25100, 10),                        // closing print - after the session
                Bar(new DateTimeOffset(2026, 9, 24, 10, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds(), 1, 1, 1, 1, 1)), // another day
        }.ToJsonString();

        var bars = NseChartHistory.Parse(body, Day);

        Assert.Equal(3, bars.Count);
        Assert.Equal(new DateTimeOffset(2026, 9, 25, 9, 15, 0, Ist), bars[0].Time);
        Assert.Equal(new DateTimeOffset(2026, 9, 25, 9, 16, 0, Ist), bars[1].Time);
        Assert.Equal(25025m, bars[2].Close);
        Assert.Equal(650, bars[2].Volume);
    }

    [Fact]
    public async Task DayAsync_AsksForTheContractByTokenAndTicker_AndKeepsTheDay()
    {
        var nse = new FakeNse(HttpStatusCode.OK, OneBar());
        var history = new NseChartHistory(new HttpClient(nse), NullLogger<NseChartHistory>.Instance);
        var expired = Contract(68407, "NIFTY-Sep2026-FUT", new DateOnly(2026, 9, 29));

        var first = await history.DayAsync(expired, Day, CancellationToken.None);
        var again = await history.DayAsync(expired, Day, CancellationToken.None);

        Assert.Single(first.Bars);
        Assert.Null(first.Error);
        Assert.Same(first, again);
        var body = Assert.Single(nse.Posts);
        Assert.Equal("68407", body["token"]!.ToString());
        Assert.Equal("NIFTY26SEPFUT", body["symbol"]!.ToString());
        Assert.Equal("Futures", body["symbolType"]!.ToString());
        Assert.Equal("I", body["chartType"]!.ToString());
    }

    [Fact]
    public async Task ABlockedNse_IsReportedNotThrown_AndAskedAgainNextTime()
    {
        var nse = new FakeNse(HttpStatusCode.Forbidden, "<HTML><TITLE>Access Denied</TITLE></HTML>");
        var history = new NseChartHistory(new HttpClient(nse), NullLogger<NseChartHistory>.Instance);
        var expired = Contract(68407, "NIFTY-Sep2026-FUT", new DateOnly(2026, 9, 29));

        var result = await history.DayAsync(expired, Day, CancellationToken.None);
        await Task.Delay(50); // the failed answer is dropped from the cache in a continuation
        await history.DayAsync(expired, Day, CancellationToken.None);

        Assert.Empty(result.Bars);
        Assert.Contains("403", result.Error);
        Assert.Contains("Access Denied", result.Error);
        Assert.Equal(2, nse.Posts.Count);
    }

    [Fact]
    public async Task AnExpiredContract_IsLoadedFromNse_BeforeSwappingToAnotherContract()
    {
        var (dhan, dhanRequests) = Dhan();
        var history = new NseChartHistory(new HttpClient(new FakeNse(HttpStatusCode.OK, OneBar())), NullLogger<NseChartHistory>.Instance);
        var expired = Contract(68407, "NIFTY-Sep2026-FUT", new DateOnly(2026, 9, 29));
        var next = Contract(200, "NIFTY-Oct2026-FUT", IstClock.Today().AddDays(20));

        var result = await PastFuturesCandles.FetchAsync(dhan, expired, new[] { expired, next }, Day, CancellationToken.None, history);

        Assert.Equal(68407u, result.Contract.SecurityId);
        Assert.Single(result.Bars);
        Assert.Null(result.Bars[0].OpenInterest);
        Assert.False(result.OiFieldPresent);
        Assert.Contains("NSE", result.Note);
        Assert.Equal(new[] { "68407" }, dhanRequests);
    }

    [Fact]
    public async Task WhenNseHasNothing_TheNextContractIsUsed_AndTheNoteSaysWhatEachSourceSaid()
    {
        var (dhan, _) = Dhan(withCandles: "200");
        var history = new NseChartHistory(new HttpClient(new FakeNse(HttpStatusCode.Forbidden, "Access Denied")), NullLogger<NseChartHistory>.Instance);
        var expired = Contract(68407, "NIFTY-Sep2026-FUT", new DateOnly(2026, 9, 29));
        var next = Contract(200, "NIFTY-Oct2026-FUT", IstClock.Today().AddDays(20));

        var result = await PastFuturesCandles.FetchAsync(dhan, expired, new[] { expired, next }, Day, CancellationToken.None, history);

        Assert.Equal(200u, result.Contract.SecurityId);
        Assert.Contains("Dhan:", result.Note);
        Assert.Contains("NSE: NSE chart data answered HTTP 403", result.Note);
    }

    [Fact]
    public async Task WhenNothingWorks_TheResultIsEmpty_WithEachSourcesAnswer()
    {
        var (dhan, _) = Dhan();
        var history = new NseChartHistory(new HttpClient(new FakeNse(HttpStatusCode.OK, """{"status":true,"data":[]}""")), NullLogger<NseChartHistory>.Instance);
        var expired = Contract(68407, "NIFTY-Sep2026-FUT", new DateOnly(2026, 9, 29));

        var result = await PastFuturesCandles.FetchAsync(dhan, expired, new[] { expired }, Day, CancellationToken.None, history);

        Assert.Empty(result.Bars);
        Assert.Null(result.Error);
        Assert.Contains("Dhan: no candles", result.Note);
        Assert.Contains("NSE: no NIFTY26SEPFUT bars", result.Note);
    }

    private static JsonObject Bar(long ms, decimal o, decimal h, decimal l, decimal c, long v) =>
        new() { ["time"] = ms, ["open"] = o, ["high"] = h, ["low"] = l, ["close"] = c, ["volume"] = v };

    private static string OneBar() => new JsonObject
    {
        ["status"] = true,
        ["data"] = new JsonArray(Bar(new DateTimeOffset(2026, 9, 25, 10, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds(), 25000, 25010, 24990, 25005, 6500)),
    }.ToJsonString();

    private static DhanFuturesInstrument Contract(uint id, string symbol, DateOnly expiry) => new(id, symbol, "NIFTY", expiry, "NSE_FNO", 65, 0.1m);

    private static (DhanHistoricalDataService Service, List<string> Requests) Dhan(string? withCandles = null)
    {
        var requests = new List<string>();
        var options = Options.Create(new DhanOptions { RestBaseUrl = "https://dhan.test", AccessToken = "t", ClientId = "c" });
        var api = new DhanApiClient(new HttpClient(new FakeDhan(withCandles, requests)), options, new DhanSession(options), NullLogger<DhanApiClient>.Instance);
        return (new DhanHistoricalDataService(api, new DhanDataApiRateLimiter(options, NullLogger<DhanDataApiRateLimiter>.Instance), NullLogger<DhanHistoricalDataService>.Instance), requests);
    }

    private sealed class FakeNse(HttpStatusCode status, string reply) : HttpMessageHandler
    {
        public List<JsonNode> Posts { get; } = new();

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.Method == HttpMethod.Get) return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("<html></html>") };
            var posted = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!;
            lock (Posts) Posts.Add(posted);
            return new HttpResponseMessage(status) { Content = new StringContent(reply, Encoding.UTF8, "application/json") };
        }
    }

    private sealed class FakeDhan(string? withCandles, List<string> requests) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var id = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!["securityId"]!.ToString();
            lock (requests) requests.Add(id);
            var ts = new DateTimeOffset(2026, 9, 25, 3, 45, 0, TimeSpan.Zero).ToUnixTimeSeconds();
            JsonNode json = id == withCandles
                ? new JsonObject { ["open"] = new JsonArray(1, 2), ["high"] = new JsonArray(1, 2), ["low"] = new JsonArray(1, 2), ["close"] = new JsonArray(1, 2), ["volume"] = new JsonArray(10, 20), ["timestamp"] = new JsonArray(ts, ts + 60) }
                : new JsonObject { ["open"] = new JsonArray(), ["high"] = new JsonArray(), ["low"] = new JsonArray(), ["close"] = new JsonArray(), ["volume"] = new JsonArray(), ["timestamp"] = new JsonArray() };
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json.ToJsonString(), Encoding.UTF8, "application/json") };
        }
    }
}

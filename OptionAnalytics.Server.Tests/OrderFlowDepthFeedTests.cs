using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services;
using OptionAnalytics.Server.Services.OrderFlow;

namespace OptionAnalytics.Server.Tests;

/// <summary>The Order Flow page's depth badge: which depth connection a contract is on and its state,
/// told apart from the book that has arrived (a closed market sends none).</summary>
public sealed class OrderFlowDepthFeedTests
{
    [Fact]
    public void AContractOnThe200LevelFeed_IsReportedAs200_EvenBeforeItsBookArrives()
    {
        var (service, fullDepth, _) = Create();
        Assert.True(fullDepth.Subscribe(48699, "NSE_FNO"));

        var feed = service.DepthFeedFor(48699, "NSE_FNO");

        Assert.Equal(200, feed.Levels);
        Assert.False(feed.Connected);   // not authenticated in the test - never connects
        Assert.Null(feed.LastBookAt);
    }

    // Asked for - "wherever we are using 20 level depth use 200 depth": with DepthMode "200" (the default) a contract is on
    // the 200-level feed and NEVER on the 20-level one - not when its book has not arrived (the old 90 s fallback also fired
    // before the open and at night and kept the 20-level socket all day), not on a later resolve, not for a contract the page
    // picks.
    [Fact]
    public async Task By_default_a_contract_goes_on_the_200_level_feed_and_never_the_20_level_one()
    {
        var (service, fullDepth, depth) = Create();

        Assert.Equal(200, await service.SubscribeDepthAsync(48699, "NSE_FNO", CancellationToken.None));
        // Resolved again every few minutes with no book yet (a test never connects - as before the open): still 200 only.
        Assert.Equal(200, await service.SubscribeDepthAsync(48699, "NSE_FNO", CancellationToken.None));

        Assert.NotNull(fullDepth.SubscribedAt(48699));
        Assert.False(fullDepth.IsStreaming(48699));
        Assert.False(depth.IsSubscribed(48699));
        Assert.Equal(200, service.DepthFeedFor(48699, "NSE_FNO").Levels);
    }

    [Fact]
    public async Task With_no_200_level_connection_free_a_contract_has_the_market_feeds_5_levels_not_the_20_level_feed()
    {
        var (service, _, depth) = Create();
        foreach (var id in new uint[] { 1, 2, 3 }) Assert.Equal(200, await service.SubscribeDepthAsync(id, "NSE_FNO", CancellationToken.None));

        Assert.Equal(5, await service.SubscribeDepthAsync(4, "NSE_FNO", CancellationToken.None));

        Assert.False(depth.IsSubscribed(4));
        var feed = service.DepthFeedFor(4, "NSE_FNO");
        Assert.Equal(5, feed.Levels);
        Assert.Contains("200-level connections are in use", feed.Note);
    }

    [Fact]
    public async Task Three_200_level_connections_by_default_and_the_setting_still_caps_them()
    {
        var (service, _, _) = Create();
        Assert.Equal(new[] { 200, 200, 200, 5 }, await Levels(service, 4));
        var (two, _, _) = Create(maxTwoHundred: "2");
        Assert.Equal(new[] { 200, 200, 5 }, await Levels(two, 3));

        static async Task<int[]> Levels(OrderFlowService s, int n)
        {
            var levels = new int[n];
            for (var i = 0; i < n; i++) levels[i] = await s.SubscribeDepthAsync((uint)(100 + i), "NSE_FNO", CancellationToken.None);
            return levels;
        }
    }

    [Fact]
    public async Task DepthMode_20_puts_a_contract_on_the_20_level_feed_and_5_uses_neither()
    {
        var (twenty, twentyFull, twentyDepth) = Create("20");
        Assert.Equal(20, await twenty.SubscribeDepthAsync(51714, "NSE_FNO", CancellationToken.None));
        Assert.True(twentyDepth.IsSubscribed(51714));
        Assert.Null(twentyFull.SubscribedAt(51714));
        var feed = twenty.DepthFeedFor(51714, "NSE_FNO");
        Assert.Equal(20, feed.Levels);
        Assert.Null(feed.Note);

        var (five, fiveFull, fiveDepth) = Create("5");
        Assert.Equal(5, await five.SubscribeDepthAsync(51714, "NSE_FNO", CancellationToken.None));
        Assert.False(fiveDepth.IsSubscribed(51714));
        Assert.Null(fiveFull.SubscribedAt(51714));
    }

    [Fact]
    public async Task Bse_AndDepthModeFive_AndNoConnection_Say5Levels_WithTheReason()
    {
        var (service, _, depth) = Create();
        Assert.Contains("NSE only", service.DepthFeedFor(1, "BSE_FNO").Note);
        Assert.Equal(5, await service.SubscribeDepthAsync(1, "BSE_FNO", CancellationToken.None));
        Assert.False(depth.IsSubscribed(1));
        Assert.Equal(5, service.DepthFeedFor(2, "NSE_FNO").Levels);

        var (twenty, _, _) = Create("20");
        Assert.Contains("No depth connection", twenty.DepthFeedFor(2, "NSE_FNO").Note);

        var (five, _, _) = Create("5");
        Assert.Contains("DepthMode = 5", five.DepthFeedFor(2, "NSE_FNO").Note);
    }

    [Fact]
    public void AWebSocketHandshakeFailure_IsDescribedInALine()
    {
        var error = new System.Net.WebSockets.WebSocketException("Unable to connect", new HttpRequestException("403 Forbidden"));
        Assert.Equal("Unable to connect (403 Forbidden)", DepthConnectionStatus.Describe(error));
    }

    private static (OrderFlowService Service, DhanTwoHundredDepthClient FullDepth, DhanDepthFeedClient Depth) Create(string depthMode = "200", string? maxTwoHundred = null)
    {
        var options = Options.Create(new DhanOptions { RestBaseUrl = "https://dhan.test", ClientId = "c" });
        var session = new DhanSession(options);
        var settings = new Dictionary<string, string?> { ["OrderFlow:DepthMode"] = depthMode };
        if (maxTwoHundred is not null) settings["OrderFlow:MaxTwoHundredDepth"] = maxTwoHundred;
        var config = new ConfigurationBuilder().AddInMemoryCollection(settings).Build();
        var fullDepth = new DhanTwoHundredDepthClient(options, session, NullLogger<DhanTwoHundredDepthClient>.Instance, config);
        var depth = new DhanDepthFeedClient(options, session, NullLogger<DhanDepthFeedClient>.Instance, config);
        var futures = new DhanFuturesInstrumentMaster(new HttpClient(), options, NullLogger<DhanFuturesInstrumentMaster>.Instance);
        var feed = new DhanMarketFeedClient(options, session, NullLogger<DhanMarketFeedClient>.Instance);
        var service = new OrderFlowService(futures, feed, depth, fullDepth, new LiveBroadcastBatcher(null, NullLogger<LiveBroadcastBatcher>.Instance),
            new OrderFlowDayStore(), NullLogger<OrderFlowService>.Instance, config);
        return (service, fullDepth, depth);
    }
}

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

    [Fact]
    public async Task OnlyOnThe20LevelFeed_SaysWhyNot200()
    {
        var (service, _, depth) = Create();
        Assert.True(await depth.SubscribeAsync(51714, "NSE_FNO", CancellationToken.None));

        var feed = service.DepthFeedFor(51714, "NSE_FNO");

        Assert.Equal(20, feed.Levels);
        Assert.Contains("200-level connections are in use", feed.Note);
    }

    [Fact]
    public void Bse_AndDepthModeFive_AndNoConnection_Say5Levels_WithTheReason()
    {
        var (service, _, _) = Create();
        Assert.Contains("NSE only", service.DepthFeedFor(1, "BSE_FNO").Note);
        Assert.Equal(5, service.DepthFeedFor(2, "NSE_FNO").Levels);
        Assert.Contains("No depth connection", service.DepthFeedFor(2, "NSE_FNO").Note);

        var (five, _, _) = Create("5");
        Assert.Contains("DepthMode = 5", five.DepthFeedFor(2, "NSE_FNO").Note);
    }

    // Asked for - "we need to change to 200 and fallback to 20": every contract, the nearest and one the page picked, goes on
    // the 200-level feed first; the 20-level feed is the fallback (no connection free, or no 200-level book within 90 s).

    private static readonly CancellationToken None = CancellationToken.None;

    [Fact]
    public async Task A_contract_the_page_picked_goes_on_the_200_level_feed_first()
    {
        var (service, fullDepth, depth) = Create();
        service.TrackPickedForTests(Engine(60001));

        Assert.Equal(200, await service.EnsureDepthAsync(60001, "NSE_FNO", "NIFTY next", nearest: false, DateTimeOffset.UtcNow, None));

        Assert.NotNull(fullDepth.SubscribedAt(60001));
        Assert.False(depth.IsSubscribed(60001));
        Assert.Equal(200, service.DepthFeedFor(60001, "NSE_FNO").Levels);
    }

    [Fact]
    public async Task No_200_level_connection_free_falls_back_to_the_20_level_feed()
    {
        var (service, _, depth) = Create();
        Assert.Equal(200, await service.EnsureDepthAsync(1, "NSE_FNO", "NIFTY", nearest: true, DateTimeOffset.UtcNow, None));
        Assert.Equal(200, await service.EnsureDepthAsync(2, "NSE_FNO", "BANKNIFTY", nearest: true, DateTimeOffset.UtcNow, None));
        service.TrackPickedForTests(Engine(3));

        Assert.Equal(20, await service.EnsureDepthAsync(3, "NSE_FNO", "NIFTY next", nearest: false, DateTimeOffset.UtcNow, None));

        Assert.True(depth.IsSubscribed(3));
        var feed = service.DepthFeedFor(3, "NSE_FNO");
        Assert.Equal(20, feed.Levels);
        Assert.Contains("200-level connections are in use", feed.Note);
    }

    [Fact]
    public async Task No_200_level_book_within_90_s_falls_back_to_the_20_level_feed_and_keeps_the_200_level_one()
    {
        var (service, fullDepth, depth) = Create();
        var start = DateTimeOffset.UtcNow;
        Assert.Equal(200, await service.EnsureDepthAsync(1, "NSE_FNO", "NIFTY", nearest: true, start, None));
        Assert.Equal(200, await service.EnsureDepthAsync(1, "NSE_FNO", "NIFTY", nearest: true, start.AddSeconds(80), None));
        Assert.False(depth.IsSubscribed(1));

        Assert.Equal(20, await service.EnsureDepthAsync(1, "NSE_FNO", "NIFTY", nearest: true, start.AddSeconds(100), None));

        Assert.True(depth.IsSubscribed(1));
        Assert.NotNull(fullDepth.SubscribedAt(1));   // still on the 200-level feed - its book is used again once it streams
        var feed = service.DepthFeedFor(1, "NSE_FNO");
        Assert.Equal(20, feed.Levels);
        Assert.Contains("200-level not streaming", feed.Note);

        // The same for a contract the page picked.
        service.TrackPickedForTests(Engine(7));
        Assert.Equal(200, await service.EnsureDepthAsync(7, "NSE_FNO", "NIFTY next", nearest: false, start, None));
        Assert.Equal(20, await service.EnsureDepthAsync(7, "NSE_FNO", "NIFTY next", nearest: false, start.AddSeconds(100), None));
        Assert.True(depth.IsSubscribed(7));
    }

    [Fact]
    public async Task A_nearest_contract_with_no_connection_free_takes_one_from_a_picked_contract_which_falls_back_to_20()
    {
        var (service, fullDepth, depth) = Create();
        service.TrackPickedForTests(Engine(10));
        service.TrackPickedForTests(Engine(11));
        Assert.Equal(200, await service.EnsureDepthAsync(10, "NSE_FNO", "NIFTY next", nearest: false, DateTimeOffset.UtcNow, None));
        Assert.Equal(200, await service.EnsureDepthAsync(11, "NSE_FNO", "NIFTY far", nearest: false, DateTimeOffset.UtcNow, None));

        Assert.Equal(200, await service.EnsureDepthAsync(1, "NSE_FNO", "NIFTY", nearest: true, DateTimeOffset.UtcNow, None));

        Assert.NotNull(fullDepth.SubscribedAt(1));
        var gaveUp = new uint[] { 10, 11 }.Single(id => fullDepth.SubscribedAt(id) is null);
        Assert.True(depth.IsSubscribed(gaveUp));
        Assert.Equal(20, service.DepthFeedFor(gaveUp, "NSE_FNO").Levels);
        // A picked contract never takes one from another.
        service.TrackPickedForTests(Engine(12));
        Assert.Equal(20, await service.EnsureDepthAsync(12, "NSE_FNO", "NIFTY far 2", nearest: false, DateTimeOffset.UtcNow, None));
    }

    [Fact]
    public async Task DepthMode_20_uses_the_20_level_feed_and_5_neither_and_BSE_stays_on_5()
    {
        var (twenty, twentyFull, twentyDepth) = Create("20");
        Assert.Equal(20, await twenty.EnsureDepthAsync(1, "NSE_FNO", "NIFTY", nearest: true, DateTimeOffset.UtcNow, None));
        Assert.True(twentyDepth.IsSubscribed(1));
        Assert.Null(twentyFull.SubscribedAt(1));

        var (five, fiveFull, fiveDepth) = Create("5");
        Assert.Equal(5, await five.EnsureDepthAsync(1, "NSE_FNO", "NIFTY", nearest: true, DateTimeOffset.UtcNow, None));
        Assert.False(fiveDepth.IsSubscribed(1));
        Assert.Null(fiveFull.SubscribedAt(1));

        var (service, _, depth) = Create();
        Assert.Equal(5, await service.EnsureDepthAsync(9, "BSE_FNO", "SENSEX", nearest: true, DateTimeOffset.UtcNow, None));
        Assert.False(depth.IsSubscribed(9));
    }

    private static OrderFlowEngine Engine(uint securityId) => new("NIFTY", securityId, $"NIFTY-{securityId}-FUT", "NSE_FNO", 0.05m, 75);

    [Fact]
    public void AWebSocketHandshakeFailure_IsDescribedInALine()
    {
        var error = new System.Net.WebSockets.WebSocketException("Unable to connect", new HttpRequestException("403 Forbidden"));
        Assert.Equal("Unable to connect (403 Forbidden)", DepthConnectionStatus.Describe(error));
    }

    private static (OrderFlowService Service, DhanTwoHundredDepthClient FullDepth, DhanDepthFeedClient Depth) Create(string depthMode = "200")
    {
        var options = Options.Create(new DhanOptions { RestBaseUrl = "https://dhan.test", ClientId = "c" });
        var session = new DhanSession(options);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["OrderFlow:DepthMode"] = depthMode }).Build();
        var fullDepth = new DhanTwoHundredDepthClient(options, session, NullLogger<DhanTwoHundredDepthClient>.Instance, config);
        var depth = new DhanDepthFeedClient(options, session, NullLogger<DhanDepthFeedClient>.Instance, config);
        var futures = new DhanFuturesInstrumentMaster(new HttpClient(), options, NullLogger<DhanFuturesInstrumentMaster>.Instance);
        var feed = new DhanMarketFeedClient(options, session, NullLogger<DhanMarketFeedClient>.Instance);
        var service = new OrderFlowService(futures, feed, depth, fullDepth, new LiveBroadcastBatcher(null, NullLogger<LiveBroadcastBatcher>.Instance),
            new OrderFlowDayStore(), NullLogger<OrderFlowService>.Instance, config);
        return (service, fullDepth, depth);
    }
}

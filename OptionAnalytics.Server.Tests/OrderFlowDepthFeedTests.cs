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

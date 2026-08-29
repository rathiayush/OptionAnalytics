using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Services;

/// <summary>Owns the single Dhan WS connection's run loop. SpotFeedHostedService and
/// CdvHostedService both subscribe/unsubscribe tokens on the shared DhanMarketFeedClient singleton
/// rather than each driving their own connection - kept as its own tiny hosted service so neither
/// of them has to also own the connection's lifecycle.</summary>
public sealed class DhanMarketFeedHostedService : BackgroundService
{
    private readonly DhanMarketFeedClient _feedClient;

    public DhanMarketFeedHostedService(DhanMarketFeedClient feedClient)
    {
        _feedClient = feedClient;
    }

    protected override Task ExecuteAsync(CancellationToken stoppingToken) => _feedClient.RunAsync(stoppingToken);

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await _feedClient.DisposeAsync();
        await base.StopAsync(cancellationToken);
    }
}

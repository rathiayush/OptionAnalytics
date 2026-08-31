using OptionAnalytics.Server.Storage;

namespace OptionAnalytics.Server.Services;

/// <summary>Persists every closed 1-minute bar to TimescaleDB as it happens, via
/// SpotUnderlyingState.BarClosed - the write-side counterpart to CandleRepository.GetCandlesAsync,
/// which SpotFeedHostedService reads from on startup to warm state without hitting Dhan's REST API
/// first. A no-op (after logging once) if CandleStorage isn't configured or unreachable - see
/// CandleRepository's doc comment.</summary>
public sealed class CandlePersistenceService : BackgroundService
{
    private readonly SpotFeedHostedService _spotFeed;
    private readonly CandleRepository _repository;

    public CandlePersistenceService(SpotFeedHostedService spotFeed, CandleRepository repository)
    {
        _spotFeed = spotFeed;
        _repository = repository;
    }

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_repository.IsConfigured) return Task.CompletedTask;

        foreach (var state in _spotFeed.States.Values)
        {
            var underlying = state.Underlying;
            state.BarClosed += candle => _ = _repository.SaveCandleAsync(underlying, candle, stoppingToken);
        }

        return Task.CompletedTask;
    }
}

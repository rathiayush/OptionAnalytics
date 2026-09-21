namespace NiftyDataCollector.Dhan;

/// <summary>
/// Centralizes every pause this collector inserts before a Dhan call, instead of scattering
/// ad-hoc Task.Delay calls through the fetch loops the way OptionAnalytics.Server's own classes
/// each do independently (DhanOptionChainQuotes' own MinimumCallSpacing, CdvHostedService's own
/// BackfillCallDelay, ExpiredOptionBacktestService's own BandFetchDelay - three different constants
/// in three different files, each guarding a different endpoint). One place, two named budgets:
///
///   OptionChain - Dhan's documented "one unique request every 3 seconds" for BOTH
///   /optionchain and /optionchain/expirylist (confirmed against Dhan's own docs - the same limit
///   OptionAnalytics.Server's DhanOptionChainQuotes independently arrived at, here with a slightly
///   wider margin since this collector has no in-process cache absorbing repeat calls the way a
///   dashboard's picker does).
///
///   HistoricalData - Dhan's docs state no explicit per-second cap for /charts/intraday, but
///   OptionAnalytics.Server's own production-validated pacing (CdvHostedService.BackfillCallDelay)
///   uses 200ms between calls fetching dozens of per-strike option histories in a loop - reused
///   here verbatim rather than guessing a new number, since that value has already survived real
///   traffic against this exact endpoint.
///
/// Each budget is a simple "wait until at least this long since the last call in this budget"
/// gate, serialized per budget (SemaphoreSlim(1,1)) so concurrent callers queue rather than burst.
/// </summary>
public sealed class DhanRateLimiter
{
    private static readonly TimeSpan OptionChainSpacing = TimeSpan.FromSeconds(3.5);
    private static readonly TimeSpan HistoricalDataSpacing = TimeSpan.FromMilliseconds(200);

    private readonly SemaphoreSlim _optionChainGate = new(1, 1);
    private readonly SemaphoreSlim _historicalDataGate = new(1, 1);
    private DateTimeOffset _lastOptionChainCallAt = DateTimeOffset.MinValue;
    private DateTimeOffset _lastHistoricalDataCallAt = DateTimeOffset.MinValue;

    public Task WaitForOptionChainSlotAsync(CancellationToken cancellationToken) =>
        WaitAsync(_optionChainGate, () => _lastOptionChainCallAt, t => _lastOptionChainCallAt = t, OptionChainSpacing, cancellationToken);

    public Task WaitForHistoricalDataSlotAsync(CancellationToken cancellationToken) =>
        WaitAsync(_historicalDataGate, () => _lastHistoricalDataCallAt, t => _lastHistoricalDataCallAt = t, HistoricalDataSpacing, cancellationToken);

    private static async Task WaitAsync(
        SemaphoreSlim gate, Func<DateTimeOffset> getLastCallAt, Action<DateTimeOffset> setLastCallAt, TimeSpan spacing, CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            var sinceLastCall = DateTimeOffset.UtcNow - getLastCallAt();
            if (sinceLastCall < spacing)
                await Task.Delay(spacing - sinceLastCall, cancellationToken);

            setLastCallAt(DateTimeOffset.UtcNow);
        }
        finally
        {
            gate.Release();
        }
    }
}

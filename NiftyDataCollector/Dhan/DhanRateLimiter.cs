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
///   RollingOption - Dhan's own documented cap for its Data APIs (which /charts/rollingoption
///   falls under) is "5 requests/second" - 250ms spacing here leaves a small margin.
///
/// Each budget is a simple "wait until at least this long since the last call in this budget"
/// gate, serialized per budget (SemaphoreSlim(1,1)) so concurrent callers queue rather than burst.
///
/// ON TOP OF the per-budget spacing above, DhanApiClient calls WaitForDailyBudgetAsync before
/// EVERY Dhan REST call regardless of which budget it belongs to - Dhan's own documented cap for
/// Data APIs is "7,000 requests/day". A rolling-option backfill spanning years can easily run into
/// the thousands of calls (StrikesEachSide=10 means 21 strikes x 2 legs = 42 series, each needing
/// several 30-day chunks per year of history), so this tracks a sliding 24h window of every call
/// this process makes and DELAYS (never drops) once the configured ceiling is hit, logging clearly
/// - safer than letting the process find out the hard way that Dhan started rejecting calls.
/// </summary>
public sealed class DhanRateLimiter
{
    private static readonly TimeSpan OptionChainSpacing = TimeSpan.FromSeconds(3.5);
    private static readonly TimeSpan HistoricalDataSpacing = TimeSpan.FromMilliseconds(200);
    private static readonly TimeSpan RollingOptionSpacing = TimeSpan.FromMilliseconds(250);
    private static readonly TimeSpan DailyBudgetWindow = TimeSpan.FromHours(24);

    /// <summary>Dhan's own documented daily cap for Data APIs. Left a little headroom under the
    /// stated 7,000 in case other, non-Data Dhan calls this process makes (auth, order-related -
    /// none today, but future-proofing) share the same budget in practice.</summary>
    private const int DailyBudgetCeiling = 6500;

    private readonly SemaphoreSlim _optionChainGate = new(1, 1);
    private readonly SemaphoreSlim _historicalDataGate = new(1, 1);
    private readonly SemaphoreSlim _rollingOptionGate = new(1, 1);
    private readonly SemaphoreSlim _dailyBudgetGate = new(1, 1);
    private DateTimeOffset _lastOptionChainCallAt = DateTimeOffset.MinValue;
    private DateTimeOffset _lastHistoricalDataCallAt = DateTimeOffset.MinValue;
    private DateTimeOffset _lastRollingOptionCallAt = DateTimeOffset.MinValue;
    private readonly Queue<DateTimeOffset> _dailyCallLog = new();

    public Task WaitForOptionChainSlotAsync(CancellationToken cancellationToken) =>
        WaitAsync(_optionChainGate, () => _lastOptionChainCallAt, t => _lastOptionChainCallAt = t, OptionChainSpacing, cancellationToken);

    public Task WaitForHistoricalDataSlotAsync(CancellationToken cancellationToken) =>
        WaitAsync(_historicalDataGate, () => _lastHistoricalDataCallAt, t => _lastHistoricalDataCallAt = t, HistoricalDataSpacing, cancellationToken);

    public Task WaitForRollingOptionSlotAsync(CancellationToken cancellationToken) =>
        WaitAsync(_rollingOptionGate, () => _lastRollingOptionCallAt, t => _lastRollingOptionCallAt = t, RollingOptionSpacing, cancellationToken);

    /// <summary>Called by DhanApiClient before every single Dhan REST call, regardless of which
    /// per-endpoint budget above it also goes through - see this class' own doc comment.</summary>
    public async Task WaitForDailyBudgetAsync(ILogger logger, CancellationToken cancellationToken)
    {
        await _dailyBudgetGate.WaitAsync(cancellationToken);
        try
        {
            while (true)
            {
                var cutoff = DateTimeOffset.UtcNow - DailyBudgetWindow;
                while (_dailyCallLog.Count > 0 && _dailyCallLog.Peek() < cutoff) _dailyCallLog.Dequeue();

                if (_dailyCallLog.Count < DailyBudgetCeiling) break;

                var waitFor = _dailyCallLog.Peek() + DailyBudgetWindow - DateTimeOffset.UtcNow;
                logger.LogWarning(
                    "Dhan's daily call budget ({Ceiling}/24h, a safety margin under Dhan's own documented 7,000/day cap for Data APIs) is exhausted - " +
                    "pausing {Minutes:F1} minute(s) rather than risking Dhan starting to reject calls outright.",
                    DailyBudgetCeiling, Math.Max(0, waitFor.TotalMinutes));
                if (waitFor > TimeSpan.Zero) await Task.Delay(waitFor, cancellationToken);
            }

            _dailyCallLog.Enqueue(DateTimeOffset.UtcNow);
        }
        finally
        {
            _dailyBudgetGate.Release();
        }
    }

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

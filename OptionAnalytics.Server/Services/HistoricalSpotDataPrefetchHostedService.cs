using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Runs once per deployment (see HistoricalSpotDataStore.HasCompleteData) to fetch the last
/// ~6 calendar months of NIFTY/BANKNIFTY 1-minute spot candles from Dhan and cache them to disk, so
/// ExpiredOptionBacktestService's spot fetch (today, always live) can read straight from that cache
/// instead of hitting Dhan on every single run.
///
/// Deliberately spot-only, not the option premium side too: the rolling-option endpoint
/// ExpiredOptionBacktestService uses for CE/PE premium only ever accepts a RELATIVE "ATM+-K" token
/// (see that class's own top-of-file doc comment), and which absolute strike that resolves to on
/// any given day depends on where spot itself was trading that day - so caching "a year of option
/// premium" would mean pre-fetching every relative token in a wide band for every single day of the
/// year, for both expiry cadences, an order of magnitude more Dhan calls than this app has ever made
/// in one run. Spot has no such problem (one absolute series, the same request shape
/// SpotFeedHostedService already trusts) and is what every strategy's own signal generation reads
/// regardless of strategy, so it is the part worth caching first.
///
/// "Runs only once" is enforced by HasCompleteData, not by some in-memory once-per-process flag - a
/// container restart before this ever finished (killed mid-fetch, Dhan not authenticated yet) tries
/// again from scratch next boot, since no meta file was written; a restart AFTER it finished is a
/// pure no-op two file reads.
///
/// Off by default (see HistoricalDataPrefetchOptions.Enabled) - 6 months of NIFTY/BANKNIFTY history
/// is real Dhan traffic, so a deployment opts into paying for it explicitly (HistoricalDataPrefetch__Enabled=true)
/// rather than it running automatically the moment Dhan credentials exist.
/// </summary>
public sealed class HistoricalSpotDataPrefetchHostedService : BackgroundService
{
    /// <summary>The two underlyings the user asked for by name ("both index") - not SENSEX, which
    /// ExpiredOptionBacktestService's own StrikeStepByUnderlying already excludes from this whole
    /// feature (Dhan's rolling-option docs only ever document NSE_FNO, never a BSE segment).</summary>
    private static readonly string[] Underlyings = { "NIFTY", "BANKNIFTY" };

    /// <summary>How far back to cache, in calendar days - "last 6 months", the user's own words
    /// (originally a full year; narrowed down once the option side's own equivalent window was
    /// narrowed too, to keep both prefetch jobs covering the same span).</summary>
    private const int LookbackCalendarDays = 182;

    /// <summary>Per-request window size, comfortably under Dhan's documented 90-day-per-request cap
    /// for /charts/intraday (see HistoryWindow's own doc comment) - a year needs 5 of these rather
    /// than 1, each individually paced (see ChunkDelay) instead of bursting Dhan back to back.</summary>
    private const int ChunkCalendarDays = 80;

    /// <summary>Pacing between successive chunk fetches, and between the two underlyings - the same
    /// rate-limiting idea ExpiredOptionBacktestService's own BandFetchDelay already uses for its
    /// per-token loop, applied here since this job's own chunk loop is the same shape (several
    /// sequential /charts/intraday calls that must not burst).</summary>
    private static readonly TimeSpan ChunkDelay = TimeSpan.FromMilliseconds(500);

    /// <summary>How long to wait for TOTP auto-login before attempting the prefetch anyway - same
    /// value and same reasoning as SpotFeedHostedService's own AuthWaitTimeout: DhanTotpAutoRenewalHostedService's
    /// retry can itself take a couple of minutes on a cold start.</summary>
    private static readonly TimeSpan AuthWaitTimeout = TimeSpan.FromMinutes(3);

    private readonly DhanOptions _options;
    private readonly HistoricalDataPrefetchOptions _prefetchOptions;
    private readonly DhanSession _session;
    private readonly DhanSpotInstrumentMaster _instrumentMaster;
    private readonly DhanHistoricalDataService _historicalData;
    private readonly HistoricalSpotDataStore _store;
    private readonly ILogger<HistoricalSpotDataPrefetchHostedService> _logger;

    public HistoricalSpotDataPrefetchHostedService(
        IOptions<DhanOptions> options,
        IOptions<HistoricalDataPrefetchOptions> prefetchOptions,
        DhanSession session,
        DhanSpotInstrumentMaster instrumentMaster,
        DhanHistoricalDataService historicalData,
        HistoricalSpotDataStore store,
        ILogger<HistoricalSpotDataPrefetchHostedService> logger)
    {
        _options = options.Value;
        _prefetchOptions = prefetchOptions.Value;
        _session = session;
        _instrumentMaster = instrumentMaster;
        _historicalData = historicalData;
        _store = store;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Off by default (see HistoricalDataPrefetchOptions) - set HistoricalDataPrefetch__Enabled=true
        // to opt a deployment into this one-time download.
        if (!_prefetchOptions.Enabled)
        {
            _logger.LogInformation("Historical spot prefetch is disabled (HistoricalDataPrefetch:Enabled=false) - skipping.");
            return;
        }

        var today = IstClock.Today();
        var requiredFromDay = today.AddDays(-LookbackCalendarDays);

        if (Underlyings.All(u => _store.HasCompleteData(u, requiredFromDay, today)))
        {
            _logger.LogInformation("Historical spot cache already covers the last {Days} day(s) for {Underlyings} - nothing to prefetch.", LookbackCalendarDays, string.Join(", ", Underlyings));
            return;
        }

        if (!_options.HasSession && !_options.HasTotpCredentials)
        {
            _logger.LogWarning("Skipping the one-time historical spot prefetch - neither Dhan:AccessToken nor Dhan:Pin/Dhan:TotpSecret are configured. It will retry on the next deployment.");
            return;
        }

        if (_options.HasTotpCredentials)
        {
            var waited = TimeSpan.Zero;
            while (!_session.IsAuthenticated && waited < AuthWaitTimeout && !stoppingToken.IsCancellationRequested)
            {
                await Task.Delay(500, stoppingToken);
                waited += TimeSpan.FromMilliseconds(500);
            }
        }

        try
        {
            await _instrumentMaster.EnsureLoadedAsync(stoppingToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "Could not load the Dhan scrip master - the one-time historical spot prefetch cannot resolve NIFTY/BANKNIFTY yet. It will retry on the next deployment.");
            return;
        }

        var isFirst = true;
        foreach (var underlying in Underlyings)
        {
            if (stoppingToken.IsCancellationRequested) return;

            if (_store.HasCompleteData(underlying, requiredFromDay, today))
            {
                _logger.LogInformation("Historical spot cache already covers {Underlying} - skipping it.", underlying);
                continue;
            }

            if (!isFirst) await Task.Delay(ChunkDelay, stoppingToken);
            isFirst = false;

            try
            {
                await PrefetchUnderlyingAsync(underlying, requiredFromDay, today, stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // One underlying failing (a transient Dhan hiccup, a rate limit) must not stop the
                // other from being cached, and must not take the whole host down with it - the
                // BackgroundService default behavior on an unhandled exception. It simply retries on
                // the next deployment, same as a container killed mid-fetch.
                _logger.LogError(ex, "One-time historical spot prefetch FAILED for {Underlying} - it will retry on the next deployment.", underlying);
            }
        }
    }

    private async Task PrefetchUnderlyingAsync(string underlying, DateOnly fromDay, DateOnly toDay, CancellationToken cancellationToken)
    {
        var instrument = _instrumentMaster.FindSpot(underlying);
        if (instrument is null)
        {
            _logger.LogWarning("Could not resolve {Underlying}'s Dhan security id - skipping its one-time historical spot prefetch. It will retry on the next deployment.", underlying);
            return;
        }

        _logger.LogInformation("Starting one-time historical spot prefetch for {Underlying}: {From}..{To} ({Days} day(s), chunked and paced).", underlying, fromDay, toDay, toDay.DayNumber - fromDay.DayNumber);

        var all = new List<CandleWithVolume>();
        var chunkStart = fromDay;
        var isFirstChunk = true;

        while (chunkStart <= toDay)
        {
            if (!isFirstChunk) await Task.Delay(ChunkDelay, cancellationToken);
            isFirstChunk = false;

            var chunkEnd = MinDate(chunkStart.AddDays(ChunkCalendarDays - 1), toDay);

            var (candles, error) = await _historicalData.GetIntradayCandlesAsync(instrument.SecurityId, instrument.DhanSegment, chunkStart, chunkEnd, 1, cancellationToken, interactive: false);
            if (error is not null)
                _logger.LogWarning("Historical spot prefetch chunk {From}..{To} for {Underlying} returned an error (continuing with the rest): {Error}", chunkStart, chunkEnd, underlying, error);

            all.AddRange(candles);
            chunkStart = chunkEnd.AddDays(1);
        }

        var ordered = all.OrderBy(c => c.Time).ToList();
        if (ordered.Count == 0)
        {
            _logger.LogWarning("One-time historical spot prefetch for {Underlying} returned NO candles across the whole {From}..{To} window - not caching anything. It will retry on the next deployment.", underlying, fromDay, toDay);
            return;
        }

        await _store.SaveAsync(underlying, fromDay, toDay, ordered, cancellationToken);
    }

    private static DateOnly MinDate(DateOnly a, DateOnly b) => a < b ? a : b;
}

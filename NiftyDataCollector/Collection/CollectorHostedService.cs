using Microsoft.Extensions.Options;
using NiftyDataCollector.Db;
using NiftyDataCollector.Dhan;

namespace NiftyDataCollector.Collection;

/// <summary>
/// The whole collector: resolve NIFTY, track its nearest expiry(ies), and on each cycle -
///
///   1. Poll the LIVE option chain for the tracked expiry (one rate-limited call covers every
///      strike at once) - this is the only source for IV/greeks/OI/volume, all of which are
///      live-only in Dhan's API (see DhanOptionChainClient's own doc comment).
///   2. From that same call's own underlying last_price, compute ATM (rounded to StrikeStep) and
///      save the live snapshot for every strike within StrikesEachSide of it.
///   3. For each of those strikes' CE/PE contracts (and for spot), backfill/refresh 1-minute OHLC
///      history via the historical intraday endpoint - real, replayable history, unlike step 1.
///      A contract already backfilled today is only asked for bars since its own last saved time,
///      not re-fetched from scratch every cycle.
///
/// Runs forever until cancelled, sleeping SnapshotPollIntervalSeconds between cycles. A single bad
/// cycle (a transient Dhan error, one contract's history failing) never stops the loop - see the
/// per-step try/catch below - so a restart is never required to recover from routine flakiness.
/// </summary>
public sealed class CollectorHostedService : BackgroundService
{
    /// <summary>How long to give DhanTotpAutoRenewalHostedService a head start before this
    /// service's own first Dhan call, when TOTP is configured - without this, the two hosted
    /// services start concurrently and the collector's first /optionchain/expirylist call can race
    /// ahead of login finishing, sending an empty access-token and getting back Dhan's own
    /// "Access token is invalid" rather than a clean "not authenticated yet". Purely a startup
    /// nicety: if login is still slow after this (a rate-limit cooldown, a genuine lockout), this
    /// service proceeds anyway and its own per-cycle error handling absorbs the resulting failures
    /// exactly as it always did, recovering on a later cycle once auth actually succeeds.</summary>
    private static readonly TimeSpan AuthWaitTimeout = TimeSpan.FromSeconds(15);

    private readonly DhanSpotInstrumentMaster _spotMaster;
    private readonly DhanOptionChainClient _optionChain;
    private readonly DhanHistoricalDataClient _historicalData;
    private readonly DhanRateLimiter _rateLimiter;
    private readonly TimescaleWriter _writer;
    private readonly DhanSession _session;
    private readonly DhanOptions _dhanOptions;
    private readonly CollectorOptions _options;
    private readonly ILogger<CollectorHostedService> _logger;

    /// <summary>(underlying-side security id, day) already backfilled - so a cycle only ever
    /// fetches a NEW contract's full BackfillDays window once, and every later cycle that same day
    /// just tops up whatever bars have printed since.</summary>
    private readonly HashSet<(long SecurityId, DateOnly Day)> _backfilledToday = new();
    private readonly Dictionary<long, DateTimeOffset> _lastBarTimeBySecurityId = new();

    public CollectorHostedService(
        DhanSpotInstrumentMaster spotMaster, DhanOptionChainClient optionChain, DhanHistoricalDataClient historicalData,
        DhanRateLimiter rateLimiter, TimescaleWriter writer, DhanSession session, IOptions<DhanOptions> dhanOptions,
        IOptions<CollectorOptions> options, ILogger<CollectorHostedService> logger)
    {
        _spotMaster = spotMaster;
        _optionChain = optionChain;
        _historicalData = historicalData;
        _rateLimiter = rateLimiter;
        _writer = writer;
        _session = session;
        _dhanOptions = dhanOptions.Value;
        _options = options.Value;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await _writer.EnsureSchemaAsync(stoppingToken);

        var nifty = await _spotMaster.ResolveNiftyAsync(stoppingToken);
        _logger.LogInformation("NiftyDataCollector starting - NIFTY securityId={Id}, segment={Segment}, strikeStep={Step}, strikesEachSide={N}, backfillDays={Days}.",
            nifty.SecurityId, nifty.DhanSegment, _options.StrikeStep, _options.StrikesEachSide, _options.BackfillDays);

        if (_dhanOptions.HasTotpCredentials)
        {
            var waited = TimeSpan.Zero;
            while (!_session.IsAuthenticated && waited < AuthWaitTimeout && !stoppingToken.IsCancellationRequested)
            {
                await Task.Delay(500, stoppingToken);
                waited += TimeSpan.FromMilliseconds(500);
            }
            if (!_session.IsAuthenticated)
                _logger.LogInformation("Still waiting on Dhan TOTP login after {Seconds}s - proceeding anyway; the first cycle may fail and recover on the next one once login succeeds.", AuthWaitTimeout.TotalSeconds);
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            var cycleStart = DateTimeOffset.UtcNow;
            try
            {
                await RunOneCycleAsync(nifty, stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "Collector cycle failed - will retry next cycle rather than stopping.");
            }

            var elapsed = DateTimeOffset.UtcNow - cycleStart;
            var remaining = TimeSpan.FromSeconds(_options.SnapshotPollIntervalSeconds) - elapsed;
            if (remaining > TimeSpan.Zero) await Task.Delay(remaining, stoppingToken);
        }
    }

    private async Task RunOneCycleAsync(DhanSpotInstrument nifty, CancellationToken cancellationToken)
    {
        var today = IstClock.Today();
        var fromDay = today.AddDays(-_options.BackfillDays);

        // ---- Spot OHLC history --------------------------------------------------------------
        try
        {
            await RefreshSpotBarsAsync(nifty, fromDay, today, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Spot bar refresh failed this cycle.");
        }

        // ---- Tracked expiries ----------------------------------------------------------------
        await _rateLimiter.WaitForOptionChainSlotAsync(cancellationToken);
        var expiries = await _optionChain.GetExpiriesAsync(nifty.SecurityId, nifty.DhanSegment, cancellationToken);
        if (expiries.Count == 0)
        {
            _logger.LogWarning("No expiries returned for NIFTY this cycle - skipping option-side work.");
            return;
        }

        foreach (var expiry in expiries.Take(_options.TrackedExpiryCount))
        {
            try
            {
                await RunExpiryAsync(nifty, expiry, fromDay, today, cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "Expiry {Expiry} failed this cycle - continuing with any other tracked expiries.", expiry);
            }
        }
    }

    private async Task RefreshSpotBarsAsync(DhanSpotInstrument nifty, DateOnly fromDay, DateOnly today, CancellationToken cancellationToken)
    {
        var key = (SecurityId: (long)nifty.SecurityId, Day: today);
        var effectiveFrom = _backfilledToday.Contains(key) ? today : fromDay;

        await _rateLimiter.WaitForHistoricalDataSlotAsync(cancellationToken);
        var (bars, error) = await _historicalData.GetSpotIntradayAsync(nifty.SecurityId, nifty.DhanSegment, effectiveFrom, today, 1, cancellationToken);
        if (error is not null) { _logger.LogDebug("Spot bar fetch error: {Error}", error); return; }

        var saved = await _writer.SaveSpotBarsAsync("NIFTY", bars, cancellationToken);
        _backfilledToday.Add(key);
        if (saved > 0) _logger.LogInformation("Saved {Count} NIFTY spot bar(s) ({From}..{To}).", saved, effectiveFrom, today);
    }

    private async Task RunExpiryAsync(DhanSpotInstrument nifty, DateOnly expiry, DateOnly fromDay, DateOnly today, CancellationToken cancellationToken)
    {
        await _rateLimiter.WaitForOptionChainSlotAsync(cancellationToken);
        var chain = await _optionChain.GetChainAsync(nifty.SecurityId, nifty.DhanSegment, expiry, cancellationToken);
        if (chain is null || chain.Strikes.Count == 0)
        {
            _logger.LogWarning("Empty option chain for NIFTY {Expiry} this cycle.", expiry);
            return;
        }

        var spotPrice = chain.UnderlyingLastPrice;
        var capturedAt = DateTimeOffset.UtcNow;

        if (spotPrice is not { } spot)
        {
            _logger.LogWarning("Option chain for {Expiry} returned no underlying last_price - cannot compute ATM this cycle.", expiry);
            return;
        }

        var atm = Math.Round(spot / _options.StrikeStep) * _options.StrikeStep;
        var lowStrike = atm - _options.StrikesEachSide * _options.StrikeStep;
        var highStrike = atm + _options.StrikesEachSide * _options.StrikeStep;
        var band = chain.Strikes.Where(s => s.Strike >= lowStrike && s.Strike <= highStrike).ToList();

        var snapshotRows = await _writer.SaveOptionChainSnapshotAsync("NIFTY", expiry, capturedAt, spotPrice, band, cancellationToken);
        _logger.LogInformation("NIFTY {Expiry}: ATM={Atm}, saved {Rows} live snapshot row(s) for strikes [{Low}-{High}].",
            expiry, atm, snapshotRows, lowStrike, highStrike);

        foreach (var strike in band)
        {
            foreach (var (isCall, leg) in new[] { (true, strike.Ce), (false, strike.Pe) })
            {
                if (leg is null || leg.SecurityId <= 0) continue;
                try
                {
                    await RefreshOptionBarsAsync(expiry, strike.Strike, isCall, leg.SecurityId, nifty.DhanSegment, fromDay, today, cancellationToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.LogDebug(ex, "Option bar refresh failed for {Expiry} {Strike}{Side}.", expiry, strike.Strike, isCall ? "CE" : "PE");
                }
            }
        }
    }

    private async Task RefreshOptionBarsAsync(
        DateOnly expiry, decimal strike, bool isCall, long securityId, string dhanSegment, DateOnly fromDay, DateOnly today, CancellationToken cancellationToken)
    {
        var key = (SecurityId: securityId, Day: today);
        var effectiveFrom = _backfilledToday.Contains(key) ? today : fromDay;

        await _rateLimiter.WaitForHistoricalDataSlotAsync(cancellationToken);
        var (bars, error) = await _historicalData.GetOptionIntradayAsync((uint)securityId, dhanSegment, effectiveFrom, today, 1, cancellationToken);
        if (error is not null) return; // routine for a strike that hasn't traded yet/at all - not logged at Info to avoid noise every cycle

        var saved = await _writer.SaveOptionBarsAsync("NIFTY", expiry, strike, isCall, securityId, bars, cancellationToken);
        _backfilledToday.Add(key);
        if (bars.Count > 0) _lastBarTimeBySecurityId[securityId] = bars[^1].Time;
        if (saved > 0)
            _logger.LogDebug("Saved {Count} bar(s) for {Expiry} {Strike}{Side} ({From}..{To}).", saved, expiry, strike, isCall ? "CE" : "PE", effectiveFrom, today);
    }
}

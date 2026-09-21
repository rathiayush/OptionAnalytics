using System.Globalization;
using Microsoft.Extensions.Options;
using NiftyDataCollector.Db;
using NiftyDataCollector.Dhan;

namespace NiftyDataCollector.Collection;

/// <summary>
/// The whole collector: resolve each configured underlying (NIFTY, BANKNIFTY, ... - see
/// CollectorOptions.Underlyings) and track its nearest expiry(ies), and on each cycle, per
/// underlying -
///
///   1. Poll the LIVE option chain for the tracked expiry (one rate-limited call covers every
///      strike at once) - this is the only source for IV/greeks/OI/volume, all of which are
///      live-only in Dhan's API (see DhanOptionChainClient's own doc comment).
///   2. From that same call's own underlying last_price, compute ATM (rounded to that underlying's
///      own StrikeStep) and save the live snapshot for every strike within StrikesEachSide of it.
///   3. For each of those strikes' CE/PE contracts (and for spot), backfill/refresh 1-minute OHLC
///      history via the historical intraday endpoint - real, replayable history, unlike step 1.
///      Resumes from that security's own CHECKPOINT (backfill_progress table - see
///      DhanHistoricalDataClient and TimescaleWriter's own doc comments) rather than re-fetching
///      the whole BackfillDays window every cycle, or redoing it all after a partial failure.
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

        var tracked = new List<(DhanSpotInstrument Instrument, TrackedUnderlying Config)>();
        foreach (var underlying in _options.Underlyings)
        {
            var instrument = await _spotMaster.ResolveAsync(underlying.Name, stoppingToken);
            tracked.Add((instrument, underlying));
            _logger.LogInformation(
                "NiftyDataCollector tracking {Underlying} - securityId={Id}, segment={Segment}, strikeStep={Step}, strikesEachSide={N}, backfillDays={Days}.",
                underlying.Name, instrument.SecurityId, instrument.DhanSegment, underlying.StrikeStep, _options.StrikesEachSide, _options.BackfillDays);
        }

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

            foreach (var (instrument, config) in tracked)
            {
                try
                {
                    await RunOneCycleAsync(instrument, config, stoppingToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.LogError(ex, "Collector cycle failed for {Underlying} - will retry next cycle rather than stopping.", config.Name);
                }
            }

            var elapsed = DateTimeOffset.UtcNow - cycleStart;
            var remaining = TimeSpan.FromSeconds(_options.SnapshotPollIntervalSeconds) - elapsed;
            if (remaining > TimeSpan.Zero) await Task.Delay(remaining, stoppingToken);
        }
    }

    private async Task RunOneCycleAsync(DhanSpotInstrument instrument, TrackedUnderlying config, CancellationToken cancellationToken)
    {
        var today = IstClock.Today();
        var fromDay = _options.BackfillFromDate ?? today.AddDays(-_options.BackfillDays);

        // ---- Spot OHLC history --------------------------------------------------------------
        try
        {
            await RefreshSpotBarsAsync(instrument, config.Name, fromDay, today, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "{Underlying} spot bar refresh failed this cycle.", config.Name);
        }

        // ---- Tracked expiries ----------------------------------------------------------------
        await _rateLimiter.WaitForOptionChainSlotAsync(cancellationToken);
        var expiries = await _optionChain.GetExpiriesAsync(instrument.SecurityId, instrument.DhanSegment, cancellationToken);
        if (expiries.Count == 0)
        {
            _logger.LogWarning("No expiries returned for {Underlying} this cycle - skipping option-side work.", config.Name);
            return;
        }

        foreach (var expiry in expiries.Take(_options.TrackedExpiryCount))
        {
            try
            {
                await RunExpiryAsync(instrument, config, expiry, fromDay, today, cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "{Underlying} expiry {Expiry} failed this cycle - continuing with any other tracked expiries.", config.Name, expiry);
            }
        }
    }

    private async Task RefreshSpotBarsAsync(DhanSpotInstrument instrument, string underlying, DateOnly fromDay, DateOnly today, CancellationToken cancellationToken)
    {
        var seriesKey = instrument.SecurityId.ToString(CultureInfo.InvariantCulture);
        var checkpoint = await _writer.GetBackfillCheckpointAsync(seriesKey, cancellationToken);
        var completedFrom = checkpoint?.From;

        // Backward extension - only if BackfillDays was raised since this series was last fully
        // covered. See Schema.sql's own doc comment on backfill_progress: only advances
        // completed_from once the WHOLE extension succeeds end to end, never mid-way.
        if (checkpoint is { } cpBack && fromDay < cpBack.From)
        {
            var backTo = cpBack.From.AddDays(-1);
            var savedBack = 0;
            var (_, backComplete, backError) = await _historicalData.GetSpotIntradayAsync(
                instrument.SecurityId, instrument.DhanSegment, fromDay, backTo, 1,
                async (bars, chunkFrom, chunkTo) => savedBack += await _writer.SaveSpotBarsAsync(underlying, bars, cancellationToken),
                cancellationToken);

            if (backComplete)
            {
                completedFrom = fromDay;
                await _writer.SaveBackfillCheckpointAsync(seriesKey, underlying, completedFrom.Value, cpBack.Through, cancellationToken);
                if (savedBack > 0) _logger.LogInformation("Extended {Underlying} spot backfill backward - saved {Count} bar(s) ({From}..{To}).", underlying, savedBack, fromDay, backTo);
            }
            else
            {
                _logger.LogWarning("{Underlying} spot backward extension [{From}..{To}] stopped early ({Error}) - will retry the whole extension next cycle.", underlying, fromDay, backTo, backError);
            }
        }

        // Forward top-up - the normal "keep today's data current" case, advancing completed_through
        // after every successful chunk so a partial failure never loses already-saved progress.
        var forwardFrom = checkpoint?.Through.AddDays(1) ?? fromDay;
        if (forwardFrom > today) return; // already fully caught up through today as of an earlier cycle

        var savedTotal = 0;
        var (_, fullyComplete, error) = await _historicalData.GetSpotIntradayAsync(
            instrument.SecurityId, instrument.DhanSegment, forwardFrom, today, 1,
            async (bars, chunkFrom, chunkTo) =>
            {
                var saved = await _writer.SaveSpotBarsAsync(underlying, bars, cancellationToken);
                savedTotal += saved;
                await _writer.SaveBackfillCheckpointAsync(seriesKey, underlying, completedFrom ?? forwardFrom, chunkTo, cancellationToken);
            },
            cancellationToken);

        if (savedTotal > 0)
            _logger.LogInformation("Saved {Count} {Underlying} spot bar(s) ({From}..{To}).", savedTotal, underlying, forwardFrom, today);
        if (!fullyComplete)
            _logger.LogWarning("{Underlying} spot backfill stopped early this cycle ({Error}) - checkpoint holds the last successful chunk, so next cycle resumes from there rather than redoing [{From}..{To}].",
                underlying, error, forwardFrom, today);
    }

    private async Task RunExpiryAsync(
        DhanSpotInstrument instrument, TrackedUnderlying config, DateOnly expiry, DateOnly fromDay, DateOnly today, CancellationToken cancellationToken)
    {
        await _rateLimiter.WaitForOptionChainSlotAsync(cancellationToken);
        var chain = await _optionChain.GetChainAsync(instrument.SecurityId, instrument.DhanSegment, expiry, cancellationToken);
        if (chain is null || chain.Strikes.Count == 0)
        {
            _logger.LogWarning("Empty option chain for {Underlying} {Expiry} this cycle.", config.Name, expiry);
            return;
        }

        var spotPrice = chain.UnderlyingLastPrice;
        var capturedAt = DateTimeOffset.UtcNow;

        if (spotPrice is not { } spot)
        {
            _logger.LogWarning("Option chain for {Underlying} {Expiry} returned no underlying last_price - cannot compute ATM this cycle.", config.Name, expiry);
            return;
        }

        var atm = Math.Round(spot / config.StrikeStep) * config.StrikeStep;
        var lowStrike = atm - _options.StrikesEachSide * config.StrikeStep;
        var highStrike = atm + _options.StrikesEachSide * config.StrikeStep;
        var band = chain.Strikes.Where(s => s.Strike >= lowStrike && s.Strike <= highStrike).ToList();

        // NOT persisted - per explicit "do not want to store live data" - this live chain call is
        // still made (and still rate-limited/paced the same as before) purely to compute ATM and
        // discover each strike's own security_id, which RefreshOptionBarsAsync below then uses to
        // pull REAL historical OHLC via /charts/intraday. See the README for where live OI/IV/
        // greeks now live instead (nowhere - only rolling_option_bars_1m has historical OI/IV, no
        // greeks anywhere in Dhan's API - see the project's own doc comments on this tradeoff).
        _logger.LogInformation("{Underlying} {Expiry}: ATM={Atm}, backfilling strikes [{Low}-{High}] (capturedAt={CapturedAt:u}).",
            config.Name, expiry, atm, lowStrike, highStrike, capturedAt);

        foreach (var strike in band)
        {
            foreach (var (isCall, leg) in new[] { (true, strike.Ce), (false, strike.Pe) })
            {
                if (leg is null || leg.SecurityId <= 0) continue;
                try
                {
                    await RefreshOptionBarsAsync(config.Name, expiry, strike.Strike, isCall, leg.SecurityId, instrument.DhanSegment, fromDay, today, cancellationToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.LogDebug(ex, "Option bar refresh failed for {Underlying} {Expiry} {Strike}{Side}.", config.Name, expiry, strike.Strike, isCall ? "CE" : "PE");
                }
            }
        }
    }

    private async Task RefreshOptionBarsAsync(
        string underlying, DateOnly expiry, decimal strike, bool isCall, long securityId, string dhanSegment, DateOnly fromDay, DateOnly today, CancellationToken cancellationToken)
    {
        var seriesKey = securityId.ToString(CultureInfo.InvariantCulture);
        var checkpoint = await _writer.GetBackfillCheckpointAsync(seriesKey, cancellationToken);
        var completedFrom = checkpoint?.From;

        // Backward extension - see RefreshSpotBarsAsync's own comment on the same pattern.
        if (checkpoint is { } cpBack && fromDay < cpBack.From)
        {
            var backTo = cpBack.From.AddDays(-1);
            var savedBack = 0;
            var (_, backComplete, backError) = await _historicalData.GetOptionIntradayAsync(
                (uint)securityId, dhanSegment, fromDay, backTo, 1,
                async (bars, chunkFrom, chunkTo) => savedBack += await _writer.SaveOptionBarsAsync(underlying, expiry, strike, isCall, securityId, bars, cancellationToken),
                cancellationToken);

            if (backComplete)
            {
                completedFrom = fromDay;
                await _writer.SaveBackfillCheckpointAsync(seriesKey, underlying, completedFrom.Value, cpBack.Through, cancellationToken);
                if (savedBack > 0) _logger.LogDebug("Extended {Underlying} {Expiry} {Strike}{Side} backfill backward - saved {Count} bar(s).", underlying, expiry, strike, isCall ? "CE" : "PE", savedBack);
            }
            else
            {
                _logger.LogDebug("{Underlying} {Expiry} {Strike}{Side} backward extension stopped early ({Error}) - will retry next cycle.", underlying, expiry, strike, isCall ? "CE" : "PE", backError);
            }
        }

        var forwardFrom = checkpoint?.Through.AddDays(1) ?? fromDay;
        if (forwardFrom > today) return; // already fully caught up through today as of an earlier cycle

        var savedTotal = 0;
        var (_, fullyComplete, error) = await _historicalData.GetOptionIntradayAsync(
            (uint)securityId, dhanSegment, forwardFrom, today, 1,
            async (bars, chunkFrom, chunkTo) =>
            {
                var saved = await _writer.SaveOptionBarsAsync(underlying, expiry, strike, isCall, securityId, bars, cancellationToken);
                savedTotal += saved;
                await _writer.SaveBackfillCheckpointAsync(seriesKey, underlying, completedFrom ?? forwardFrom, chunkTo, cancellationToken);
            },
            cancellationToken);

        if (savedTotal > 0)
            _logger.LogDebug("Saved {Count} bar(s) for {Underlying} {Expiry} {Strike}{Side} ({From}..{To}).", savedTotal, underlying, expiry, strike, isCall ? "CE" : "PE", forwardFrom, today);
        if (!fullyComplete)
            _logger.LogDebug("{Underlying} {Expiry} {Strike}{Side} backfill stopped early this cycle ({Error}) - will resume from its own checkpoint next cycle.",
                underlying, expiry, strike, isCall ? "CE" : "PE", error);
    }
}

using Microsoft.Extensions.Options;
using NiftyDataCollector.Db;
using NiftyDataCollector.Dhan;

namespace NiftyDataCollector.Collection;

/// <summary>
/// Backfills Dhan's Rolling Options historical data (see DhanRollingOptionClient's own doc
/// comment) - OPT-IN via RollingOption:Enabled (default false), since a full backfill from
/// RollingOption:StartDate can mean thousands of API calls (StrikesEachSide=10 means 21 relative
/// strikes x 2 legs = 42 series per underlying per expiry code tracked, each needing several
/// 30-day chunks per year of history) - review DhanRateLimiter's own daily-budget guard and the
/// project README before turning this on for real. The recommended path (per the user's own plan)
/// is to first run with a recent, small RollingOption:StartDate to confirm the resolved
/// strike/spot/OI/IV values look right, THEN widen StartDate further back - each series' own
/// checkpoint (backfill_progress) picks up that wider range as a BACKWARD extension on the very
/// next pass, without re-fetching or disturbing what the small test run already saved (see
/// Schema.sql's own doc comment on backfill_progress for exactly how that direction works).
///
/// Separate hosted service from CollectorHostedService on purpose: this is a long, mostly one-time
/// catch-up job (checkpointed) with a much longer natural cadence than the live 60s option-chain
/// poll, not something that belongs sharing that tight loop.
/// </summary>
public sealed class RollingOptionBackfillHostedService : BackgroundService
{
    private readonly DhanSpotInstrumentMaster _spotMaster;
    private readonly DhanRollingOptionClient _rollingOption;
    private readonly TimescaleWriter _writer;
    private readonly CollectorOptions _collectorOptions;
    private readonly RollingOptionOptions _options;
    private readonly ILogger<RollingOptionBackfillHostedService> _logger;

    public RollingOptionBackfillHostedService(
        DhanSpotInstrumentMaster spotMaster, DhanRollingOptionClient rollingOption, TimescaleWriter writer,
        IOptions<CollectorOptions> collectorOptions, IOptions<RollingOptionOptions> options, ILogger<RollingOptionBackfillHostedService> logger)
    {
        _spotMaster = spotMaster;
        _rollingOption = rollingOption;
        _writer = writer;
        _collectorOptions = collectorOptions.Value;
        _options = options.Value;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.Enabled)
        {
            _logger.LogInformation("RollingOption:Enabled is false - rolling-option historical backfill is off (see appsettings.json / README for what this involves before turning it on).");
            return;
        }

        await _writer.EnsureSchemaAsync(stoppingToken);

        var strikeOffsets = BuildStrikeOffsets(_collectorOptions.StrikesEachSide);
        var effectiveStartDate = _collectorOptions.BackfillFromDate ?? _options.StartDate;
        _logger.LogInformation(
            "RollingOption backfill starting - {Underlyings} underlying(s) x {Offsets} strike offset(s) x 2 legs x {Codes} expiry code(s), from {Start} to today (each underlying uses its own Collector:Underlyings[].ExpiryFlag).",
            _collectorOptions.Underlyings.Count, strikeOffsets.Count, _options.ExpiryCodes.Count, effectiveStartDate);

        while (!stoppingToken.IsCancellationRequested)
        {
            foreach (var underlying in _collectorOptions.Underlyings)
            {
                DhanSpotInstrument instrument;
                try
                {
                    instrument = await _spotMaster.ResolveAsync(underlying.Name, stoppingToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.LogError(ex, "Could not resolve {Underlying} for rolling-option backfill this pass - skipping it.", underlying.Name);
                    continue;
                }

                foreach (var expiryCode in _options.ExpiryCodes)
                {
                    foreach (var strikeOffset in strikeOffsets)
                    {
                        foreach (var isCall in new[] { true, false })
                        {
                            try
                            {
                                await RefreshSeriesAsync(instrument, underlying.Name, underlying.ExpiryFlag, expiryCode, strikeOffset, isCall, stoppingToken);
                            }
                            catch (Exception ex) when (ex is not OperationCanceledException)
                            {
                                _logger.LogError(ex, "Rolling-option series {Underlying} {Flag}:{Code} {Offset}{Side} failed this pass - will retry next pass.",
                                    underlying.Name, underlying.ExpiryFlag, expiryCode, strikeOffset, isCall ? "CE" : "PE");
                            }
                        }
                    }
                }
            }

            try { await Task.Delay(TimeSpan.FromMinutes(_options.PollIntervalMinutes), stoppingToken); }
            catch (OperationCanceledException) { return; }
        }
    }

    private async Task RefreshSeriesAsync(
        DhanSpotInstrument instrument, string underlying, string expiryFlag, int expiryCode, string strikeOffset, bool isCall, CancellationToken cancellationToken)
    {
        var seriesKey = $"ROLLING:{underlying}:{expiryFlag}:{expiryCode}:{strikeOffset}:{(isCall ? "CE" : "PE")}";
        var today = IstClock.Today();
        // Collector:BackfillFromDate, when set, is the one shared "backfill from this date"
        // override the user asked for - takes priority over RollingOption:StartDate here exactly
        // the same way it takes priority over Collector:BackfillDays in CollectorHostedService.
        var desiredFrom = _collectorOptions.BackfillFromDate ?? _options.StartDate;

        var checkpoint = await _writer.GetBackfillCheckpointAsync(seriesKey, cancellationToken);
        var completedFrom = checkpoint?.From;

        // Backward extension - the "test a small window first, then widen StartDate" workflow.
        // See Schema.sql's own doc comment on backfill_progress: completed_from only ever advances
        // once the WHOLE extension succeeds end to end, never mid-way.
        if (checkpoint is { } cpBack && desiredFrom < cpBack.From)
        {
            var backTo = cpBack.From.AddDays(-1);
            var savedBack = 0;
            var (_, backComplete, backError) = await _rollingOption.GetRollingOptionBarsAsync(
                instrument.SecurityId, expiryFlag, expiryCode, strikeOffset, isCall, desiredFrom, backTo,
                async (bars, chunkFrom, chunkTo) => savedBack += await _writer.SaveRollingOptionBarsAsync(underlying, expiryFlag, expiryCode, strikeOffset, isCall, bars, cancellationToken),
                cancellationToken);

            if (backComplete)
            {
                completedFrom = desiredFrom;
                await _writer.SaveBackfillCheckpointAsync(seriesKey, underlying, completedFrom.Value, cpBack.Through, cancellationToken);
                if (savedBack > 0)
                    _logger.LogInformation("Extended {Underlying} {Flag}:{Code} {Offset}{Side} rolling-option backfill backward to {From} - saved {Count} bar(s).",
                        underlying, expiryFlag, expiryCode, strikeOffset, isCall ? "CE" : "PE", desiredFrom, savedBack);
            }
            else
            {
                _logger.LogWarning("{Underlying} {Flag}:{Code} {Offset}{Side} rolling-option backward extension [{From}..{To}] stopped early ({Error}) - will retry the whole extension next pass.",
                    underlying, expiryFlag, expiryCode, strikeOffset, isCall ? "CE" : "PE", desiredFrom, backTo, backError);
            }
        }

        var forwardFrom = checkpoint?.Through.AddDays(1) ?? desiredFrom;
        if (forwardFrom > today) return; // already caught up through today as of an earlier pass

        var savedTotal = 0;
        var (_, fullyComplete, error) = await _rollingOption.GetRollingOptionBarsAsync(
            instrument.SecurityId, expiryFlag, expiryCode, strikeOffset, isCall, forwardFrom, today,
            async (bars, chunkFrom, chunkTo) =>
            {
                var saved = await _writer.SaveRollingOptionBarsAsync(underlying, expiryFlag, expiryCode, strikeOffset, isCall, bars, cancellationToken);
                savedTotal += saved;
                await _writer.SaveBackfillCheckpointAsync(seriesKey, underlying, completedFrom ?? forwardFrom, chunkTo, cancellationToken);
            },
            cancellationToken);

        if (savedTotal > 0)
            _logger.LogInformation("Saved {Count} rolling-option bar(s) for {Underlying} {Flag}:{Code} {Offset}{Side} ({From}..{To}).",
                savedTotal, underlying, expiryFlag, expiryCode, strikeOffset, isCall ? "CE" : "PE", forwardFrom, today);
        if (!fullyComplete)
            _logger.LogWarning("{Underlying} {Flag}:{Code} {Offset}{Side} rolling-option backfill stopped early this pass ({Error}) - checkpoint holds the last successful chunk.",
                underlying, expiryFlag, expiryCode, strikeOffset, isCall ? "CE" : "PE", error);
    }

    private static List<string> BuildStrikeOffsets(int strikesEachSide)
    {
        var offsets = new List<string> { "ATM" };
        for (var i = 1; i <= strikesEachSide; i++)
        {
            offsets.Add($"ATM+{i}");
            offsets.Add($"ATM-{i}");
        }
        return offsets;
    }
}

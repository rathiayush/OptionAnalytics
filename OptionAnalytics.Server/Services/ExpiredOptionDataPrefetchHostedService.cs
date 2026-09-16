using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Runs once per deployment (see ExpiredOptionDataStore.HasContract, and this class's own per-
/// contract completeness rule below) to fetch every NIFTY/BANKNIFTY expiry's own rolling-option data
/// - RAW bars for every token in the ATM+-FlowChainRadius band, both CALL and PUT - across the last
/// CalendarMonthsBack months, and cache it to disk so ExpiredOptionBacktestService's own
/// FetchAcrossSegmentsAsync can read a segment from there instead of hitting Dhan on every single
/// backtest run.
///
/// SCALE: NIFTY still has a weekly cadence (~52 expiries/year) plus monthly (~12); BANKNIFTY is
/// monthly only (its own weekly options were discontinued - see ExpiredOptionBacktestService's own
/// BANKNIFTY+WEEK rejection). Roughly 60-80 contracts across CalendarMonthsBack months, each needing
/// (FlowChainRadius*2+1)*2 = 42 separate rolling-option fetches (every token ATM-10..ATM+10, both
/// sides) - a few thousand paced requests in total, easily tens of minutes end to end. This is
/// exactly the tradeoff the user accepted explicitly for the spot-side prefetch this mirrors ("even
/// it takes time, let's do it") applied to a much larger dataset; it runs once, in the background,
/// and never blocks the app from serving requests while it works.
///
/// ONLY ALREADY-EXPIRED contracts are prefetched (expiryDate strictly before today) - a live/
/// not-yet-expired one's data is still forming and would need re-fetching anyway, defeating the
/// point of a "cache once" job.
///
/// PER-CONTRACT COMPLETENESS: a contract is only marked cached (and so only skipped on a later run)
/// once EVERY one of its 42 token/side fetches has succeeded with no error - a contract that hit
/// even one failure is not saved at all and is retried IN FULL on the next run, rather than trying to
/// resume individual tokens. Simpler, and cheap to redo (one contract's own 42 fetches), compared to
/// ever risking a cache silently missing a few tokens with no way to tell short of reading the file.
///
/// Reuses ExpiredOptionBacktestService's own BuildFetchSegments/StrikeToken/FlowChainRadius/
/// BandFetchDelay/StrikeStepByUnderlying rather than recomputing any of this independently - the
/// segment-anchoring and token-naming logic in particular took several real runs to get right (see
/// that class's own top-of-file doc comment), and a second, subtly different copy here would be
/// exactly the kind of drift that could silently cache the wrong contract's data under the right
/// name. NO splice-detection/trimming/filtering happens here at all - this only ever writes the RAW
/// fetch, so the exact same post-processing pipeline (DetectPossibleSplices, TrimToLargestSegment,
/// FilterToExpectedStrike) that already runs on a live fetch runs unchanged on a cached one too.
/// </summary>
public sealed class ExpiredOptionDataPrefetchHostedService : BackgroundService
{
    /// <summary>NIFTY has both cadences; BANKNIFTY monthly only.</summary>
    private static readonly (string Underlying, string[] ExpiryFlags)[] Underlyings =
    {
        ("NIFTY", new[] { "WEEK", "MONTH" }),
        ("BANKNIFTY", new[] { "MONTH" }),
    };

    /// <summary>Pacing between contracts, on top of BandFetchDelay's own per-token pacing within one
    /// - a extra, cheap safety margin given the sheer number of contracts this job works through
    /// back to back, on top of (not instead of) the per-token/per-chunk pacing DhanRollingOptionDataService
    /// and ExpiredOptionBacktestService.BandFetchDelay already apply.</summary>
    private static readonly TimeSpan ContractDelay = TimeSpan.FromSeconds(1);

    /// <summary>How far back of a requestedFromDay to hand BuildFetchSegments so its own
    /// Later(requestedFromDay, segment1EarliestStart) clamp always resolves to the contract's real
    /// natural start (the previous same-cadence expiry + 1 day) rather than this arbitrary floor -
    /// comfortably wider than any real weekly/monthly cycle (at most ~35 days) without being so wide
    /// it risks ever winning that clamp for a genuine early contract with no prior expiry on record.</summary>
    private const int SegmentAnchorLookbackDays = 60;

    private readonly DhanOptions _options;
    private readonly ExpiredOptionDataPrefetchOptions _prefetchOptions;
    private readonly DhanSession _session;
    private readonly DhanSpotInstrumentMaster _instrumentMaster;
    private readonly DhanRollingOptionDataService _rollingOption;
    private readonly ExpiredOptionDataStore _store;
    private readonly ILogger<ExpiredOptionDataPrefetchHostedService> _logger;

    public ExpiredOptionDataPrefetchHostedService(
        IOptions<DhanOptions> options,
        IOptions<ExpiredOptionDataPrefetchOptions> prefetchOptions,
        DhanSession session,
        DhanSpotInstrumentMaster instrumentMaster,
        DhanRollingOptionDataService rollingOption,
        ExpiredOptionDataStore store,
        ILogger<ExpiredOptionDataPrefetchHostedService> logger)
    {
        _options = options.Value;
        _prefetchOptions = prefetchOptions.Value;
        _session = session;
        _instrumentMaster = instrumentMaster;
        _rollingOption = rollingOption;
        _store = store;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Off by default (see ExpiredOptionDataPrefetchOptions) - set
        // ExpiredOptionDataPrefetch__Enabled=true to opt a deployment into this one-time download.
        if (!_prefetchOptions.Enabled)
        {
            _logger.LogInformation("Expired-option data prefetch is disabled (ExpiredOptionDataPrefetch:Enabled=false) - skipping.");
            return;
        }

        if (!_options.HasSession && !_options.HasTotpCredentials)
        {
            _logger.LogWarning("Skipping the one-time expired-option data prefetch - neither Dhan:AccessToken nor Dhan:Pin/Dhan:TotpSecret are configured. It will retry on the next deployment.");
            return;
        }

        if (_options.HasTotpCredentials)
        {
            var waited = TimeSpan.Zero;
            var authWaitTimeout = TimeSpan.FromMinutes(3);
            while (!_session.IsAuthenticated && waited < authWaitTimeout && !stoppingToken.IsCancellationRequested)
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
            _logger.LogError(ex, "Could not load the Dhan scrip master - the one-time expired-option data prefetch cannot resolve NIFTY/BANKNIFTY yet. It will retry on the next deployment.");
            return;
        }

        var today = IstClock.Today();
        var rangeStart = today.AddMonths(-ExpiredOptionBacktestService.CalendarMonthsBack);
        var rangeEnd = today.AddDays(-1); // strictly already-expired only

        var isFirstContract = true;

        foreach (var (underlying, expiryFlags) in Underlyings)
        {
            if (stoppingToken.IsCancellationRequested) return;

            var instrument = _instrumentMaster.FindSpot(underlying);
            if (instrument is null)
            {
                _logger.LogWarning("Could not resolve {Underlying}'s Dhan security id - skipping its one-time expired-option data prefetch. It will retry on the next deployment.", underlying);
                continue;
            }

            foreach (var expiryFlag in expiryFlags)
            {
                var dates = string.Equals(expiryFlag, "MONTH", StringComparison.OrdinalIgnoreCase)
                    ? ExpiryCalendar.MonthlyExpiries(rangeStart, rangeEnd)
                    : ExpiryCalendar.WeeklyExpiries(rangeStart, rangeEnd);

                foreach (var expiryDate in dates)
                {
                    if (stoppingToken.IsCancellationRequested) return;

                    if (_store.HasContract(underlying, expiryFlag, expiryDate))
                        continue; // already cached from an earlier run - the "runs once" guard

                    if (!isFirstContract) await Task.Delay(ContractDelay, stoppingToken);
                    isFirstContract = false;

                    try
                    {
                        await PrefetchContractAsync(underlying, instrument, expiryFlag, expiryDate, stoppingToken);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        // One contract failing must not stop every other one, or take the whole host
                        // down with it - same reasoning SpotFeedHostedService's own per-underlying
                        // try/catch already documents for exactly this shape of loop.
                        _logger.LogError(ex, "One-time expired-option data prefetch FAILED for {Underlying} {ExpiryFlag} {ExpiryDate} - it will retry on the next deployment.",
                            underlying, expiryFlag, expiryDate);
                    }
                }
            }
        }

        _logger.LogInformation("One-time expired-option data prefetch pass complete.");
    }

    private async Task PrefetchContractAsync(string underlying, DhanSpotInstrument instrument, string expiryFlag, DateOnly expiryDate, CancellationToken cancellationToken)
    {
        var segments = ExpiredOptionBacktestService.BuildFetchSegments(expiryFlag, expiryDate, expiryDate.AddDays(-SegmentAnchorLookbackDays));
        var segment = segments[^1]; // segment 1 - its own .To is always the target expiry itself
        var fromDay = segment.From;
        var toDay = segment.To;

        _logger.LogInformation("Starting one-time expired-option data prefetch for {Underlying} {ExpiryFlag} {ExpiryDate}: {From}..{To} (chunked and paced, {Tokens} token/side member(s)).",
            underlying, expiryFlag, expiryDate, fromDay, toDay, (ExpiredOptionBacktestService.FlowChainRadius * 2 + 1) * 2);

        var members = new List<(string StrikeToken, string OptionType, IReadOnlyList<(CandleWithVolume Bar, decimal? Strike, decimal? Spot)> Bars)>();
        var hadError = false;
        var isFirstToken = true;

        foreach (var isCall in new[] { true, false })
        {
            for (var steps = -ExpiredOptionBacktestService.FlowChainRadius; steps <= ExpiredOptionBacktestService.FlowChainRadius; steps++)
            {
                if (!isFirstToken) await Task.Delay(ExpiredOptionBacktestService.BandFetchDelay, cancellationToken);
                isFirstToken = false;

                var token = ExpiredOptionBacktestService.StrikeToken(isCall ? steps : -steps);
                var optionType = isCall ? "CALL" : "PUT";

                var (bars, error) = await _rollingOption.GetRollingOptionCandlesAsync(
                    instrument.SecurityId, expiryFlag, segment.ExpiryCode, token, optionType, fromDay, toDay, 1, cancellationToken);

                if (error is not null)
                {
                    hadError = true;
                    _logger.LogWarning("Expired-option data prefetch token {Token} {OptionType} for {Underlying} {ExpiryFlag} {ExpiryDate} returned an error - this contract will not be marked cached and will retry in full next run: {Error}",
                        token, optionType, underlying, expiryFlag, expiryDate, error);
                }

                members.Add((token, optionType, bars));
            }
        }

        if (hadError)
        {
            _logger.LogWarning("Not caching {Underlying} {ExpiryFlag} {ExpiryDate} - at least one of its {Tokens} token/side fetches failed.",
                underlying, expiryFlag, expiryDate, members.Count);
            return;
        }

        if (members.All(m => m.Bars.Count == 0))
        {
            _logger.LogWarning("Expired-option data prefetch for {Underlying} {ExpiryFlag} {ExpiryDate} returned NO bars across every token/side - not caching. It will retry on the next deployment.",
                underlying, expiryFlag, expiryDate);
            return;
        }

        await _store.SaveAsync(underlying, expiryFlag, expiryDate, fromDay, toDay, members, cancellationToken);
    }
}

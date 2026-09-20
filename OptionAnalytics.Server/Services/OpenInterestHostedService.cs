using System.Collections.Concurrent;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Keeps one OiChainSnapshot per tracked underlying/expiry in memory - a morning BASELINE (captured
/// once, at or after BaselineCaptureMinutesOfDay, and persisted via OpenInterestSnapshotStore so a
/// mid-morning restart doesn't lose it) plus a CURRENT snapshot refreshed on every poll - so that
/// OiUnwindStrategy, running through BacktestService.Prepare (a synchronous method - see its own
/// doc comment), can read "what does OI look like right now compared to this morning" with no I/O
/// of its own, the same way every other strategy reads CdvUnderlyingState's already-live series.
///
/// Polls rather than reacting to bar closes (unlike StrategyTriggerHostedService's own event-driven
/// evaluation) because OI has nothing analogous to a bar close to react to - it simply changes
/// whenever Dhan's own Option Chain snapshot changes, which DhanOptionChainQuotes already paces
/// (30s cache, 3.5s minimum spacing between real calls) regardless of how often this asks.
/// PollInterval is comfortably above that cache lifetime so most polls do trigger one real,
/// paced Dhan call per underlying/expiry rather than piling up wasted requests.
/// </summary>
public sealed class OpenInterestHostedService : BackgroundService
{
    /// <summary>09:20 IST - five minutes after NSE's continuous session opens (see
    /// OptionTradeSimulator.SignalStartTimeParameter's own reasoning for why 09:15 itself is a call
    /// auction, not real trading), so the "morning" OI baseline reflects a few minutes of genuine
    /// continuous-session order flow rather than the pre-open auction's own print.</summary>
    private const int BaselineCaptureMinutesOfDay = 560;

    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan StartupDelay = TimeSpan.FromSeconds(30);

    private readonly SpotFeedHostedService _spotFeed;
    private readonly CdvHostedService _cdv;
    private readonly DhanOptionChainQuotes _chainQuotes;
    private readonly OpenInterestSnapshotStore _store;
    private readonly ILogger<OpenInterestHostedService> _logger;

    private readonly ConcurrentDictionary<(string Underlying, DateOnly Expiry), OiChainSnapshot> _snapshots = new();

    public OpenInterestHostedService(
        SpotFeedHostedService spotFeed, CdvHostedService cdv, DhanOptionChainQuotes chainQuotes,
        OpenInterestSnapshotStore store, ILogger<OpenInterestHostedService> logger)
    {
        _spotFeed = spotFeed;
        _cdv = cdv;
        _chainQuotes = chainQuotes;
        _store = store;
        _logger = logger;
    }

    /// <summary>The current OiChainSnapshot for one underlying/expiry, or null when nothing has been
    /// captured yet for it (no session, this underlying/expiry isn't tracked, or it's simply too
    /// early - see BaselineCaptureMinutesOfDay). Null expiry reads whichever expiry this underlying
    /// tracks first, matching CdvHostedService.StateFor's own "null means the selected one"
    /// convention. Synchronous and lock-free (ConcurrentDictionary) - safe to call from
    /// BacktestService.Prepare, which must never itself await Dhan.</summary>
    public OiChainSnapshot? TryGetSnapshot(string underlying, DateOnly? expiry)
    {
        var resolvedExpiry = expiry ?? _cdv.TrackedExpiries(underlying).FirstOrDefault();
        if (resolvedExpiry == default) return null;

        return _snapshots.TryGetValue((underlying.ToUpperInvariant(), resolvedExpiry), out var snapshot) ? snapshot : null;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(StartupDelay, stoppingToken);

            while (!stoppingToken.IsCancellationRequested)
            {
                foreach (var (underlying, spotState) in _spotFeed.States)
                {
                    if (stoppingToken.IsCancellationRequested) break;
                    var instrument = spotState.Instrument;
                    if (instrument is null) continue;

                    foreach (var expiry in _cdv.TrackedExpiries(underlying))
                    {
                        if (stoppingToken.IsCancellationRequested) break;
                        try
                        {
                            await PollOneAsync(underlying, expiry, instrument, stoppingToken);
                        }
                        catch (Exception ex) when (ex is not OperationCanceledException)
                        {
                            // One underlying/expiry failing (a transient Dhan hiccup) must not stop
                            // the others from refreshing, and must not take the whole host down -
                            // this snapshot simply stays at its last known value until the next poll.
                            _logger.LogDebug(ex, "OI poll failed for {Underlying} {Expiry} - keeping the last known snapshot.", underlying, expiry);
                        }
                    }
                }

                await Task.Delay(PollInterval, stoppingToken);
            }
        }
        catch (OperationCanceledException)
        {
            // Shutting down.
        }
    }

    private async Task PollOneAsync(string underlying, DateOnly expiry, DhanSpotInstrument instrument, CancellationToken cancellationToken)
    {
        var quotes = await _chainQuotes.GetQuotesAsync(instrument.SecurityId, instrument.DhanSegment, expiry, cancellationToken);
        if (quotes.Count == 0) return; // no session, rate-limited, or outside market hours - leave the last known snapshot as-is

        var current = quotes.ToDictionary(
            q => q.Strike,
            q => new OiStrikeSnapshot(q.CeOpenInterest, q.CeLastPrice, q.PeOpenInterest, q.PeLastPrice));

        var key = (underlying.ToUpperInvariant(), expiry);
        var today = IstClock.Today();
        var existing = _snapshots.TryGetValue(key, out var snap) ? snap : null;

        IReadOnlyDictionary<decimal, OiStrikeSnapshot> baseline;
        DateTimeOffset baselineCapturedAtUtc;

        if (existing is { } e && e.Day == today && e.Baseline.Count > 0)
        {
            // Already have today's baseline in memory - keep it exactly as captured, never overwrite
            // a morning's true opening OI with a later, already-moved number.
            baseline = e.Baseline;
            baselineCapturedAtUtc = e.BaselineCapturedAtUtc;
        }
        else if (_store.Load(underlying, expiry, today) is { } loaded)
        {
            // A previous process instance already captured today's baseline (a mid-morning
            // restart/redeploy) - reload it rather than capturing a second, later one.
            (baselineCapturedAtUtc, baseline) = loaded;
        }
        else if (IstClock.MinutesOfDay(DateTimeOffset.UtcNow) >= BaselineCaptureMinutesOfDay)
        {
            baselineCapturedAtUtc = DateTimeOffset.UtcNow;
            baseline = current;
            await _store.SaveAsync(underlying, expiry, today, baselineCapturedAtUtc, baseline, cancellationToken);
        }
        else
        {
            // Too early - no baseline yet today. Current still updates (a live premium/OI number is
            // harmless to hold), but OiUnwindStrategy treats an empty Baseline as "not ready".
            baseline = new Dictionary<decimal, OiStrikeSnapshot>();
            baselineCapturedAtUtc = default;
        }

        _snapshots[key] = new OiChainSnapshot(today, baselineCapturedAtUtc, baseline, current);
    }
}

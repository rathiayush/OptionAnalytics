using System.Collections.Concurrent;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// The newest live reading of every option leg the OI Replay live feed tracks (OiReplayLiveFeedService
/// records each tick here), kept in memory only - so a page can read an index's current option prices
/// without asking Dhan (GET /api/oi-replay/{underlying}/live-legs). The OI Replay page uses it to show an
/// open paper position on another index at its current premium at once; the live ticks carry it on.
/// </summary>
public sealed class LiveOptionLegStore
{
    private readonly ConcurrentDictionary<(string Underlying, string ExpiryFlag, string Side, decimal Strike), LiveOptionTick> _latest = new();

    public void Record(LiveOptionTick tick) => _latest[(tick.Underlying, tick.ExpiryFlag, tick.Side, tick.Strike)] = tick;

    /// <summary>The newest reading of each leg of one chain (index + expiry flag) observed on `day` (IST),
    /// by strike then side - an earlier day's readings are not current prices.</summary>
    public IReadOnlyList<LiveOptionTick> Latest(string underlying, string expiryFlag, DateOnly day) =>
        _latest.Values
            .Where(t => string.Equals(t.Underlying, underlying, StringComparison.OrdinalIgnoreCase)
                        && string.Equals(t.ExpiryFlag, expiryFlag, StringComparison.OrdinalIgnoreCase)
                        && DateOnly.FromDateTime(t.Time.ToOffset(IstClock.Offset).DateTime) == day)
            .OrderBy(t => t.Strike).ThenBy(t => t.Side, StringComparer.Ordinal)
            .ToList();
}

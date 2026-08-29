using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>Per-contract running state: last price and cumulative volume (to derive each tick's
/// incremental traded quantity, since Dhan reports Volume as a day-cumulative total, not a
/// per-tick amount), the tick-rule direction, and this contract's own running delta-weighted CDV
/// contribution.</summary>
internal sealed class CdvStrikeRuntime
{
    public required uint SecurityId { get; init; }
    public required decimal Strike { get; init; }
    public required bool IsCall { get; init; }

    public decimal? PrevPrice { get; set; }
    public long? PrevVolume { get; set; }
    /// <summary>+1 = last classified as a buy, -1 = sell. Carried forward on an unchanged price -
    /// the standard tick-rule convention ("zero tick" trades continue the prior direction).</summary>
    public int Direction { get; set; } = 1;

    /// <summary>This contract's own cumulative signed-and-delta-weighted volume since it started
    /// being tracked today. Once a strike falls out of the ATM window and is unsubscribed, this
    /// value simply stops changing (no more ticks arrive for it) - it stays included in the
    /// underlying's CE/PE total rather than being zeroed out, so the total never jumps just
    /// because the ATM window moved.</summary>
    public decimal RunningCdv { get; set; }
}

/// <summary>
/// One underlying's (NIFTY or BANKNIFTY) option-chain CDV state: every strike this app has tracked
/// today (CdvHostedService adds a strike here the first time it enters the ATM+-8 window; entries
/// are never removed, only the live subscription for out-of-window ones is dropped - see
/// CdvStrikeRuntime.RunningCdv's doc comment), plus the resulting CE/PE totals sampled into a
/// 1-minute line series for the chart.
/// </summary>
public sealed class CdvUnderlyingState
{
    private readonly object _lock = new();
    private readonly Dictionary<uint, CdvStrikeRuntime> _strikes = new();
    private readonly List<CdvBarPoint> _closedBars = new();
    private CdvBarPoint? _currentBar;

    public CdvUnderlyingState(string underlying)
    {
        Underlying = underlying;
    }

    public string Underlying { get; }
    public int? AtmStrike { get; set; }
    public DateOnly? Expiry { get; set; }
    public DateTimeOffset LastUpdateUtc { get; private set; }

    /// <summary>Registers a strike/side this underlying has never seen today, starting its
    /// RunningCdv at zero. A no-op if already tracked (re-entering the window after rolling back
    /// out must not reset its accumulated total).</summary>
    public void EnsureTracked(uint securityId, decimal strike, bool isCall)
    {
        lock (_lock)
        {
            if (!_strikes.ContainsKey(securityId))
                _strikes[securityId] = new CdvStrikeRuntime { SecurityId = securityId, Strike = strike, IsCall = isCall };
        }
    }

    public bool IsTracked(uint securityId)
    {
        lock (_lock) { return _strikes.ContainsKey(securityId); }
    }

    /// <summary>Folds one option tick into its contract's running CDV using the tick rule (price
    /// up from the last trade = buy, down = sell, unchanged = carry the prior direction) weighted
    /// by a sigmoid approximation of the contract's delta given <paramref name="currentSpot"/> -
    /// the same "delta auto" moneyness weighting the CDV feature is named for. The very first tick
    /// seen for a contract only seeds its volume baseline (Dhan's Volume field is the day's
    /// cumulative total, not a per-tick amount) rather than counting everything traded before this
    /// app subscribed as one giant fake delta.</summary>
    public void ApplyTick(SpotTick tick, decimal currentSpot)
    {
        lock (_lock)
        {
            if (!_strikes.TryGetValue(tick.SecurityId, out var strike)) return;

            if (strike.PrevPrice is { } prevPrice)
            {
                if (tick.LastPrice > prevPrice) strike.Direction = 1;
                else if (tick.LastPrice < prevPrice) strike.Direction = -1;
                // else: price unchanged, keep the prior direction
            }
            strike.PrevPrice = tick.LastPrice;

            long deltaVolume = 0;
            if (strike.PrevVolume is { } prevVolume && tick.Volume >= prevVolume)
                deltaVolume = tick.Volume - prevVolume;
            strike.PrevVolume = tick.Volume;

            if (deltaVolume > 0 && currentSpot > 0)
            {
                var weight = ComputeDeltaWeight(strike.Strike, currentSpot, strike.IsCall);
                strike.RunningCdv += strike.Direction * deltaVolume * weight;
            }

            LastUpdateUtc = DateTimeOffset.UtcNow;
            UpdateBar_NoLock(tick.ExchangeTimestamp);
        }
    }

    /// <summary>Sigmoid moneyness weighting - the same formula the Pine "delta auto" indicator
    /// uses to approximate an option's |delta| from moneyness without a full Black-Scholes model:
    /// a call's weight rises toward 1 as it goes deep ITM (strike well below spot) and falls
    /// toward 0 deep OTM; a put mirrors this on the other side of ATM. moneyness = (strike-spot)/spot.
    /// </summary>
    private static decimal ComputeDeltaWeight(decimal strike, decimal spot, bool isCall)
    {
        var moneyness = (double)((strike - spot) / spot);
        var delta = isCall
            ? 1.0 / (1.0 + Math.Exp(8.5 * moneyness))
            : -1.0 / (1.0 + Math.Exp(-8.5 * moneyness));
        return (decimal)Math.Abs(delta);
    }

    private void UpdateBar_NoLock(DateTimeOffset timestamp)
    {
        var (ceCdv, peCdv) = TotalsNoLock();
        var minute = new DateTimeOffset(timestamp.Year, timestamp.Month, timestamp.Day, timestamp.Hour, timestamp.Minute, 0, timestamp.Offset);

        if (_currentBar is not { } bar || bar.Time != minute)
        {
            if (_currentBar is { } previous) _closedBars.Add(previous);
            _currentBar = new CdvBarPoint(minute, ceCdv, peCdv);
        }
        else
        {
            _currentBar = bar with { CeCdv = ceCdv, PeCdv = peCdv };
        }
    }

    private (decimal Ce, decimal Pe) TotalsNoLock()
    {
        decimal ce = 0, pe = 0;
        foreach (var s in _strikes.Values)
        {
            if (s.IsCall) ce += s.RunningCdv; else pe += s.RunningCdv;
        }
        return (ce, pe);
    }

    public IReadOnlyList<CdvBarPoint> GetSeries()
    {
        lock (_lock)
        {
            var list = new List<CdvBarPoint>(_closedBars);
            if (_currentBar is { } bar) list.Add(bar);
            return list;
        }
    }

    public CdvSnapshot ToSnapshot()
    {
        lock (_lock)
        {
            var (ce, pe) = TotalsNoLock();
            return new CdvSnapshot(Underlying, AtmStrike, Expiry, ce, pe, LastUpdateUtc, _currentBar);
        }
    }
}

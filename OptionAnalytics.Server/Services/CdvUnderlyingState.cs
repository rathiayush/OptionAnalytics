using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;
using Skender.Stock.Indicators;

namespace OptionAnalytics.Server.Services;

/// <summary>Per-contract running state: last price and cumulative volume (to derive each tick's
/// incremental traded quantity, since Dhan reports Volume as a day-cumulative total, not a
/// per-tick amount), the tick-rule direction, this contract's own running delta-weighted CDV
/// contribution, and - separately - its own 1-minute OHLC+volume bar series (used only when this
/// strike happens to be the underlying's current ATM CE/PE, for the ATM premium chart and its
/// OBV indicator; every tracked strike still builds one, since ATM can move onto any of them).
/// </summary>
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

    private readonly List<(Candle Bar, long Volume)> _closedBars = new();
    private (Candle Bar, long Volume)? _currentBar;

    /// <summary>Folds one price tick into this contract's own 1-minute bar (mirrors
    /// SpotUnderlyingState.ApplyTick's bucketing), accumulating <paramref name="tickVolume"/> -
    /// the same per-tick incremental volume already computed for CDV - into that bar's total.
    /// Called for every tracked strike regardless of whether it's currently ATM, since which one
    /// is ATM changes every 30 minutes and each needs its own history ready when it becomes so.
    /// </summary>
    public void ApplyPriceTick(decimal price, long tickVolume, DateTimeOffset timestamp)
    {
        var minute = new DateTimeOffset(timestamp.Year, timestamp.Month, timestamp.Day, timestamp.Hour, timestamp.Minute, 0, timestamp.Offset);

        if (_currentBar is not { } cur || cur.Bar.Time != minute)
        {
            if (_currentBar is { } previous) _closedBars.Add(previous);
            _currentBar = (new Candle(minute, price, price, price, price), tickVolume);
        }
        else
        {
            var bar = cur.Bar with
            {
                High = Math.Max(cur.Bar.High, price),
                Low = Math.Min(cur.Bar.Low, price),
                Close = price,
            };
            _currentBar = (bar, cur.Volume + tickVolume);
        }
    }

    public IReadOnlyList<Candle> GetCandles()
    {
        var list = _closedBars.Select(b => b.Bar).ToList();
        if (_currentBar is { } bar) list.Add(bar.Bar);
        return list;
    }

    public Candle? GetCurrentBar() => _currentBar?.Bar;

    /// <summary>OHLC + volume together - what OBV needs and Candle alone doesn't carry.</summary>
    public IReadOnlyList<(Candle Bar, long Volume)> GetVolumeBars()
    {
        var list = new List<(Candle, long)>(_closedBars);
        if (_currentBar is { } bar) list.Add(bar);
        return list;
    }
}

/// <summary>
/// One underlying's (NIFTY or BANKNIFTY) option-chain CDV state: every strike this app has tracked
/// today (CdvHostedService adds a strike here the first time it enters the ATM+-8 window; entries
/// are never removed, only the live subscription for out-of-window ones is dropped - see
/// CdvStrikeRuntime.RunningCdv's doc comment), plus the resulting CE/PE totals sampled into a
/// 1-minute line series for the chart, plus (for the strike currently at ATM) a premium candle
/// series and its OBV indicator.
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
    /// app subscribed as one giant fake delta. Also feeds the contract's own premium candle (see
    /// CdvStrikeRuntime.ApplyPriceTick) regardless of whether it's currently ATM.</summary>
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

            strike.ApplyPriceTick(tick.LastPrice, deltaVolume, tick.ExchangeTimestamp);

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

    private CdvStrikeRuntime? FindAtmStrikeNoLock(bool isCall) =>
        AtmStrike is { } atm ? _strikes.Values.FirstOrDefault(s => s.IsCall == isCall && s.Strike == atm) : null;

    public IReadOnlyList<CdvBarPoint> GetSeries()
    {
        lock (_lock)
        {
            var list = new List<CdvBarPoint>(_closedBars);
            if (_currentBar is { } bar) list.Add(bar);
            return list;
        }
    }

    /// <summary>The premium candle series for whichever tracked contract is currently ATM on this
    /// side - empty until ATM has been resolved at least once. Which securityId this points at
    /// changes as ATM moves, but each contract's own history (from whenever it started being
    /// tracked, not necessarily today's open) is preserved rather than reset.</summary>
    public IReadOnlyList<Candle> GetAtmCandles(bool isCall)
    {
        lock (_lock) { return FindAtmStrikeNoLock(isCall)?.GetCandles() ?? Array.Empty<Candle>(); }
    }

    public Candle? GetAtmCurrentBar(bool isCall)
    {
        lock (_lock) { return FindAtmStrikeNoLock(isCall)?.GetCurrentBar(); }
    }

    /// <summary>On-Balance-Volume for the current ATM contract on this side, computed by
    /// Skender.Stock.Indicators over that contract's own OHLC+volume bars (see
    /// CdvStrikeRuntime.GetVolumeBars) - a standard-library indicator, deliberately not another
    /// hand-rolled formula like CDV's tick-rule/sigmoid weighting.</summary>
    public IReadOnlyList<ObvPoint> GetObvSeries(bool isCall)
    {
        lock (_lock)
        {
            var strike = FindAtmStrikeNoLock(isCall);
            if (strike is null) return Array.Empty<ObvPoint>();

            var bars = strike.GetVolumeBars();
            if (bars.Count == 0) return Array.Empty<ObvPoint>();

            var quotes = bars.Select(b => new Quote
            {
                Date = b.Bar.Time.UtcDateTime,
                Open = b.Bar.Open,
                High = b.Bar.High,
                Low = b.Bar.Low,
                Close = b.Bar.Close,
                Volume = b.Volume,
            }).ToList();

            var obv = quotes.GetObv().ToList();
            var result = new List<ObvPoint>(obv.Count);
            for (var i = 0; i < obv.Count; i++)
                result.Add(new ObvPoint(bars[i].Bar.Time, obv[i].Obv is { } value ? (decimal)value : 0m));
            return result;
        }
    }

    public CdvSnapshot ToSnapshot()
    {
        lock (_lock)
        {
            var (ce, pe) = TotalsNoLock();
            var atmCeBar = FindAtmStrikeNoLock(true)?.GetCurrentBar();
            var atmPeBar = FindAtmStrikeNoLock(false)?.GetCurrentBar();
            return new CdvSnapshot(Underlying, AtmStrike, Expiry, ce, pe, LastUpdateUtc, _currentBar, atmCeBar, atmPeBar);
        }
    }
}

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

    /// <summary>True once SeedStrikeHistory has actually gotten real bars for this strike - NOT
    /// the same thing as "is tracked" (EnsureTracked marks that permanently the moment a strike
    /// first enters the ATM+-8 window, regardless of whether its backfill succeeded). Lets
    /// CdvHostedService.RecenterAsync tell "genuinely new" apart from "tracked earlier but its
    /// backfill failed" - both need the same treatment (fetch and seed its history), but only the
    /// first would show up as newly-tracked from EnsureTracked's return value alone.</summary>
    public bool Backfilled { get; set; }

    private readonly List<(Candle Bar, long Volume)> _closedBars = new();
    private (Candle Bar, long Volume)? _currentBar;

    /// <summary>Folds one price tick into this contract's own 1-minute bar (mirrors
    /// SpotUnderlyingState.ApplyTick's bucketing), accumulating <paramref name="tickVolume"/> -
    /// the same per-tick incremental volume already computed for CDV - into that bar's total.
    /// Called for every tracked strike regardless of whether it's currently ATM, since which one
    /// is ATM changes every 30 minutes and each needs its own history ready when it becomes so.
    /// Returns the bar that just closed, if this tick landed in a new minute - null on every other
    /// tick. CdvUnderlyingState.ApplyTick uses this to raise AtmBarClosed only for the side(s)
    /// currently at ATM, the same "react to a real bar boundary, not a still-forming bar" pattern
    /// SpotUnderlyingState.BarClosed already uses.</summary>
    public Candle? ApplyPriceTick(decimal price, long tickVolume, DateTimeOffset timestamp)
    {
        var minute = new DateTimeOffset(timestamp.Year, timestamp.Month, timestamp.Day, timestamp.Hour, timestamp.Minute, 0, timestamp.Offset);
        Candle? justClosed = null;

        if (_currentBar is not { } cur || cur.Bar.Time != minute)
        {
            if (_currentBar is { } previous)
            {
                // Same still-forming-minute overlap as SpotUnderlyingState.ApplyTick can hit -
                // replace rather than duplicate a backfilled entry at the same minute.
                if (_closedBars.Count > 0 && _closedBars[^1].Bar.Time == previous.Bar.Time)
                    _closedBars[^1] = previous;
                else
                    _closedBars.Add(previous);
                justClosed = previous.Bar;
            }
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

        return justClosed;
    }

    /// <summary>Seeds this contract's own premium history from the historical backfill - see
    /// CdvUnderlyingState.SeedStrikeHistory, which calls this once per strike before any live tick
    /// has arrived for it (mirrors SpotUnderlyingState.SeedHistory's ordering).</summary>
    public void SeedHistory(IEnumerable<(Candle Bar, long Volume)> bars)
    {
        _closedBars.Clear();
        _closedBars.AddRange(bars.OrderBy(b => b.Bar.Time));
    }

    public IReadOnlyList<Candle> GetCandles()
    {
        var list = _closedBars.Select(b => b.Bar).ToList();
        if (_currentBar is { } bar) list.Add(bar.Bar);
        return list;
    }

    /// <summary>Just the fully-closed bars, no in-progress bar - what ConfluenceAlertService
    /// computes EMA9/21 against for the ATM CE/PE crossover check, same reasoning as
    /// SpotUnderlyingState.GetClosedCandles (a still-forming bar's EMA would flip-flop as its
    /// price kept moving).</summary>
    public IReadOnlyList<Candle> GetClosedCandles() => _closedBars.Select(b => b.Bar).ToList();

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

    // Per-minute CE/PE bar-proxy delta INCREMENTS (not running totals) contributed by
    // SeedStrikeHistory as each newly-tracked strike's own history comes back - see that method
    // and FinalizeCdvBackfill for why increments, not totals, are what gets accumulated here.
    private readonly Dictionary<DateTimeOffset, decimal> _backfillCeIncrements = new();
    private readonly Dictionary<DateTimeOffset, decimal> _backfillPeIncrements = new();

    // Same increments-then-finalize shape as the pair above, but for the previous trading day's
    // reference curve (see SeedPreviousDayStrike/FinalizePreviousDay) - a completely separate
    // series from _closedBars/_backfillCe/PeIncrements, never merged into today's running total.
    private readonly Dictionary<DateTimeOffset, decimal> _previousDayCeIncrements = new();
    private readonly Dictionary<DateTimeOffset, decimal> _previousDayPeIncrements = new();
    private readonly List<CdvBarPoint> _previousDaySeries = new();

    public CdvUnderlyingState(string underlying)
    {
        Underlying = underlying;
    }

    public string Underlying { get; }
    public int? AtmStrike { get; set; }
    public DateOnly? Expiry { get; set; }
    public DateTimeOffset LastUpdateUtc { get; private set; }

    /// <summary>The IST calendar date this state's accumulated CDV belongs to - null until the
    /// first successful recenter. CdvHostedService compares this against "today" on every recenter
    /// and calls Reset() the moment they differ, mirroring LiveSpreadCalculator's own CDV port
    /// (UnderlyingState.TradingDay / "freshDay"): CDV is a SESSION indicator in the source Pine
    /// script - it resets to zero at the start of every trading day - not an all-time-since-inception
    /// accumulator. Getting this wrong is exactly what made the chart's magnitude explode across
    /// days instead of oscillating within one.</summary>
    public DateOnly? TradingDay { get; set; }

    /// <summary>Wipes every strike and the whole CDV series - called by CdvHostedService the moment
    /// a new IST trading day is detected (see TradingDay). Does NOT touch Underlying itself; AtmStrike
    /// and Expiry are cleared too since RecenterAsync re-establishes them immediately after calling
    /// this, same as a fresh CdvUnderlyingState would start.</summary>
    public void Reset()
    {
        lock (_lock)
        {
            _strikes.Clear();
            _closedBars.Clear();
            _currentBar = null;
            _backfillCeIncrements.Clear();
            _backfillPeIncrements.Clear();
            _previousDayCeIncrements.Clear();
            _previousDayPeIncrements.Clear();
            _previousDaySeries.Clear();
            AtmStrike = null;
            Expiry = null;
        }
    }

    /// <summary>Registers a strike/side this underlying has never seen today, starting its
    /// RunningCdv at zero. A no-op if already tracked (re-entering the window after rolling back
    /// out must not reset its accumulated total). Returns true only the first time - the caller
    /// (CdvHostedService.RecenterAsync) uses that to know which strikes are new enough to need a
    /// historical backfill via SeedStrikeHistory.</summary>
    public bool EnsureTracked(uint securityId, decimal strike, bool isCall)
    {
        lock (_lock)
        {
            if (_strikes.ContainsKey(securityId)) return false;
            _strikes[securityId] = new CdvStrikeRuntime { SecurityId = securityId, Strike = strike, IsCall = isCall };
            return true;
        }
    }

    public bool IsTracked(uint securityId)
    {
        lock (_lock) { return _strikes.ContainsKey(securityId); }
    }

    /// <summary>True for a strike that's tracked but never got a successful SeedStrikeHistory call
    /// (its own first backfill attempt found nothing - a transient Dhan error, or authentication
    /// not ready yet at that moment) - CdvHostedService.RecenterAsync retries these alongside
    /// genuinely newly-tracked strikes on every recenter until one actually succeeds. False for an
    /// untracked securityId too (nothing to retry there - EnsureTracked handles that case).</summary>
    public bool NeedsBackfill(uint securityId)
    {
        lock (_lock) { return _strikes.TryGetValue(securityId, out var strike) && !strike.Backfilled; }
    }

    /// <summary>Every strike/side CDV has tracked today, for GET /api/cdv/{underlying}/strikes - a
    /// verification view so the exact contracts summed into the displayed CE/PE total are checkable,
    /// not just trusted. <paramref name="activeSecurityIds"/> (CdvHostedService's own subscribed-set
    /// bookkeeping) marks which are currently inside the live ATM+-8 window versus ones that rolled
    /// out earlier today but still contribute their RunningCdv to the total.</summary>
    public IReadOnlyList<CdvStrikeInfo> GetTrackedStrikes(IReadOnlySet<uint> activeSecurityIds)
    {
        lock (_lock)
        {
            return _strikes.Values
                .Select(s => new CdvStrikeInfo(s.SecurityId, s.Strike, s.IsCall, activeSecurityIds.Contains(s.SecurityId), s.RunningCdv))
                .OrderBy(s => s.Strike)
                .ThenByDescending(s => s.IsCall)
                .ToList();
        }
    }

    /// <summary>Raised when the strike currently at ATM on either side just closed a 1-minute
    /// premium bar - ConfluenceAlertService's trigger for checking that side's EMA9/21 crossover.
    /// Invoked outside _lock, same reasoning as SpotUnderlyingState.BarClosed (a subscriber calling
    /// back into this instance must never deadlock against it).</summary>
    public event Action<bool /* isCall */, Candle>? AtmBarClosed;

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
        bool? closedIsCall = null;
        Candle closedBar = default;

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

            var justClosed = strike.ApplyPriceTick(tick.LastPrice, deltaVolume, tick.ExchangeTimestamp);
            if (justClosed is { } bar && AtmStrike == strike.Strike)
            {
                closedIsCall = strike.IsCall;
                closedBar = bar;
            }

            LastUpdateUtc = DateTimeOffset.UtcNow;
            UpdateBar_NoLock(tick.ExchangeTimestamp);
        }

        if (closedIsCall is { } isCall) AtmBarClosed?.Invoke(isCall, closedBar);
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

    /// <summary>Seeds one strike's own historical premium+volume bars, called once per strike by
    /// CdvHostedService.RecenterAsync right after EnsureTracked reports it as newly tracked (so
    /// this always runs before that strike's first live tick). Does two things with two DIFFERENT
    /// slices of the same fetch: (1) seeds the strike's own FULL multi-day candle series
    /// (<paramref name="allBars"/>, via CdvStrikeRuntime.SeedHistory) - what backs the ATM CE/PE
    /// premium chart and its OBV once this strike becomes ATM, legitimately spanning several
    /// trading days like any price chart; (2) reconstructs this strike's own contribution to
    /// TODAY's CDV running total from <paramref name="todayBars"/> ONLY, via the bar-proxy delta
    /// formula (BarProxyDelta below - the same close-in-range approximation LiveSpreadCalculator's
    /// own CDV backfill uses, since historical OHLCV candles carry no real trade-by-trade buy/sell
    /// tagging the way live ticks do), weighted by delta at the CURRENT spot as a fixed reference
    /// for the day (an accepted approximation - a full per-minute historical spot series isn't
    /// available). CDV is a SESSION indicator in the source Pine script (see TradingDay/Reset) -
    /// summing bar-proxy deltas across multiple days here, like an early version of this method
    /// did, made the total compound without bound day over day instead of the source indicator's
    /// bounded, day-scoped oscillation. The strike's own RunningCdv is left seeded at its final
    /// TODAY-only backfilled value so today's live ticks continue accumulating from there instead
    /// of restarting at zero.</summary>
    /// <param name="includeInCdvHistory">Only true for the very first backfill batch of this
    /// underlying's day (see CdvHostedService's own "already seeded" guard) - a strike whose window
    /// entry comes later (a subsequent 30-minute re-center after ATM has moved) still gets its own
    /// price history seeded above, but is deliberately left OUT of the CDV reconstruction: its
    /// backfilled window overlaps in time with strikes already folded into _closedBars, and
    /// FinalizeCdvBackfill has no way to retroactively re-merge an already-flattened chronological
    /// series - the same limitation LiveSpreadCalculator's own CDV backfill accepts (it backfills
    /// only once, at the day's first recenter, and pads any later-added strike's contribution with
    /// zero instead of reconstructing it).</param>
    public void SeedStrikeHistory(uint securityId, IReadOnlyList<CandleWithVolume> allBars, IReadOnlyList<CandleWithVolume> todayBars, decimal currentSpot, bool includeInCdvHistory)
    {
        lock (_lock)
        {
            if (!_strikes.TryGetValue(securityId, out var strike) || allBars.Count == 0) return;

            strike.SeedHistory(allBars.Select(b => (b.ToCandle(), b.Volume)));
            strike.Backfilled = true;
            if (!includeInCdvHistory || todayBars.Count == 0) return;

            var weight = currentSpot > 0 ? ComputeDeltaWeight(strike.Strike, currentSpot, strike.IsCall) : 0m;
            var increments = strike.IsCall ? _backfillCeIncrements : _backfillPeIncrements;
            decimal running = 0;
            foreach (var bar in todayBars.OrderBy(b => b.Time))
            {
                var delta = BarProxyDelta(bar) * weight;
                increments[bar.Time] = increments.GetValueOrDefault(bar.Time) + delta;
                running += delta;
            }
            strike.RunningCdv = running;
        }
    }

    /// <summary>Turns every strike's backfilled per-minute increments (see SeedStrikeHistory) into
    /// one chronological CE/PE running-total series and prepends it to _closedBars - called once by
    /// CdvHostedService.RecenterAsync after a whole batch of newly-tracked strikes has been seeded,
    /// not per-strike, since the combined total needs every contributing strike's increments first.
    /// Safe to call with nothing pending (a recenter with no newly-tracked strikes) - a no-op.</summary>
    public void FinalizeCdvBackfill()
    {
        lock (_lock)
        {
            if (_backfillCeIncrements.Count == 0 && _backfillPeIncrements.Count == 0) return;

            var minutes = _backfillCeIncrements.Keys.Concat(_backfillPeIncrements.Keys).Distinct().OrderBy(t => t).ToList();
            decimal ce = 0, pe = 0;
            var seeded = new List<CdvBarPoint>(minutes.Count);
            foreach (var minute in minutes)
            {
                ce += _backfillCeIncrements.GetValueOrDefault(minute);
                pe += _backfillPeIncrements.GetValueOrDefault(minute);
                seeded.Add(new CdvBarPoint(minute, ce, pe));
            }

            // Backfilled minutes are always earlier than anything a live tick could have produced
            // (RecenterAsync backfills before subscribing new strikes), so this always belongs at
            // the front - InsertRange rather than a full re-sort of what could already be a large
            // live series.
            _closedBars.InsertRange(0, seeded);
            _backfillCeIncrements.Clear();
            _backfillPeIncrements.Clear();
        }
    }

    /// <summary>Contributes one strike's previous-trading-day bars to the reference curve (see
    /// FinalizePreviousDay) - the same bar-proxy-delta math SeedStrikeHistory's CDV path uses,
    /// weighted by delta at the CURRENT spot (today's - the same fixed-reference approximation),
    /// but into a completely separate accumulator so it never touches today's RunningCdv or
    /// _closedBars. Called once per strike, alongside SeedStrikeHistory, only for the underlying's
    /// first backfill batch of the day (same restriction and reason as includeInCdvHistory: a
    /// strike added on a later batch wasn't part of the window this reference curve covers).
    /// </summary>
    public void SeedPreviousDayStrike(uint securityId, IReadOnlyList<CandleWithVolume> previousDayBars, decimal currentSpot)
    {
        lock (_lock)
        {
            if (!_strikes.TryGetValue(securityId, out var strike) || previousDayBars.Count == 0) return;

            var weight = currentSpot > 0 ? ComputeDeltaWeight(strike.Strike, currentSpot, strike.IsCall) : 0m;
            var increments = strike.IsCall ? _previousDayCeIncrements : _previousDayPeIncrements;
            foreach (var bar in previousDayBars.OrderBy(b => b.Time))
            {
                var delta = BarProxyDelta(bar) * weight;
                increments[bar.Time] = increments.GetValueOrDefault(bar.Time) + delta;
            }
        }
    }

    /// <summary>Turns the previous day's per-strike increments into one chronological reference
    /// series - what GetPreviousDaySeries serves, shown alongside (never merged into) today's live
    /// CDV so the two trading days can be visually compared without today's total losing its own
    /// "starts at zero" meaning. Safe to call with nothing pending - a no-op.</summary>
    public void FinalizePreviousDay()
    {
        lock (_lock)
        {
            if (_previousDayCeIncrements.Count == 0 && _previousDayPeIncrements.Count == 0) return;

            var minutes = _previousDayCeIncrements.Keys.Concat(_previousDayPeIncrements.Keys).Distinct().OrderBy(t => t).ToList();
            decimal ce = 0, pe = 0;
            _previousDaySeries.Clear();
            foreach (var minute in minutes)
            {
                ce += _previousDayCeIncrements.GetValueOrDefault(minute);
                pe += _previousDayPeIncrements.GetValueOrDefault(minute);
                _previousDaySeries.Add(new CdvBarPoint(minute, ce, pe));
            }

            _previousDayCeIncrements.Clear();
            _previousDayPeIncrements.Clear();
        }
    }

    /// <summary>The previous trading day's reconstructed CDV curve - served by GET
    /// /api/cdv/{underlying}/previous-day-series, empty until the first backfill batch of the day
    /// has run.</summary>
    public IReadOnlyList<CdvBarPoint> GetPreviousDaySeries()
    {
        lock (_lock) { return new List<CdvBarPoint>(_previousDaySeries); }
    }

    /// <summary>Pine's own bar-proxy delta formula (close-in-range classification), the same
    /// fallback LiveSpreadCalculator's CDV backfill uses for historical candles - the only buy/sell
    /// split possible from OHLCV+volume alone, with no real trade-by-trade tagging.</summary>
    private static decimal BarProxyDelta(CandleWithVolume bar)
    {
        var hl = bar.High - bar.Low;
        if (hl <= 0.0001m) return 0m;
        var buyVol = (bar.Close - bar.Low) / hl * bar.Volume;
        var sellVol = (bar.High - bar.Close) / hl * bar.Volume;
        return buyVol - sellVol;
    }

    private void UpdateBar_NoLock(DateTimeOffset timestamp)
    {
        var (ceCdv, peCdv) = TotalsNoLock();
        var minute = new DateTimeOffset(timestamp.Year, timestamp.Month, timestamp.Day, timestamp.Hour, timestamp.Minute, 0, timestamp.Offset);

        if (_currentBar is not { } bar || bar.Time != minute)
        {
            if (_currentBar is { } previous)
            {
                // Same still-forming-minute overlap FinalizeCdvBackfill's reconstructed history can
                // hit (its source option candles can include Dhan's in-progress minute too) -
                // replace rather than duplicate the backfilled entry at that minute.
                if (_closedBars.Count > 0 && _closedBars[^1].Time == previous.Time)
                    _closedBars[^1] = previous;
                else
                    _closedBars.Add(previous);
            }
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

    /// <summary>How many bars EMA-smooths the raw per-minute CDV series before lookback %-change is
    /// computed - the same idea as LiveSpreadCalculator's Pine-ported "smoothLen" (default 9 there
    /// too): comparing raw, noisy per-minute CDV N bars apart would mostly measure noise, not the
    /// actual trend.</summary>
    private const int LookbackSmoothLen = 9;

    /// <summary>CE/PE %-change over each of <paramref name="lookbackBars"/> bars, computed off the
    /// EMA(LookbackSmoothLen)-smoothed CDV series - LiveSpreadCalculator's own "Multi-Lookback"
    /// table for this same Pine indicator, just with a caller-supplied (rather than fixed) set of
    /// windows. Skender.Stock.Indicators needs IQuote-shaped input for GetEma, so each CDV value is
    /// wrapped as a synthetic quote (Close = the value, the rest unused) - the same trick
    /// EmaCrossoverDetector uses for real candles.</summary>
    public LookbackTable GetLookbackTable(IReadOnlyList<int> lookbackBars)
    {
        lock (_lock)
        {
            var series = new List<CdvBarPoint>(_closedBars);
            if (_currentBar is { } bar) series.Add(bar);

            var ceEma = SmoothEma(series.Select(p => p.CeCdv).ToList());
            var peEma = SmoothEma(series.Select(p => p.PeCdv).ToList());

            var ceChanges = lookbackBars.Select(n => ComputeLookbackChange(ceEma, n)).ToList();
            var peChanges = lookbackBars.Select(n => ComputeLookbackChange(peEma, n)).ToList();

            return new LookbackTable(Underlying, ceChanges, peChanges);
        }
    }

    private static List<decimal?> SmoothEma(IReadOnlyList<decimal> values)
    {
        var quotes = values.Select((v, i) => new Quote
        {
            Date = DateTime.UnixEpoch.AddMinutes(i),
            Open = v,
            High = v,
            Low = v,
            Close = v,
            Volume = 0,
        }).ToList();

        return quotes.GetEma(LookbackSmoothLen).Select(r => r.Ema is { } e ? (decimal?)(decimal)e : null).ToList();
    }

    private static LookbackChange ComputeLookbackChange(IReadOnlyList<decimal?> emaSeries, int barsAgo)
    {
        var lastIndex = emaSeries.Count - 1;
        if (lastIndex < 0 || emaSeries[lastIndex] is not { } current) return new LookbackChange(barsAgo, null, null, null);

        var previousIndex = lastIndex - barsAgo;
        if (previousIndex < 0 || emaSeries[previousIndex] is not { } previous) return new LookbackChange(barsAgo, current, null, null);
        if (previous == 0) return new LookbackChange(barsAgo, current, previous, null);

        var percentChange = (current - previous) / Math.Abs(previous) * 100m;
        return new LookbackChange(barsAgo, current, previous, percentChange);
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

    /// <summary>Closed-only counterpart to GetAtmCandles - what ConfluenceAlertService computes
    /// EMA9/21 against on AtmBarClosed, same "never compute off a still-forming bar" reasoning as
    /// SpotUnderlyingState.GetClosedCandles.</summary>
    public IReadOnlyList<Candle> GetAtmClosedCandles(bool isCall)
    {
        lock (_lock) { return FindAtmStrikeNoLock(isCall)?.GetClosedCandles() ?? Array.Empty<Candle>(); }
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

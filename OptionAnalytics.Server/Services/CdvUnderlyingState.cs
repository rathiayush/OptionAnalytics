using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;
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

    /// <summary>Closed-only counterpart to GetVolumeBars, same "never compute off a still-forming
    /// bar" reasoning as GetClosedCandles - what a strategy averaging this contract's own volume
    /// (a volume moving average, notably) needs, since a still-forming bar's volume-so-far is not
    /// comparable to a prior bar's final total.</summary>
    public IReadOnlyList<(Candle Bar, long Volume)> GetClosedVolumeBars() => new List<(Candle, long)>(_closedBars);

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

    // Same increments-then-finalize shape as the pair above, but for EVERY PAST trading day in the
    // backfill window rather than today (see SeedHistoricalDayStrike/FinalizeHistory) - a
    // completely separate series from _closedBars/_backfillCe/PeIncrements, never merged into
    // today's running total. Keyed by IST trading day, because each day's curve has to be
    // accumulated independently: CDV is a SESSION indicator, so every day restarts at zero.
    private readonly Dictionary<DateOnly, Dictionary<DateTimeOffset, decimal>> _historyCeIncrements = new();
    private readonly Dictionary<DateOnly, Dictionary<DateTimeOffset, decimal>> _historyPeIncrements = new();

    // Every past day's finished curve, chronological, days laid end to end - each one starting at
    // its own zero. This is what makes CDV answerable across the whole backfill window instead of
    // only for today.
    private readonly List<CdvBarPoint> _historySeries = new();

    public CdvUnderlyingState(string underlying)
    {
        Underlying = underlying;
    }

    public string Underlying { get; }
    public int? AtmStrike { get; set; }
    public DateOnly? Expiry { get; set; }
    public DateTimeOffset LastUpdateUtc { get; private set; }

    /// <summary>Last underlying spot price seen - kept because the delta weighting needs a spot to
    /// measure moneyness against, and the historical OBV aggregation (GetObvSeries) runs long after
    /// the ticks that carried it. Updated on every tick and on every recenter.</summary>
    public decimal LastSpot { get; set; }

    /// <summary>The IST calendar date this state's accumulated CDV belongs to - null until the
    /// first successful recenter. CdvHostedService compares this against "today" on every recenter
    /// and calls Reset() the moment they differ, mirroring LiveSpreadCalculator's own CDV port
    /// (UnderlyingState.TradingDay / "freshDay"): CDV is a SESSION indicator in the source Pine
    /// script - it resets to zero at the start of every trading day - not an all-time-since-inception
    /// accumulator. Getting this wrong is exactly what made the chart's magnitude explode across
    /// days instead of oscillating within one.</summary>
    public DateOnly? TradingDay { get; set; }

    /// <summary>Wipes every strike and the whole CDV series - called by CdvHostedService both at
    /// the nightly IST day rollover (see TradingDay) and on a manual expiry switch
    /// (CdvHostedService.SelectExpiryAsync). Does NOT touch Underlying itself; AtmStrike and Expiry
    /// are cleared too since RecenterAsync re-establishes them immediately after calling this, same
    /// as a fresh CdvUnderlyingState would start.</summary>
    public void Reset()
    {
        lock (_lock)
        {
            _strikes.Clear();
            _closedBars.Clear();
            _currentBar = null;
            _backfillCeIncrements.Clear();
            _backfillPeIncrements.Clear();
            _historyCeIncrements.Clear();
            _historyPeIncrements.Clear();
            _historySeries.Clear();
            AtmStrike = null;
            Expiry = null;
        }

        StrikesReset?.Invoke();
    }

    /// <summary>Raised at the end of Reset() - every tracked strike's history (and RunningCdv) is
    /// gone, so any subscriber caching per-strike derived state (ConfluenceAlertService's ATM CE/PE
    /// bias, notably) must drop it too rather than keep showing a reading computed off a contract
    /// that no longer exists. Invoked outside _lock, same reasoning as AtmBarClosed - a subscriber
    /// calling back into this instance must never deadlock against it.</summary>
    public event Action? StrikesReset;

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

            // A malformed tick (a corrupt feed packet, same failure mode OptionPriceSanity's own
            // doc comment was written for) must never update PrevPrice, feed a premium candle, or
            // move RunningCdv - treated exactly as if the tick never arrived, rather than let one
            // garbage print corrupt this contract's own running state for every tick after it. No
            // logger reaches this state object (it is plain per-underlying data, not a DI service),
            // so this stays a silent drop - CdvHostedService is where a caller with logging could
            // notice this happening repeatedly, via GetStrikeCandles/GetAtmClosedVolumeBars simply
            // never advancing for the affected strike.
            if (!OptionPriceSanity.IsPlausiblePrice(tick.LastPrice)) return;

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

            if (currentSpot > 0) LastSpot = currentSpot;

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
    internal static decimal ComputeDeltaWeight(decimal strike, decimal spot, bool isCall)
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

    /// <summary>Contributes one strike's PAST-day bars - every past trading day in the backfill
    /// window, not just yesterday - to the historical CDV reconstruction, using the same
    /// bar-proxy-delta math SeedStrikeHistory's CDV path uses. Accumulated per IST trading day, so
    /// FinalizeHistory can run each day's total from its own zero: CDV is a session indicator, and
    /// carrying one day's total into the next is exactly the compounding this app had to fix once
    /// already (see TradingDay).
    ///
    /// <paramref name="spotByTime"/> is the underlying's own 1-minute spot history, used to weight
    /// each bar by the moneyness that ACTUALLY applied when it traded. That matters much more here
    /// than it does for today: a strike sitting at ATM two weeks ago can be far OTM now, and
    /// weighting it by today's spot (as the previous-day-only version did) would score its volume
    /// at near zero. Bars with no matching spot fall back to <paramref name="fallbackSpot"/>.
    ///
    /// Called once per strike, alongside SeedStrikeHistory, only for the underlying's first
    /// backfill batch of the day (same restriction and reason as includeInCdvHistory).</summary>
    public void SeedHistoricalDayStrike(
        uint securityId, IReadOnlyList<CandleWithVolume> pastBars,
        IReadOnlyDictionary<DateTimeOffset, decimal> spotByTime, decimal fallbackSpot)
    {
        lock (_lock)
        {
            if (!_strikes.TryGetValue(securityId, out var strike) || pastBars.Count == 0) return;

            foreach (var bar in pastBars.OrderBy(b => b.Time))
            {
                var spot = spotByTime.TryGetValue(bar.Time, out var atBar) && atBar > 0 ? atBar : fallbackSpot;
                if (spot <= 0) continue;

                var day = IstClock.IstDate(bar.Time);
                var byDay = strike.IsCall ? _historyCeIncrements : _historyPeIncrements;
                if (!byDay.TryGetValue(day, out var increments))
                    byDay[day] = increments = new Dictionary<DateTimeOffset, decimal>();

                var delta = BarProxyDelta(bar) * ComputeDeltaWeight(strike.Strike, spot, strike.IsCall);
                increments[bar.Time] = increments.GetValueOrDefault(bar.Time) + delta;
            }
        }
    }

    /// <summary>Turns every past day's per-strike increments into one chronological series, each
    /// day accumulated from its OWN zero and the days laid end to end. Safe to call with nothing
    /// pending - a no-op.</summary>
    public void FinalizeHistory()
    {
        lock (_lock)
        {
            if (_historyCeIncrements.Count == 0 && _historyPeIncrements.Count == 0) return;

            _historySeries.Clear();
            var days = _historyCeIncrements.Keys.Concat(_historyPeIncrements.Keys).Distinct().OrderBy(d => d);

            foreach (var day in days)
            {
                var ceIncrements = _historyCeIncrements.GetValueOrDefault(day) ?? new Dictionary<DateTimeOffset, decimal>();
                var peIncrements = _historyPeIncrements.GetValueOrDefault(day) ?? new Dictionary<DateTimeOffset, decimal>();

                var minutes = ceIncrements.Keys.Concat(peIncrements.Keys).Distinct().OrderBy(t => t);

                // Back to zero for every day - the session-indicator rule, applied per day rather
                // than only to today.
                decimal ce = 0, pe = 0;
                foreach (var minute in minutes)
                {
                    ce += ceIncrements.GetValueOrDefault(minute);
                    pe += peIncrements.GetValueOrDefault(minute);
                    _historySeries.Add(new CdvBarPoint(minute, ce, pe));
                }
            }

            _historyCeIncrements.Clear();
            _historyPeIncrements.Clear();
        }
    }

    /// <summary>The most recent PAST trading day's reconstructed CDV curve - served by GET
    /// /api/cdv/{underlying}/previous-day-series as the dashboard's reference line, unchanged in
    /// meaning now that the whole window is reconstructed rather than just this one day: it is
    /// simply the last day's slice of it.</summary>
    public IReadOnlyList<CdvBarPoint> GetPreviousDaySeries()
    {
        lock (_lock)
        {
            if (_historySeries.Count == 0) return Array.Empty<CdvBarPoint>();

            var lastDay = IstClock.IstDate(_historySeries[^1].Time);
            return _historySeries
                .Where(p => IstClock.IstDate(p.Time) == lastDay)
                .ToList();
        }
    }

    /// <summary>Every past trading day's reconstructed CDV, chronological - the multi-day history
    /// GetSmoothedCdvSeries prepends to today so a backtest can ask a CDV question about any day in
    /// the window, not only the current one.</summary>
    public IReadOnlyList<CdvBarPoint> GetHistorySeries()
    {
        lock (_lock) { return new List<CdvBarPoint>(_historySeries); }
    }

    /// <summary>Pine's own bar-proxy delta formula (close-in-range classification), the same
    /// fallback LiveSpreadCalculator's CDV backfill uses for historical candles - the only buy/sell
    /// split possible from OHLCV+volume alone, with no real trade-by-trade tagging.</summary>
    internal static decimal BarProxyDelta(CandleWithVolume bar)
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

    /// <summary>CE/PE %-change over each of <paramref name="lookbackBars"/> bars AT
    /// <paramref name="timeframeMinutes"/>, computed off GetSmoothedCdvSeries aggregated to that
    /// timeframe - the OBV counterpart's own GetObvLookbackTable does the exact same thing off
    /// GetObvSeries, and this now genuinely matches it rather than only claiming to.
    ///
    /// The timeframe argument is what makes "N bars ago" mean the same thing here as it does on the
    /// dashboard's own CDV/OBV chart, which the caller aggregates client-side to whatever timeframe
    /// is selected (1/3/5 minutes). Before this, the table always read native 1-MINUTE bars no
    /// matter what the chart was showing - on a 3-minute chart, "30 bars ago" here meant 30 minutes
    /// back, not 30 of the chart's own bars (90 minutes), so the table's longest window silently
    /// reached only a third as far as it looked like it should next to that chart. A move that
    /// unfolded over the morning could then read as a few percent on every row while the chart
    /// showed it swinging far more, with no bug in the %-math at all - the window just could not see
    /// that far back. BacktestUtil.AggregateLine is the same bucketing BacktestStrategyContext
    /// already uses to hand strategies timeframe-aware OBV/CDV series, applied here for the same
    /// reason: bucket AFTER smoothing, matching exactly how the OBV chart on the dashboard buckets
    /// its own already-smoothed series for display.
    ///
    /// This ALSO used to re-smooth CE/PE from scratch, restricted to just today's bars, instead of
    /// calling GetSmoothedCdvSeries - which prepends the prior days' history so the EMA runs
    /// continuously across the day boundary, same as OBV's. That was a real bug too (early in a
    /// session, or right after CDV crossed back near zero, both readings a window compared were
    /// still warming up from a fresh zero, so the %-change came out small no matter how far the raw
    /// total had actually moved) - fixed separately, and this call already reflects that fix.</summary>
    public LookbackTable GetLookbackTable(IReadOnlyList<int> lookbackBars, int timeframeMinutes)
    {
        var timeframe = Math.Max(1, timeframeMinutes);
        var ce = BacktestUtil.AggregateLine(GetSmoothedCdvSeries(true), timeframe).Select(p => (decimal?)p.Obv).ToList();
        var pe = BacktestUtil.AggregateLine(GetSmoothedCdvSeries(false), timeframe).Select(p => (decimal?)p.Obv).ToList();

        var ceChanges = lookbackBars.Select(n => ComputeLookbackChange(ce, n)).ToList();
        var peChanges = lookbackBars.Select(n => ComputeLookbackChange(pe, n)).ToList();

        return new LookbackTable(Underlying, ceChanges, peChanges);
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

    internal static LookbackChange ComputeLookbackChange(IReadOnlyList<decimal?> emaSeries, int barsAgo)
    {
        var lastIndex = emaSeries.Count - 1;
        if (lastIndex < 0 || emaSeries[lastIndex] is not { } current) return new LookbackChange(barsAgo, null, null, null);

        var previousIndex = lastIndex - barsAgo;
        if (previousIndex < 0 || emaSeries[previousIndex] is not { } previous) return new LookbackChange(barsAgo, current, null, null);

        // Previous exactly zero is the obvious divide-by-zero case; a SIGN FLIP between current and
        // previous (CDV crossed zero somewhere in this window, including either endpoint sitting
        // exactly on it) is the same problem in disguise - previous can be small-but-nonzero (say
        // +1.8M) right before a move to -15M, and (current-previous)/|previous|*100 then reports a
        // "-923%" that is technically arithmetic-correct but tells a trader nothing: percent change
        // only means something when both readings are on the same side of zero. Math.Sign(0) is 0,
        // so this also catches current landing exactly on zero without a separate check.
        if (previous == 0 || Math.Sign(current) != Math.Sign(previous))
            return new LookbackChange(barsAgo, current, previous, null);

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

    /// <summary>Volume counterpart to GetAtmClosedCandles - same snapshot-in-time caveat (whichever
    /// strike is ATM right now, its own full stored history) - what a volume-based strategy (a
    /// volume moving average, notably) needs, since GetAtmClosedCandles' plain Candle carries no
    /// volume at all.</summary>
    public IReadOnlyList<(Candle Bar, long Volume)> GetAtmClosedVolumeBars(bool isCall)
    {
        lock (_lock) { return FindAtmStrikeNoLock(isCall)?.GetClosedVolumeBars() ?? Array.Empty<(Candle, long)>(); }
    }

    /// <summary>Closed-bar premium history for one SPECIFIC strike (not necessarily the current
    /// ATM one) - what BacktestService needs to simulate an OTM CE/PE trade against the strike
    /// that was actually N steps OTM at a past signal's time, not just whatever happens to be ATM
    /// right now. Empty if that exact strike was never tracked (fell outside the ATM+-8 window for
    /// this underlying's whole in-memory history) - same "no data" tolerance as everywhere else in
    /// this backfill, not an error.</summary>
    public IReadOnlyList<Candle> GetStrikeClosedCandles(decimal strike, bool isCall)
    {
        lock (_lock)
        {
            var runtime = _strikes.Values.FirstOrDefault(s => s.IsCall == isCall && s.Strike == strike);
            return runtime?.GetClosedCandles() ?? Array.Empty<Candle>();
        }
    }

    /// <summary>The same history INCLUDING the still-forming bar - what a chart wants (the ATM
    /// charts get this via GetAtmCandles), as opposed to the closed-only view the indicators want.
    /// Null, not empty, when this strike isn't tracked at all, so the caller can tell "tracked but
    /// nothing yet today" apart from "not tracked, go and fetch it from Dhan".</summary>
    public IReadOnlyList<Candle>? GetStrikeCandles(decimal strike, bool isCall)
    {
        lock (_lock)
        {
            var runtime = _strikes.Values.FirstOrDefault(s => s.IsCall == isCall && s.Strike == strike);
            return runtime?.GetCandles();
        }
    }

    /// <summary>Every strike this underlying is tracking on one side, ascending - the set whose
    /// charts are already in memory and updating live.</summary>
    public IReadOnlyList<decimal> GetTrackedStrikePrices(bool isCall)
    {
        lock (_lock)
        {
            return _strikes.Values.Where(s => s.IsCall == isCall).Select(s => s.Strike).Distinct().OrderBy(s => s).ToList();
        }
    }

    /// <summary>
    /// Delta-weighted On-Balance Volume for one side, summed across every tracked strike - a direct
    /// port of the Pine "OBV Auto with Delta Weighting" indicator, in the same three stages it uses:
    ///
    ///   1. Per strike, a running cumulative sum of sign(close - previous close) * volume * |delta|,
    ///      where |delta| is the same sigmoid moneyness weight CDV uses (ComputeDeltaWeight) - so a
    ///      near-ATM contract counts for close to its full volume and a far-OTM one barely counts.
    ///      Pine's per-strike `ta.cum(math.sign(ta.change(close)) * volume * delta)`.
    ///   2. Those per-strike running totals summed across the side at each bar. Strikes start being
    ///      tracked at different times, so a strike with no bar at a given instant contributes its
    ///      last known running total (0 before its first bar) rather than dropping out of the sum -
    ///      the same carry-forward Pine's request.security + nz() ends up with.
    ///   3. Day-baselined then EMA-smoothed: each IST trading day subtracts its own first bar's
    ///      value (Pine's ceBase/`ceRawObv - ceBase`, which is what makes this a per-day measure
    ///      rather than an ever-growing total), and the result is EMA(LookbackSmoothLen)-smoothed
    ///      (Pine's smoothLen, 9 in both). The EMA deliberately runs continuously across days, as
    ///      Pine's does - only its input resets at the day boundary.
    ///
    /// The delta weight uses LastSpot for every bar rather than each bar's own historical spot -
    /// the same approximation the live CDV path makes (it weights each tick by the spot at that
    /// moment and never revisits it), and the reason both are "auto delta" approximations rather
    /// than a full Black-Scholes reconstruction.
    /// </summary>
    public IReadOnlyList<ObvPoint> GetObvSeries(bool isCall)
    {
        lock (_lock)
        {
            var aggregate = BuildAggregateObvNoLock(isCall);
            if (aggregate.Count == 0) return Array.Empty<ObvPoint>();

            var baselined = ApplyDailyBaseline(aggregate);
            var smoothed = SmoothEma(baselined.Select(p => p.Obv).ToList());

            var result = new List<ObvPoint>(baselined.Count);
            for (var i = 0; i < baselined.Count; i++)
                result.Add(new ObvPoint(baselined[i].Time, smoothed[i] ?? baselined[i].Obv));
            return result;
        }
    }

    /// <summary>Stages 1 and 2 above - every tracked strike's own cumulative delta-weighted OBV,
    /// merged onto one timeline and summed.</summary>
    private List<ObvPoint> BuildAggregateObvNoLock(bool isCall)
    {
        var spot = LastSpot;
        var perStrike = new List<List<ObvPoint>>();

        foreach (var strike in _strikes.Values.Where(s => s.IsCall == isCall))
        {
            var bars = strike.GetVolumeBars();
            if (bars.Count == 0) continue;

            var weight = spot > 0 ? ComputeDeltaWeight(strike.Strike, spot, strike.IsCall) : 1m;
            var series = new List<ObvPoint>(bars.Count);
            decimal running = 0;
            decimal? previousClose = null;

            foreach (var (bar, volume) in bars)
            {
                // The first bar has no previous close to compare against, so it contributes
                // nothing but establishes the baseline - Pine's ta.change(close) is na there too.
                if (previousClose is { } prev)
                {
                    var sign = bar.Close > prev ? 1 : bar.Close < prev ? -1 : 0;
                    running += sign * volume * weight;
                }
                previousClose = bar.Close;
                series.Add(new ObvPoint(bar.Time, running));
            }
            perStrike.Add(series);
        }

        if (perStrike.Count == 0) return new List<ObvPoint>();

        var timeline = perStrike.SelectMany(s => s.Select(p => p.Time)).Distinct().OrderBy(t => t).ToList();
        var cursors = new int[perStrike.Count];
        var lastKnown = new decimal[perStrike.Count];
        var aggregate = new List<ObvPoint>(timeline.Count);

        foreach (var time in timeline)
        {
            decimal total = 0;
            for (var i = 0; i < perStrike.Count; i++)
            {
                var series = perStrike[i];
                while (cursors[i] < series.Count && series[cursors[i]].Time <= time)
                {
                    lastKnown[i] = series[cursors[i]].Obv;
                    cursors[i]++;
                }
                total += lastKnown[i];
            }
            aggregate.Add(new ObvPoint(time, total));
        }

        return aggregate;
    }

    /// <summary>Stage 3's first half - each IST trading day restated relative to its own first bar,
    /// so the series measures "how far has this day moved" instead of an ever-growing total.</summary>
    private static List<ObvPoint> ApplyDailyBaseline(List<ObvPoint> series)
    {
        var result = new List<ObvPoint>(series.Count);
        DateOnly? currentDay = null;
        decimal dayBase = 0;

        foreach (var point in series)
        {
            var day = IstClock.IstDate(point.Time);
            if (currentDay != day)
            {
                currentDay = day;
                dayBase = point.Obv;
            }
            result.Add(new ObvPoint(point.Time, point.Obv - dayBase));
        }

        return result;
    }

    /// <summary>One leg's CDV series, EMA-smoothed exactly as GetLookbackTable smooths it before
    /// measuring %-change - so a strategy asking "has CDV surged?" is reading the same numbers the
    /// CDV lookback table shows. Note this is inherently DAY-SCOPED: CDV resets every trading day
    /// (see Reset), so this only ever covers the current day, unlike the OBV series which carries
    /// its full multi-day history.</summary>
    public IReadOnlyList<ObvPoint> GetSmoothedCdvSeries(bool isCall)
    {
        lock (_lock)
        {
            // Every past day's reconstructed curve first, then today's - so a backtest can ask a CDV
            // question about any day in the backfill window. Each day still starts at its own zero
            // (see FinalizeHistory): this concatenates day-scoped curves, it does not accumulate one
            // running total across days, which is the compounding TradingDay's doc comment warns
            // about. The EMA below deliberately runs continuously across the joins, exactly as it
            // does for OBV - only the input resets per day.
            var series = new List<CdvBarPoint>(_historySeries);
            series.AddRange(_closedBars);
            if (_currentBar is { } bar) series.Add(bar);
            if (series.Count == 0) return Array.Empty<ObvPoint>();

            var smoothed = SmoothEma(series.Select(p => isCall ? p.CeCdv : p.PeCdv).ToList());

            var result = new List<ObvPoint>(series.Count);
            for (var i = 0; i < series.Count; i++)
                result.Add(new ObvPoint(series[i].Time, smoothed[i] ?? (isCall ? series[i].CeCdv : series[i].PeCdv)));
            return result;
        }
    }

    /// <summary>CE/PE %-change over each of <paramref name="lookbackBars"/> bars AT
    /// <paramref name="timeframeMinutes"/> on the OBV series - the OBV counterpart to
    /// GetLookbackTable, and Pine's own multi-lookback table. Computed off GetObvSeries (already
    /// EMA-smoothed - Pine measures its lookback against the same smoothed `ceActive`/`peActive` it
    /// plots, not the raw sum), aggregated to the caller's timeframe exactly as the dashboard's own
    /// OBV chart buckets that same series for display - see GetLookbackTable's doc comment for why
    /// this argument exists at all (it didn't before, and every "N bars ago" silently meant N
    /// 1-minute bars regardless of what timeframe the chart next to this table was showing).</summary>
    public LookbackTable GetObvLookbackTable(IReadOnlyList<int> lookbackBars, int timeframeMinutes)
    {
        var timeframe = Math.Max(1, timeframeMinutes);
        var ce = BacktestUtil.AggregateLine(GetObvSeries(true), timeframe).Select(p => (decimal?)p.Obv).ToList();
        var pe = BacktestUtil.AggregateLine(GetObvSeries(false), timeframe).Select(p => (decimal?)p.Obv).ToList();

        var ceChanges = lookbackBars.Select(n => ComputeLookbackChange(ce, n)).ToList();
        var peChanges = lookbackBars.Select(n => ComputeLookbackChange(pe, n)).ToList();

        return new LookbackTable(Underlying, ceChanges, peChanges);
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

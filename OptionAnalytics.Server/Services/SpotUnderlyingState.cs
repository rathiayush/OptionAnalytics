using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;
using OptionAnalytics.Server.Services.Backtesting;

namespace OptionAnalytics.Server.Services;

/// <summary>In-memory candle series + latest price for one underlying (NIFTY or BANKNIFTY).
/// Written by SpotFeedHostedService as ticks arrive, read by SpotController for the initial page
/// load - a plain lock rather than anything fancier since updates are a few times a second at
/// most for two instruments.</summary>
public sealed class SpotUnderlyingState
{
    private readonly object _lock = new();
    private readonly List<Candle> _closedCandles = new();
    private Candle? _currentBar;

    // Volume counterpart to _closedCandles/_currentBar, folded in parallel rather than replacing
    // them - see SeedVolumeHistory/ApplyTick's own comments. _prevVolume is Dhan's last-seen
    // CUMULATIVE day volume for this underlying (SpotTick.Volume's own documented shape), diffed
    // per tick to get an incremental amount - the exact same PrevVolume convention
    // CdvUnderlyingState.ApplyTick already uses for option ticks.
    private readonly List<CandleWithVolume> _closedVolumeBars = new();
    private CandleWithVolume? _currentVolumeBar;
    private long? _prevVolume;

    public SpotUnderlyingState(string underlying, int step)
    {
        Underlying = underlying;
        Step = step;
    }

    public string Underlying { get; }
    public int Step { get; }
    public DhanSpotInstrument? Instrument { get; set; }
    public decimal LastPrice { get; private set; }
    public DateTimeOffset LastUpdateUtc { get; private set; }
    public DateTimeOffset? LastExchangeTimeUtc { get; private set; }

    /// <summary>Fired once a 1-minute bar finishes (the moment the NEXT bar starts, not on every
    /// tick) - EmaCrossoverAlertService is the consumer, computing EMA9/21 only against stable,
    /// fully-closed bars so a crossover alert never fires (or flip-flops) off a still-forming bar's
    /// partial price. Invoked outside the lock - see ApplyTick.</summary>
    public event Action<Candle>? BarClosed;

    /// <summary>Seeds the chart with already-closed bars from the historical backfill. Called once
    /// before the live feed starts producing its own bars; a bar for "now" (still forming) is left
    /// for the live feed to build, not backfilled.
    ///
    /// Also seeds LastPrice from the most recent bar's close when nothing has arrived from the
    /// live feed yet (LastPrice is still 0) - otherwise, whenever the market is closed (after
    /// hours, weekends, a holiday) LastPrice stays stuck at 0 forever despite the chart itself
    /// having real historical data, which left the price display and CDV's ATM resolution both
    /// dead even though there is a perfectly good "last known price" (the previous close) to work
    /// from. A live tick, whenever one does arrive, still always overwrites this immediately - see
    /// ApplyTick.</summary>
    public void SeedHistory(IEnumerable<Candle> candles)
    {
        lock (_lock)
        {
            _closedCandles.Clear();
            _closedCandles.AddRange(candles.OrderBy(c => c.Time));

            if (LastPrice <= 0 && _closedCandles.Count > 0)
            {
                LastPrice = _closedCandles[^1].Close;
                LastUpdateUtc = DateTimeOffset.UtcNow;
            }
        }
    }

    /// <summary>Volume counterpart to SeedHistory - called alongside it (never instead of it) with
    /// the SAME backfilled bars in their volume-bearing shape, now that Dhan reports real index
    /// volume (see DhanHistoricalDataService's own doc comment). Each historical bar's Volume is
    /// already a per-bar amount, not a cumulative one (unlike a live tick's SpotTick.Volume), so this
    /// needs no diffing - straight replacement, exactly like SeedHistory's own clear-then-replace.
    /// What VwapCalculator reads to build the session VWAP series a strategy like the EMA/VWAP
    /// alignment one asks for.</summary>
    public void SeedVolumeHistory(IEnumerable<CandleWithVolume> bars)
    {
        lock (_lock)
        {
            _closedVolumeBars.Clear();
            _closedVolumeBars.AddRange(bars.OrderBy(b => b.Time));
        }
    }

    /// <summary>Folds one tick into the currently-forming 1-minute bar, closing the previous bar
    /// when the tick lands in a new minute. Returns the (possibly just-started) current bar.</summary>
    public Candle ApplyTick(SpotTick tick)
    {
        Candle? justClosed = null;
        Candle result;

        lock (_lock)
        {
            LastPrice = tick.LastPrice;
            LastUpdateUtc = DateTimeOffset.UtcNow;
            LastExchangeTimeUtc = tick.ExchangeTimestamp;

            var minute = FloorToMinute(tick.ExchangeTimestamp);

            if (_currentBar is not { } bar || bar.Time != minute)
            {
                if (_currentBar is { } previous)
                {
                    // The historical backfill's last returned candle can be the still-forming
                    // minute at the moment it was queried (Dhan includes the in-progress bar, not
                    // just fully-closed ones) - the live feed then builds its OWN _currentBar for
                    // that same minute, and closing it here would otherwise append a second entry
                    // at a time _closedCandles already has one for, violating lightweight-charts'
                    // strict-ascending requirement and crashing the chart. The live version, having
                    // captured the rest of that minute's real ticks, replaces the partial
                    // backfilled one instead of duplicating it.
                    if (_closedCandles.Count > 0 && _closedCandles[^1].Time == previous.Time)
                        _closedCandles[^1] = previous;
                    else
                        _closedCandles.Add(previous);
                    justClosed = previous;
                }
                _currentBar = new Candle(minute, tick.LastPrice, tick.LastPrice, tick.LastPrice, tick.LastPrice);
            }
            else
            {
                _currentBar = bar with
                {
                    High = Math.Max(bar.High, tick.LastPrice),
                    Low = Math.Min(bar.Low, tick.LastPrice),
                    Close = tick.LastPrice,
                };
            }

            result = _currentBar.Value;

            // The very first live tick only seeds the cumulative-volume baseline - same convention
            // CdvUnderlyingState.ApplyTick uses for option ticks - so today's (or this process's)
            // entire pre-subscription volume is not counted as one giant fake delta on the first
            // tick. tick.Volume < prevVolume (a fresh trading day's counter having reset, or a
            // corrupt packet) contributes zero rather than a negative amount; _prevVolume is still
            // advanced unconditionally so the NEXT tick resumes diffing correctly either way.
            var deltaVolume = _prevVolume is { } prev && tick.Volume >= prev ? tick.Volume - prev : 0L;
            _prevVolume = tick.Volume;
            ApplyVolumeTick(tick.LastPrice, deltaVolume, minute);
        }

        // Raised outside the lock - a subscriber (EmaCrossoverAlertService) calling back into
        // this instance (e.g. GetClosedCandles) must never deadlock against it.
        if (justClosed is { } closed) BarClosed?.Invoke(closed);

        return result;
    }

    /// <summary>Folds one tick's own incremental volume into the currently-forming 1-minute volume
    /// bar, mirroring ApplyTick's own OHLC bucketing exactly (same minute boundary, same
    /// still-forming-bucket replace-on-overlap rule for a bar the historical backfill and the live
    /// feed both touched) - kept as its own parallel series rather than merged into _closedCandles/
    /// _currentBar so every existing caller of GetCandles/GetClosedCandles/ApplyTick's own return
    /// value keeps working completely unchanged. Must be called from inside the lock ApplyTick
    /// already holds.</summary>
    private void ApplyVolumeTick(decimal price, long tickVolume, DateTimeOffset minute)
    {
        if (_currentVolumeBar is not { } cur || cur.Time != minute)
        {
            if (_currentVolumeBar is { } previous)
            {
                if (_closedVolumeBars.Count > 0 && _closedVolumeBars[^1].Time == previous.Time)
                    _closedVolumeBars[^1] = previous;
                else
                    _closedVolumeBars.Add(previous);
            }
            _currentVolumeBar = new CandleWithVolume(minute, price, price, price, price, tickVolume);
        }
        else
        {
            _currentVolumeBar = cur with
            {
                High = Math.Max(cur.High, price),
                Low = Math.Min(cur.Low, price),
                Close = price,
                Volume = cur.Volume + tickVolume,
            };
        }
    }

    /// <summary>Volume-bearing counterpart to GetCandles - what VwapCalculator reads. Includes the
    /// still-forming current bar, same as GetCandles.</summary>
    public IReadOnlyList<CandleWithVolume> GetVolumeBars()
    {
        lock (_lock)
        {
            var list = new List<CandleWithVolume>(_closedVolumeBars);
            if (_currentVolumeBar is { } bar) list.Add(bar);
            return list;
        }
    }

    /// <summary>Closed-only counterpart to GetVolumeBars, same "never compute off a still-forming
    /// bar" reasoning as GetClosedCandles.</summary>
    public IReadOnlyList<CandleWithVolume> GetClosedVolumeBars()
    {
        lock (_lock) { return new List<CandleWithVolume>(_closedVolumeBars); }
    }

    public IReadOnlyList<Candle> GetCandles()
    {
        lock (_lock)
        {
            var list = new List<Candle>(_closedCandles);
            if (_currentBar is { } bar) list.Add(bar);
            return list;
        }
    }

    /// <summary>Just the fully-closed bars, no in-progress bar - what EmaCrossoverAlertService
    /// computes EMA9/21 against (see BarClosed's doc comment for why the live bar is excluded).</summary>
    public IReadOnlyList<Candle> GetClosedCandles()
    {
        lock (_lock) { return new List<Candle>(_closedCandles); }
    }

    public Candle? GetCurrentBar()
    {
        lock (_lock) { return _currentBar; }
    }

    public decimal RoundedPrice => Step > 0 && LastPrice > 0 ? Math.Round(LastPrice / Step) * Step : LastPrice;

    // Same "cheap, one pass over what GetVolumeBars already holds in memory, no Dhan call at all"
    // cost SpotController's own GET .../vwap-series endpoint already accepts (see its doc comment) -
    // at most a few hundred bars for a full trading day, trivial next to a live tick's own JSON
    // serialize-and-broadcast. Riding the existing per-tick spotUpdate push with this is what lets
    // the chart's VWAP line grow live instead of needing its own separate poll - see SpotSnapshot's
    // own doc comment on Vwap.
    // Runs on EVERY spot tick, on the Dhan receive thread every other live consumer shares - so only
    // the current session's bars are fed to VwapCalculator (session VWAP resets each IST day, so the
    // result is identical) instead of the full HistoryWindow (~45 days, ~17k bars) re-sorted per tick.
    public SpotSnapshot ToSnapshot() => new(Underlying, Step, LastPrice, RoundedPrice, LastUpdateUtc, GetCurrentBar(),
        VwapCalculator.ComputeSeries(GetCurrentSessionVolumeBars()) is { Count: > 0 } series ? series[^1].Obv : null,
        LastExchangeTimeUtc);

    /// <summary>The volume bars of the latest bar's own IST day only, oldest first - a backward scan
    /// from the end, so the cost is one session's worth of bars regardless of how much history is held.</summary>
    internal IReadOnlyList<CandleWithVolume> GetCurrentSessionVolumeBars()
    {
        lock (_lock)
        {
            var latest = _currentVolumeBar ?? (_closedVolumeBars.Count > 0 ? _closedVolumeBars[^1] : (CandleWithVolume?)null);
            if (latest is not { } last) return Array.Empty<CandleWithVolume>();

            var day = IstClock.IstDate(last.Time);
            var start = _closedVolumeBars.Count;
            while (start > 0 && IstClock.IstDate(_closedVolumeBars[start - 1].Time) == day) start--;

            var list = _closedVolumeBars.GetRange(start, _closedVolumeBars.Count - start);
            if (_currentVolumeBar is { } bar) list.Add(bar);
            return list;
        }
    }

    // IST is UTC+5:30, a whole number of minutes offset from UTC, so flooring a UTC instant to the
    // minute lands on exactly the same boundary as flooring its IST wall-clock time would - no
    // timezone conversion is actually needed for 1-minute bucketing, only for day boundaries
    // (see SpotFeedHostedService.IstToday).
    private static DateTimeOffset FloorToMinute(DateTimeOffset timestamp) =>
        new(timestamp.Year, timestamp.Month, timestamp.Day, timestamp.Hour, timestamp.Minute, 0, timestamp.Offset);
}

using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Models;

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

            var minute = FloorToMinute(tick.ExchangeTimestamp);

            if (_currentBar is not { } bar || bar.Time != minute)
            {
                if (_currentBar is { } previous)
                {
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
        }

        // Raised outside the lock - a subscriber (EmaCrossoverAlertService) calling back into
        // this instance (e.g. GetClosedCandles) must never deadlock against it.
        if (justClosed is { } closed) BarClosed?.Invoke(closed);

        return result;
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

    public SpotSnapshot ToSnapshot() => new(Underlying, Step, LastPrice, RoundedPrice, LastUpdateUtc, GetCurrentBar());

    // IST is UTC+5:30, a whole number of minutes offset from UTC, so flooring a UTC instant to the
    // minute lands on exactly the same boundary as flooring its IST wall-clock time would - no
    // timezone conversion is actually needed for 1-minute bucketing, only for day boundaries
    // (see SpotFeedHostedService.IstToday).
    private static DateTimeOffset FloorToMinute(DateTimeOffset timestamp) =>
        new(timestamp.Year, timestamp.Month, timestamp.Day, timestamp.Hour, timestamp.Minute, 0, timestamp.Offset);
}

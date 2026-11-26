namespace OptionAnalytics.Server.TrueData;

/// <summary>One trade as TrueData sent it (its own quantity, never a volume change) with the side the quote before it gives.</summary>
public sealed record TickPrint(long Seq, DateTimeOffset Time, decimal Price, long Qty, bool Buy);

/// <summary>Consecutive prints at one price on one side within a second, as one bubble (a sweep of small prints reads as the
/// one order it was). Quantity in units.</summary>
public sealed record TickBubble(DateTimeOffset Time, decimal Price, long Qty, bool Buy, int Prints);

public sealed record TickLevel(decimal Price, long Buy, long Sell);
public sealed record TickBar(DateTimeOffset Time, decimal Open, decimal High, decimal Low, decimal Close, long Buy, long Sell, int Prints, IReadOnlyList<TickLevel> Levels);
public sealed record TickQuotePoint(DateTimeOffset Time, decimal Bid, long BidQty, decimal Ask, long AskQty);
public sealed record TickMeta(string Underlying, string Symbol, int LotSize, decimal TickSize, decimal LastPrice, decimal Bid, long BidQty, decimal Ask, long AskQty,
    long Prints, long SequenceGaps, DateTimeOffset? LastTradeAt, DateOnly? Day, long BookedVolume = 0, long ExchangeVolume = 0);
public sealed record TickDay(TickMeta Meta, decimal RowSize, IReadOnlyList<TickBar> Bars, IReadOnlyList<TickBubble> Bubbles, IReadOnlyList<TickQuotePoint> Quotes);

/// <summary>
/// The day of ticks of ONE instrument for the Tick Flow page - its own store, nothing to do with OrderFlowEngine (the Order Flow
/// page's). A trade arrives with its quantity, so the footprint is exact: each print is added to its minute's price level on
/// the side the QUOTE BEFORE it gives (the last bid / ask TrueData sent before this message - a trade's own packet may already
/// show the book after it): at or through the ask = a buy, at or through the bid = a sell, between them the half of the spread
/// it is nearer, at the middle the tick rule against the last trade's price, then the last side. A crossed or locked quote
/// never decides. Memory only; a new IST day starts empty.
/// </summary>
public sealed class TickBook
{
    public const int MaxBubbles = 400_000;
    private static readonly TimeSpan Ist = TimeSpan.FromMinutes(330);
    private static readonly TimeSpan BubbleGap = TimeSpan.FromSeconds(1);

    private readonly object _lock = new();
    private readonly SortedDictionary<DateTimeOffset, MinuteBar> _minutes = new();
    private readonly List<TickBubble> _bubbles = new();
    private readonly List<TickQuotePoint> _quotes = new();
    private DateOnly? _day;
    private decimal _bid, _ask, _lastPrice, _lastQuoteBid, _lastQuoteAsk;
    private long _bidQty, _askQty, _lastSeq, _prints, _gaps, _booked, _ttqBase, _ttqLast;
    // Moves with every change of the day (a trade, a quote, a new day): a snapshot asked for again at the same version is the one already built.
    private long _version;
    private (long Version, decimal Row, long MinQty, int MaxBubbles, int MaxQuotes, TickDay Day)? _snapshot;
    private bool _lastBuy = true;
    private DateTimeOffset? _lastTradeAt;
    private DateTimeOffset _lastQuoteAt;

    public TickBook(string underlying, string symbol, int lotSize, decimal tickSize)
    {
        Underlying = underlying; Symbol = symbol; LotSize = Math.Max(1, lotSize); TickSize = tickSize;
    }

    public string Underlying { get; }
    public string Symbol { get; }
    public int LotSize { get; }
    public decimal TickSize { get; }

    private sealed class MinuteBar
    {
        public decimal Open, High, Low, Close;
        public long Buy, Sell;
        public int Prints;
        public readonly SortedDictionary<decimal, (long Buy, long Sell)> Levels = new();
        // The minute as the page reads it, kept while the minute is unchanged (a snapshot rebuilt every row of every finished minute on
        // every poll was most of the cost of a busy day's page load): its version moves with each trade into it.
        public int Version;
        public decimal CachedRow;
        public int CachedVersion = -1;
        public TickBar? Cached;
    }

    /// <summary>A best bid / ask update (a "bidask" message, or the quote in a trade's packet AFTER the trade was sided).</summary>
    public void OnQuote(DateTimeOffset time, decimal bid, long bidQty, decimal ask, long askQty)
    {
        if (bid <= 0 || ask <= 0) return;
        lock (_lock)
        {
            Roll(time);
            _version++;
            _bid = bid; _bidQty = bidQty; _ask = ask; _askQty = askQty;
            // The quote the NEXT trade is sided against (a crossed / locked one is no quote).
            if (ask > bid) (_lastQuoteBid, _lastQuoteAsk) = (bid, ask);
            // The trail: a change, at most one a second (the page draws it as a step line).
            if (_quotes.Count == 0 || time - _lastQuoteAt >= TimeSpan.FromSeconds(1)
                && (_quotes[^1].Bid != bid || _quotes[^1].Ask != ask || _quotes[^1].BidQty != bidQty || _quotes[^1].AskQty != askQty))
            {
                _quotes.Add(new TickQuotePoint(time, bid, bidQty, ask, askQty));
                _lastQuoteAt = time;
                if (_quotes.Count > 60_000) _quotes.RemoveRange(0, 10_000);
            }
        }
    }

    /// <summary>A trade. <paramref name="time"/> the exchange's (second resolution) or the arrival when it has none; the
    /// packet's own quote is applied AFTER the trade is sided.</summary>
    public void OnTrade(DateTimeOffset time, long seq, decimal price, long qty, decimal bid, long bidQty, decimal ask, long askQty, long totalVolume = 0)
    {
        if (price <= 0 || qty <= 0) return;
        // A tick of quantity 1 on a lot-sized contract is no trade: TrueData's history carries them at the day's high / low (the O / H / L
        // update - 9 in the first 5 minutes of a BANKNIFTY day, at prices outside the quote) and booked they would raise the bar's high and add a
        // row that never traded. Only its quote is taken.
        if (qty == 1 && LotSize > 1) { OnQuote(time, bid, bidQty, ask, askQty); return; }
        lock (_lock)
        {
            Roll(time);
            _version++;
            if (_lastSeq > 0 && seq > _lastSeq + 1) _gaps += seq - _lastSeq - 1;
            if (seq > 0) _lastSeq = seq;

            var qBid = _lastQuoteAsk > _lastQuoteBid ? _lastQuoteBid : 0;
            var qAsk = _lastQuoteAsk > _lastQuoteBid ? _lastQuoteAsk : 0;
            if (qBid == 0 && ask > bid && bid > 0) (qBid, qAsk) = (bid, ask); // no earlier quote: the packet's own
            var buy = Side(price, qBid, qAsk, _lastPrice, _lastBuy);
            _lastBuy = buy;
            _lastPrice = price;
            _lastTradeAt = time;
            _prints++;
            _booked += qty;
            // The exchange's own running volume against what was booked: how much of the day's trading this feed delivered.
            if (totalVolume > 0) { if (_ttqLast == 0) _ttqBase = totalVolume - qty; _ttqLast = totalVolume; }
            Add(time, price, qty, buy);
        }
        // This packet's quote is the one before the next trade.
        OnQuote(time, bid, bidQty, ask, askQty);
    }

    /// <summary>At / through the ask = buy, at / through the bid = sell, inside the spread the nearer side, at the middle the tick
    /// rule, then the last side. No quote: the tick rule.</summary>
    internal static bool Side(decimal price, decimal bid, decimal ask, decimal lastPrice, bool lastBuy)
    {
        if (bid > 0 && ask > bid)
        {
            if (price >= ask) return true;
            if (price <= bid) return false;
            var mid = (bid + ask) / 2;
            if (price > mid) return true;
            if (price < mid) return false;
        }
        if (lastPrice > 0 && price > lastPrice) return true;
        if (lastPrice > 0 && price < lastPrice) return false;
        return lastBuy;
    }

    private void Add(DateTimeOffset time, decimal price, long qty, bool buy)
    {
        var minute = new DateTimeOffset(time.Year, time.Month, time.Day, time.Hour, time.Minute, 0, time.Offset);
        if (!_minutes.TryGetValue(minute, out var bar))
            _minutes[minute] = bar = new MinuteBar { Open = price, High = price, Low = price };
        bar.High = Math.Max(bar.High, price);
        bar.Low = Math.Min(bar.Low, price);
        bar.Close = price;
        bar.Prints++;
        bar.Version++;
        if (buy) bar.Buy += qty; else bar.Sell += qty;
        bar.Levels.TryGetValue(price, out var level);
        bar.Levels[price] = buy ? (level.Buy + qty, level.Sell) : (level.Buy, level.Sell + qty);

        if (_bubbles.Count > 0 && _bubbles[^1] is { } last && last.Buy == buy && last.Price == price && time - last.Time <= BubbleGap)
            _bubbles[^1] = last with { Qty = last.Qty + qty, Prints = last.Prints + 1 };
        else
        {
            _bubbles.Add(new TickBubble(time, price, qty, buy, 1));
            if (_bubbles.Count > MaxBubbles) _bubbles.RemoveRange(0, MaxBubbles / 10);
        }
    }

    private void Roll(DateTimeOffset time)
    {
        var day = DateOnly.FromDateTime(time.ToOffset(Ist).DateTime);
        if (_day == day) return;
        _day = day;
        _minutes.Clear(); _bubbles.Clear(); _quotes.Clear();
        _version++; _snapshot = null;
        _prints = _gaps = _lastSeq = _booked = _ttqBase = _ttqLast = 0;
        _lastPrice = _lastQuoteBid = _lastQuoteAsk = 0;
    }

    /// <summary>The day so far: the minute footprints (prices grouped into <paramref name="rowSize"/> rows), the bubbles of at least
    /// <paramref name="minBubbleQty"/> units (the newest <paramref name="maxBubbles"/>) and the best bid / ask trail.</summary>
    public TickDay Snapshot(decimal rowSize, long minBubbleQty, int maxBubbles, int maxQuotes = 6000)
    {
        List<TickBar> bars;
        TickBubble[] bubbles;
        TickQuotePoint[] quotes;
        TickMeta meta;
        var row = rowSize > 0 ? rowSize : TickSize;
        var wantBubbles = Math.Max(1, maxBubbles);
        var wantQuotes = Math.Max(1, maxQuotes);
        lock (_lock)
        {
            if (_snapshot is { } c && c.Version == _version && c.Row == row && c.MinQty == minBubbleQty && c.MaxBubbles == wantBubbles && c.MaxQuotes == wantQuotes) return c.Day;
            bars = new List<TickBar>(_minutes.Count);
            foreach (var kv in _minutes) bars.Add(ToBar(kv.Key, kv.Value, row));
            // The newest bubbles that pass the filter: scanned from the end and stopped at the number asked for (a day holds up to 400 000).
            var picked = new List<TickBubble>(Math.Min(wantBubbles, 1024));
            for (var i = _bubbles.Count - 1; i >= 0 && picked.Count < wantBubbles; i--)
                if (_bubbles[i].Qty >= minBubbleQty) picked.Add(_bubbles[i]);
            picked.Reverse();
            bubbles = picked.ToArray();
            quotes = _quotes.Count <= wantQuotes ? _quotes.ToArray() : _quotes.GetRange(_quotes.Count - wantQuotes, wantQuotes).ToArray();
            meta = new TickMeta(Underlying, Symbol, LotSize, TickSize, _lastPrice, _bid, _bidQty, _ask, _askQty, _prints, _gaps, _lastTradeAt, _day, _booked, _ttqLast > 0 ? _ttqLast - _ttqBase : 0);
            var day = new TickDay(meta, row, bars, bubbles, quotes);
            _snapshot = (_version, row, minBubbleQty, wantBubbles, wantQuotes, day);
            return day;
        }
    }

    public TickMeta Meta() { lock (_lock) return new TickMeta(Underlying, Symbol, LotSize, TickSize, _lastPrice, _bid, _bidQty, _ask, _askQty, _prints, _gaps, _lastTradeAt, _day, _booked, _ttqLast > 0 ? _ttqLast - _ttqBase : 0); }

    private static TickBar ToBar(DateTimeOffset time, MinuteBar b, decimal row)
    {
        if (b.Cached is { } cached && b.CachedVersion == b.Version && b.CachedRow == row) return cached;
        var grouped = new SortedDictionary<decimal, (long Buy, long Sell)>(Comparer<decimal>.Create((x, y) => y.CompareTo(x)));
        foreach (var (price, v) in b.Levels)
        {
            var key = Math.Floor(price / row) * row;
            grouped.TryGetValue(key, out var g);
            grouped[key] = (g.Buy + v.Buy, g.Sell + v.Sell);
        }
        var bar = new TickBar(time, b.Open, b.High, b.Low, b.Close, b.Buy, b.Sell, b.Prints, grouped.Select(kv => new TickLevel(kv.Key, kv.Value.Buy, kv.Value.Sell)).ToList());
        b.Cached = bar; b.CachedRow = row; b.CachedVersion = b.Version;
        return bar;
    }
}

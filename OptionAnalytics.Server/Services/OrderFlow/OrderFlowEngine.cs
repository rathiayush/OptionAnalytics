using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Services.OrderFlow;

/// <summary>
/// Order flow for one futures contract, built from the live tick feed plus its market depth.
///
/// TRADES. Dhan sends a tick per update, not per trade, so trades are inferred: the increase in the
/// day's cumulative volume since the previous tick is the volume traded since then, at the tick's
/// last price. Its aggressor side - did a buyer lift the offer or a seller hit the bid - is Lee-Ready:
///  1. the quote rule against the book as it stood just BEFORE the trade - at/above the best ask = buy,
///     at/below the best bid = sell. "Before" is the last second of quotes, not only the latest one:
///     Dhan's depth socket often delivers the post-trade book (the lifted offer already gone) before
///     the tick that carries the trade, so the offer a buyer just took still counts as the ask;
///  2. inside the spread, the midpoint - above it = buy, below = sell;
///  3. at the midpoint, the tick rule - up from the previous trade price = buy, down = sell,
///     unchanged = same side as the last trade.
///
/// FOOTPRINT. Every trade lands in its IST minute's bar, at its price, as buy (ask-side) or sell
/// (bid-side) volume. The page re-buckets minutes into its 1/3/5/15-minute bars and price rows, and
/// derives delta, cumulative delta, imbalances, absorption and exhaustion from them.
///
/// BOOK. The 200-level book (DhanTwoHundredDepthClient) or 20-level book (DhanDepthFeedClient) while
/// one is streaming, else the Full packet's 5 levels. Sampled every SnapshotInterval for the depth
/// heatmap - stored bucketed into HeatmapBaseRow rows as compact (row, quantity) pairs, since a day
/// of 200-level snapshots kept as they arrive would run to well over a hundred MB per contract.
///
/// ICEBERGS. A price level that keeps trading while it stays in the book: once more than IcebergFactor
/// times the most quantity ever SHOWN at that level has traded there (and at least IcebergMinLots
/// lots), something larger than the display is resting - a hidden buyer at a bid, seller at an ask.
/// The episode ends when the level leaves the book (price moved through it).
///
/// Everything is the current IST day only, and resets at the next day's first tick - handing the
/// finished day to DayEnded first (OrderFlowService keeps it in memory for replay). ExportDay /
/// FromDay turn a day into a plain OrderFlowDay and back, so a past day replays through the same
/// Snapshot.
/// </summary>
public sealed class OrderFlowEngine
{
    public static readonly TimeSpan SnapshotInterval = TimeSpan.FromSeconds(2);
    /// <summary>The heatmap's finest row - every row size the page offers is a multiple of it.</summary>
    public const decimal HeatmapBaseRow = 0.5m;
    /// <summary>Levels per side in the live push's book (the ladder); the heatmap gets every level
    /// bucketed into HeatmapBaseRow rows.</summary>
    public const int LiveBookLevels = 50;
    private static readonly TimeSpan DeepBookFreshness = TimeSpan.FromSeconds(5);
    public const decimal IcebergFactor = 2m;
    public const int IcebergMinLots = 5;
    /// <summary>A SWEEP: same-side prints at most SweepGap apart and within SweepMaxDuration in all, each at
    /// the same or a worse price for the aggressor (buyers paying up, sellers hitting lower), through at
    /// least SweepMinLevels prices and SweepMinLots lots - market orders eating several levels at once
    /// (stop runs, breakouts), not a steady grind.</summary>
    public static readonly TimeSpan SweepGap = TimeSpan.FromSeconds(1);
    public static readonly TimeSpan SweepMaxDuration = TimeSpan.FromSeconds(2);
    public const int SweepMinLevels = 3;
    public const int SweepMinLots = 10;
    private const int MaxTradesKept = 50_000;
    private const int MaxIcebergsKept = 500;

    private readonly object _lock = new();
    private DateOnly _day;
    private long? _prevVolume;
    private decimal _prevLtp, _prevBid, _prevAsk;
    private int _lastSide = 1;
    private DepthLevel[] _bids = Array.Empty<DepthLevel>();
    private DepthLevel[] _asks = Array.Empty<DepthLevel>();
    private DateTimeOffset? _deepBidAt, _deepAskAt;
    private int _deepDepth = 20;
    // A restored day's depth, reported until live data arrives (a replayed day keeps saying what it had).
    private int? _importedDepth;
    // The deepest book seen today - what a saved day says it had.
    private int _dayDepth = 5;
    private DateTimeOffset _lastSnapshotAt = DateTimeOffset.MinValue;
    private DateTimeOffset? _lastTradeAt;
    // The latest event time seen - what "is the 20-level book still fresh" is judged against.
    private DateTimeOffset _clock;
    private long _sequence;

    private readonly SortedDictionary<DateTimeOffset, MinuteBar> _bars = new();
    // The day's volume at each price - the DOM's traded-volume column.
    private readonly Dictionary<decimal, LevelVolume> _dayVolume = new();
    private readonly List<OrderFlowTrade> _trades = new();
    private readonly List<DepthSnapshot> _snapshots = new();
    private readonly Dictionary<decimal, LevelEpisode> _bidEpisodes = new();
    private readonly Dictionary<decimal, LevelEpisode> _askEpisodes = new();
    private readonly List<IcebergState> _icebergs = new();

    public OrderFlowEngine(string underlying, uint securityId, string contractSymbol, string exchangeSegment, decimal tickSize, int lotSize, DateOnly? expiry = null)
    {
        Expiry = expiry;
        Underlying = underlying;
        SecurityId = securityId;
        ContractSymbol = contractSymbol;
        ExchangeSegment = exchangeSegment;
        TickSize = tickSize > 0 ? tickSize : 0.05m;
        LotSize = Math.Max(1, lotSize);
    }

    /// <summary>Raised with the finished day when the next day's first event arrives. Runs under the
    /// engine's lock - handlers must be quick and must not call back into this engine.</summary>
    public event Action<OrderFlowDay>? DayEnded;

    public string Underlying { get; }
    public uint SecurityId { get; }
    public string ContractSymbol { get; }
    public DateOnly? Expiry { get; }
    public string ExchangeSegment { get; }
    public decimal TickSize { get; }
    public int LotSize { get; }

    internal static int Classify(decimal price, decimal prevBid, decimal prevAsk, decimal prevLtp, int lastSide)
    {
        if (prevAsk > 0 && price >= prevAsk) return 1;
        if (prevBid > 0 && price <= prevBid) return -1;
        if (prevBid > 0 && prevAsk > prevBid)
        {
            var mid = (prevBid + prevAsk) / 2;
            if (price > mid) return 1;
            if (price < mid) return -1;
        }
        if (prevLtp > 0 && price > prevLtp) return 1;
        if (prevLtp > 0 && price < prevLtp) return -1;
        return lastSide;
    }

    /// <summary>The aggressor side against the quotes of the last QuoteLag (see the class comment): at or
    /// above any recent best ask (and not at a recent bid) = buy, the mirror = sell; otherwise - the book
    /// moved through the price within the window - the latest quote, midpoint and tick rule decide.</summary>
    internal static int Classify(decimal price, decimal recentAskMin, decimal recentBidMax, decimal prevBid, decimal prevAsk, decimal prevLtp, int lastSide)
    {
        var atAsk = recentAskMin > 0 && price >= recentAskMin;
        var atBid = recentBidMax > 0 && price <= recentBidMax;
        if (atAsk && !atBid) return 1;
        if (atBid && !atAsk) return -1;
        return Classify(price, prevBid, prevAsk, prevLtp, lastSide);
    }

    // The best bid / ask over the last QuoteLag (plus the current one).
    private static readonly TimeSpan QuoteLag = TimeSpan.FromSeconds(1);
    private readonly Queue<(DateTimeOffset At, decimal Bid, decimal Ask)> _recentQuotes = new();

    private void RecordQuote(DateTimeOffset now)
    {
        if (_recentQuotes.Count == 0 || _recentQuotes.Last() is var last && (last.Bid != _prevBid || last.Ask != _prevAsk))
            _recentQuotes.Enqueue((now, _prevBid, _prevAsk));
        while (_recentQuotes.Count > 1 && now - _recentQuotes.Peek().At > QuoteLag) _recentQuotes.Dequeue();
        while (_recentQuotes.Count > 64) _recentQuotes.Dequeue();
    }

    private (decimal AskMin, decimal BidMax) RecentQuotes(DateTimeOffset now)
    {
        decimal askMin = _prevAsk > 0 ? _prevAsk : decimal.MaxValue;
        var bidMax = _prevBid;
        foreach (var q in _recentQuotes)
        {
            if (now - q.At > QuoteLag) continue;
            if (q.Ask > 0) askMin = Math.Min(askMin, q.Ask);
            bidMax = Math.Max(bidMax, q.Bid);
        }
        return (askMin == decimal.MaxValue ? 0 : askMin, bidMax);
    }

    public static decimal Row(decimal price, decimal rowSize) => rowSize > 0 ? Math.Floor(price / rowSize) * rowSize : price;

    private decimal Normalize(decimal price) => Math.Round(price / TickSize, MidpointRounding.AwayFromZero) * TickSize;

    private static DateTimeOffset IstMinute(DateTimeOffset now)
    {
        var ist = now.ToOffset(IstClock.Offset);
        return new DateTimeOffset(ist.Year, ist.Month, ist.Day, ist.Hour, ist.Minute, 0, IstClock.Offset);
    }

    public void OnTick(SpotTick tick, DateTimeOffset now)
    {
        lock (_lock)
        {
            _importedDepth = null;
            RollDay(now);
            var price = tick.LastPrice > 0 ? Normalize(tick.LastPrice) : 0;

            if (_prevVolume is { } prevVolume && tick.Volume >= prevVolume)
            {
                var traded = tick.Volume - prevVolume;
                if (traded > 0 && price > 0)
                {
                    var (askMin, bidMax) = RecentQuotes(now);
                    var side = Classify(price, askMin, bidMax, _prevBid, _prevAsk, _prevLtp, _lastSide);
                    _lastSide = side;
                    AddTrade(now, price, traded, side);
                }
            }

            // The book only moves AFTER the trade is classified and attributed - the trade happened
            // against the previous book. A fresh 20-level side is not overwritten by 5 levels.
            if (tick.Bids is { Length: > 0 } bids && !Fresh(_deepBidAt, now)) _bids = bids;
            if (tick.Asks is { Length: > 0 } asks && !Fresh(_deepAskAt, now)) _asks = asks;

            _prevVolume = tick.Volume;
            if (price > 0) _prevLtp = price;
            _prevBid = _bids.Length > 0 ? _bids[0].Price : tick.BestBidPrice;
            _prevAsk = _asks.Length > 0 ? _asks[0].Price : tick.BestAskPrice;
            RecordQuote(now);
            UpdateEpisodes(now);
            MaybeSnapshot(now);
        }
    }

    public void OnDepth(DepthSidePacket packet, DateTimeOffset now)
    {
        if (packet.Levels.Length == 0) return;
        lock (_lock)
        {
            _importedDepth = null;
            RollDay(now);
            if (packet.IsBid) { _bids = packet.Levels; _deepBidAt = now; _prevBid = packet.Levels[0].Price; }
            else { _asks = packet.Levels; _deepAskAt = now; _prevAsk = packet.Levels[0].Price; }
            RecordQuote(now);
            _deepDepth = packet.Depth;
            _dayDepth = Math.Max(_dayDepth, packet.Depth);
            UpdateEpisodes(now);
            MaybeSnapshot(now);
        }
    }

    private static bool Fresh(DateTimeOffset? at, DateTimeOffset now) => at is { } t && now - t < DeepBookFreshness;

    private void RollDay(DateTimeOffset now)
    {
        var day = DateOnly.FromDateTime(now.ToOffset(IstClock.Offset).DateTime);
        if (day != _day && _day != default && DayEnded is { } dayEnded && ExportDay() is { } finished)
        {
            try { dayEnded(finished); } catch { /* replay history is best-effort; the live day goes on */ }
        }
        if (now > _clock) _clock = now;
        if (day == _day) return;
        _day = day;
        _prevVolume = null;
        _prevLtp = _prevBid = _prevAsk = 0;
        _recentQuotes.Clear();
        _bars.Clear();
        _dayDepth = 5;
        _dayVolume.Clear();
        _trades.Clear();
        _snapshots.Clear();
        _bidEpisodes.Clear();
        _askEpisodes.Clear();
        _icebergs.Clear();
        _lastTradeAt = null;
    }

    private void AddTrade(DateTimeOffset now, decimal price, long quantity, int side)
    {
        var minute = IstMinute(now);
        if (!_bars.TryGetValue(minute, out var bar))
            _bars[minute] = bar = new MinuteBar { Time = minute, Open = price, High = price, Low = price, Close = price };
        bar.High = Math.Max(bar.High, price);
        bar.Low = Math.Min(bar.Low, price);
        bar.Close = price;
        bar.Trades++;
        if (!bar.Levels.TryGetValue(price, out var level)) bar.Levels[price] = level = new LevelVolume();
        if (!_dayVolume.TryGetValue(price, out var atPrice)) _dayVolume[price] = atPrice = new LevelVolume();
        if (side > 0) { level.Buy += quantity; bar.Buy += quantity; atPrice.Buy += quantity; }
        else { level.Sell += quantity; bar.Sell += quantity; atPrice.Sell += quantity; }
        _lastTradeAt = now;

        if (quantity >= LotSize)
        {
            _trades.Add(new OrderFlowTrade(++_sequence, now, price, quantity, side > 0));
            if (_trades.Count > MaxTradesKept) _trades.RemoveRange(0, _trades.Count - MaxTradesKept);
        }

        // A seller hitting a bid that is still in the book (or a buyer lifting an offer) - possible
        // iceberg at that level.
        var book = side < 0 ? _bids : _asks;
        var displayed = QuantityAt(book, price);
        if (displayed <= 0) return;
        var episodes = side < 0 ? _bidEpisodes : _askEpisodes;
        if (!episodes.TryGetValue(price, out var episode))
            episodes[price] = episode = new LevelEpisode { Start = now, MaxDisplayed = displayed, LastDisplayed = displayed };
        episode.Traded += quantity;
        episode.MaxDisplayed = Math.Max(episode.MaxDisplayed, displayed);
    }

    private static long QuantityAt(DepthLevel[] book, decimal price)
    {
        foreach (var level in book)
            if (level.Price == price) return level.Quantity;
        return 0;
    }

    private void UpdateEpisodes(DateTimeOffset now)
    {
        Update(_bidEpisodes, _bids, isBid: true);
        Update(_askEpisodes, _asks, isBid: false);

        void Update(Dictionary<decimal, LevelEpisode> episodes, DepthLevel[] book, bool isBid)
        {
            if (episodes.Count == 0) return;
            List<decimal>? ended = null;
            foreach (var (price, episode) in episodes)
            {
                var displayed = QuantityAt(book, price);
                if (displayed <= 0)
                {
                    // The level left the book - traded through or pulled. The episode is over.
                    if (episode.Iceberg is { } done) done.EndedAt = now;
                    (ended ??= new()).Add(price);
                    continue;
                }

                if (displayed > episode.LastDisplayed && episode.Traded > episode.TradedAtLastDisplay) episode.Refills++;
                episode.MaxDisplayed = Math.Max(episode.MaxDisplayed, displayed);
                episode.LastDisplayed = displayed;
                episode.TradedAtLastDisplay = episode.Traded;

                if (episode.Iceberg is null && episode.Traded >= (long)IcebergMinLots * LotSize && episode.Traded >= IcebergFactor * episode.MaxDisplayed)
                {
                    episode.Iceberg = new IcebergState { Id = ++_sequence, IsBid = isBid, Price = price, StartedAt = episode.Start, DetectedAt = now };
                    _icebergs.Add(episode.Iceberg);
                    if (_icebergs.Count > MaxIcebergsKept) _icebergs.RemoveRange(0, _icebergs.Count - MaxIcebergsKept);
                }

                if (episode.Iceberg is { } iceberg)
                {
                    iceberg.Traded = episode.Traded;
                    iceberg.MaxDisplayed = episode.MaxDisplayed;
                    iceberg.Refills = episode.Refills;
                    iceberg.LastSeenAt = now;
                }
            }
            if (ended is not null) foreach (var price in ended) episodes.Remove(price);
        }
    }

    private void MaybeSnapshot(DateTimeOffset now)
    {
        if (now - _lastSnapshotAt < SnapshotInterval || (_bids.Length == 0 && _asks.Length == 0)) return;
        _lastSnapshotAt = now;
        _snapshots.Add(new DepthSnapshot(now, HeatRows(_bids), HeatRows(_asks)));
    }

    /// <summary>A book side bucketed into HeatmapBaseRow rows, ascending.</summary>
    internal static HeatRow[] HeatRows(DepthLevel[] levels)
    {
        if (levels.Length == 0) return Array.Empty<HeatRow>();
        var rows = new SortedDictionary<int, long>();
        foreach (var level in levels)
        {
            var row = (int)Math.Floor(level.Price / HeatmapBaseRow);
            rows.TryGetValue(row, out var quantity);
            rows[row] = quantity + level.Quantity;
        }
        return rows.Select(kv => new HeatRow(kv.Key, (int)Math.Min(kv.Value, int.MaxValue))).ToArray();
    }

    /// <summary>The IST day this engine holds, or null before its first event.</summary>
    public DateOnly? ExportDayDate() { lock (_lock) return _day == default ? null : _day; }


    /// <summary>Everything the Order Flow page loads: the day's minute footprints bucketed into
    /// <paramref name="rowSize"/>-point rows, prints of at least <paramref name="minTradeQty"/>, icebergs,
    /// the depth heatmap reduced to at most <paramref name="heatmapColumns"/> snapshots, and the book.</summary>
    public OrderFlowSnapshot Snapshot(decimal rowSize, long minTradeQty, int heatmapColumns)
    {
        lock (_lock)
        {
            var bars = _bars.Values.Select(b => ToDto(b, rowSize)).ToList();
            var trades = _trades.Where(t => t.Quantity >= minTradeQty).TakeLast(5000).ToList();
            var heatmap = new List<HeatmapColumn>();
            if (_snapshots.Count > 0)
            {
                var step = Math.Max(1, (int)Math.Ceiling(_snapshots.Count / (double)Math.Max(1, heatmapColumns)));
                for (var i = step - 1; i < _snapshots.Count + step - 1; i += step)
                {
                    var snapshot = _snapshots[Math.Min(i, _snapshots.Count - 1)];
                    heatmap.Add(new HeatmapColumn(snapshot.Time, Bucket(snapshot.Bids, rowSize), Bucket(snapshot.Asks, rowSize)));
                }
            }
            return new OrderFlowSnapshot(Meta(), rowSize, bars, trades, Icebergs(), heatmap, BookDto())
            {
                Sweeps = DetectSweeps(_trades, SweepMinLots * (long)LotSize),
            };
        }
    }

    /// <summary>The Time &amp; Sales tape: the last <paramref name="count"/> prints of at least
    /// <paramref name="minQty"/> at or before <paramref name="until"/> (null = the latest), oldest first.</summary>
    public IReadOnlyList<OrderFlowTrade> Tape(DateTimeOffset? until, int count, long minQty)
    {
        lock (_lock)
        {
            var end = _trades.Count;
            if (until is { } u)
            {
                // Prints are in time order - binary search for the first one after `until`.
                int lo = 0, hi = _trades.Count;
                while (lo < hi)
                {
                    var mid = (lo + hi) / 2;
                    if (_trades[mid].Time <= u) lo = mid + 1; else hi = mid;
                }
                end = lo;
            }
            var result = new List<OrderFlowTrade>(Math.Min(count, end));
            for (var i = end - 1; i >= 0 && result.Count < count; i--)
                if (_trades[i].Quantity >= minQty) result.Add(_trades[i]);
            result.Reverse();
            return result;
        }
    }

    /// <summary>Sweeps in a run of prints (see SweepGap): Id = the first print's sequence number, so the
    /// same sweep keeps its id across pushes.</summary>
    internal static IReadOnlyList<OrderFlowSweep> DetectSweeps(IReadOnlyList<OrderFlowTrade> trades, long minQty)
    {
        var sweeps = new List<OrderFlowSweep>();
        var start = 0;
        for (var i = 1; i <= trades.Count; i++)
        {
            var continues = i < trades.Count
                && trades[i].Buy == trades[i - 1].Buy
                && trades[i].Time - trades[i - 1].Time <= SweepGap
                && trades[i].Time - trades[start].Time <= SweepMaxDuration
                && (trades[i].Buy ? trades[i].Price >= trades[i - 1].Price : trades[i].Price <= trades[i - 1].Price);
            if (continues) continue;
            if (i - start >= SweepMinLevels)
            {
                long quantity = 0;
                var levels = new HashSet<decimal>();
                for (var k = start; k < i; k++) { quantity += trades[k].Quantity; levels.Add(trades[k].Price); }
                if (levels.Count >= SweepMinLevels && quantity >= minQty)
                    sweeps.Add(new OrderFlowSweep(trades[start].Seq, trades[start].Buy, trades[start].Time, trades[i - 1].Time,
                        trades[start].Price, trades[i - 1].Price, quantity, i - start, levels.Count));
            }
            start = i;
        }
        return sweeps;
    }

    /// <summary>The live push: the forming and the previous minute (native price levels - the page
    /// buckets them into its own rows), the book, the latest prints and recent icebergs.</summary>
    public OrderFlowLive Live()
    {
        lock (_lock)
        {
            var recentBars = _bars.Values.TakeLast(2).Select(b => ToDto(b, 0)).ToList();
            return new OrderFlowLive(Meta(), _clock, recentBars, _trades.TakeLast(40).ToList(),
                Icebergs().TakeLast(30).ToList(), BookDto(LiveBookLevels),
                new HeatmapColumn(_clock, Bucket(HeatRows(_bids), HeatmapBaseRow), Bucket(HeatRows(_asks), HeatmapBaseRow)))
            {
                Sweeps = DetectSweeps(_trades.Skip(Math.Max(0, _trades.Count - 400)).ToList(), SweepMinLots * (long)LotSize),
            };
        }
    }

    /// <summary>The DOM push: the whole book (all 200 levels per side when that feed streams), the
    /// day's traded volume at every price inside the book's range, and the latest prints.</summary>
    public OrderFlowDom Dom()
    {
        lock (_lock)
        {
            var book = BookDto();
            var prices = _bids.Concat(_asks).Select(l => l.Price).ToList();
            var low = prices.Count > 0 ? prices.Min() : 0;
            var high = prices.Count > 0 ? prices.Max() : 0;
            var volume = _dayVolume.Where(kv => kv.Key >= low && kv.Key <= high)
                .OrderByDescending(kv => kv.Key)
                .Select(kv => new FootprintLevel(kv.Key, kv.Value.Buy, kv.Value.Sell))
                .ToList();
            return new OrderFlowDom(Meta(), _clock, book, volume, _trades.TakeLast(30).ToList());
        }
    }

    /// <summary>Which depth connection this contract is on and its state - set by OrderFlowService. The
    /// meta's DepthLevels says what book has actually ARRIVED (a closed market sends none, so it shows the
    /// Full packet's 5 levels); this says what is connected and why a deeper book is missing.</summary>
    public OrderFlowDepthFeed? DepthFeed { get; set; }

    private OrderFlowMeta Meta() => new(
        Underlying, ContractSymbol, SecurityId, ExchangeSegment, LotSize, TickSize, _prevLtp, _lastTradeAt,
        Fresh(_deepBidAt, _clock) || Fresh(_deepAskAt, _clock) ? _deepDepth : _importedDepth ?? 5, _day == default ? null : _day, Expiry, DepthFeed);

    private IReadOnlyList<OrderFlowIceberg> Icebergs() => _icebergs
        .Select(i => new OrderFlowIceberg(i.Id, i.IsBid, i.Price, i.StartedAt, i.DetectedAt, i.LastSeenAt, i.EndedAt, i.Traded, i.MaxDisplayed, i.Refills))
        .ToList();

    private OrderFlowBook BookDto(int maxLevels = int.MaxValue) => new(
        _bids.Take(maxLevels).Select(l => new BookLevel(l.Price, l.Quantity, l.Orders)).ToList(),
        _asks.Take(maxLevels).Select(l => new BookLevel(l.Price, l.Quantity, l.Orders)).ToList());

    private static OrderFlowBar ToDto(MinuteBar bar, decimal rowSize)
    {
        var levels = new SortedDictionary<decimal, (long Buy, long Sell)>();
        foreach (var (price, volume) in bar.Levels)
        {
            var row = Row(price, rowSize);
            levels.TryGetValue(row, out var existing);
            levels[row] = (existing.Buy + volume.Buy, existing.Sell + volume.Sell);
        }
        return new OrderFlowBar(bar.Time, bar.Open, bar.High, bar.Low, bar.Close, bar.Buy, bar.Sell, bar.Trades,
            levels.Reverse().Select(kv => new FootprintLevel(kv.Key, kv.Value.Buy, kv.Value.Sell)).ToList());
    }

    private static IReadOnlyList<decimal[]> Bucket(HeatRow[] levels, decimal rowSize)
    {
        var rows = new SortedDictionary<decimal, long>();
        foreach (var level in levels)
        {
            var row = Row(level.Row * HeatmapBaseRow, rowSize);
            rows.TryGetValue(row, out var quantity);
            rows[row] = quantity + level.Quantity;
        }
        return rows.Select(kv => new[] { kv.Key, (decimal)kv.Value }).ToList();
    }

    private sealed class MinuteBar
    {
        public DateTimeOffset Time;
        public decimal Open, High, Low, Close;
        public long Buy, Sell;
        public int Trades;
        public readonly Dictionary<decimal, LevelVolume> Levels = new();
    }

    private sealed class LevelVolume { public long Buy, Sell; }

    private sealed class LevelEpisode
    {
        public DateTimeOffset Start;
        public long Traded, MaxDisplayed, LastDisplayed, TradedAtLastDisplay;
        public int Refills;
        public IcebergState? Iceberg;
    }

    private sealed class IcebergState
    {
        public long Id;
        public bool IsBid;
        public decimal Price;
        public DateTimeOffset StartedAt, DetectedAt, LastSeenAt;
        public DateTimeOffset? EndedAt;
        public long Traded, MaxDisplayed;
        public int Refills;
    }

    private sealed record DepthSnapshot(DateTimeOffset Time, HeatRow[] Bids, HeatRow[] Asks);

    /// <summary>A copy of the whole day (for replay once it is over). Null before the first event.</summary>
    public OrderFlowDay? ExportDay()
    {
        lock (_lock)
        {
            if (_day == default) return null;
            return new OrderFlowDay
            {
                Underlying = Underlying, SecurityId = SecurityId, ContractSymbol = ContractSymbol, ExchangeSegment = ExchangeSegment, Expiry = Expiry,
                TickSize = TickSize, LotSize = LotSize, Day = _day, Sequence = _sequence, LastPrice = _prevLtp, LastTradeAt = _lastTradeAt,
                Clock = _clock, DepthLevels = Math.Max(_dayDepth, _importedDepth ?? 5),
                Bars = _bars.Values.Select(b => new OrderFlowDay.Bar(b.Time, b.Open, b.High, b.Low, b.Close, b.Buy, b.Sell, b.Trades,
                    b.Levels.Select(kv => new FootprintLevel(kv.Key, kv.Value.Buy, kv.Value.Sell)).ToArray())).ToList(),
                Trades = _trades.ToList(),
                Icebergs = Icebergs().ToList(),
                Snapshots = _snapshots.Select(x => new OrderFlowDay.Snapshot(x.Time, x.Bids, x.Asks)).ToList(),
            };
        }
    }

    /// <summary>Loads a day (ExportDay's shape) - ignored unless it is this contract's. The live book
    /// and the previous tick are NOT carried over: a tick arriving afterwards starts from scratch, so a
    /// gap in the data is never booked as one giant print.</summary>
    public bool ImportDay(OrderFlowDay day)
    {
        if (day.SecurityId != SecurityId) return false;
        lock (_lock)
        {
            if (_day != default && _day != day.Day) return false;
            _day = day.Day;
            if (day.Clock > _clock) _clock = day.Clock;
            _sequence = Math.Max(_sequence, day.Sequence);
            if (_prevLtp == 0) _prevLtp = day.LastPrice;
            _lastTradeAt ??= day.LastTradeAt;
            if (_bars.Count == 0 && _snapshots.Count == 0) _importedDepth = day.DepthLevels;
            _dayDepth = Math.Max(_dayDepth, day.DepthLevels);

            foreach (var saved in day.Bars)
            {
                if (_bars.ContainsKey(saved.Time)) continue;
                var bar = new MinuteBar { Time = saved.Time, Open = saved.Open, High = saved.High, Low = saved.Low, Close = saved.Close, Buy = saved.Buy, Sell = saved.Sell, Trades = saved.Trades };
                foreach (var level in saved.Levels)
                {
                    bar.Levels[level.Price] = new LevelVolume { Buy = level.Buy, Sell = level.Sell };
                    if (!_dayVolume.TryGetValue(level.Price, out var atPrice)) _dayVolume[level.Price] = atPrice = new LevelVolume();
                    atPrice.Buy += level.Buy;
                    atPrice.Sell += level.Sell;
                }
                _bars[saved.Time] = bar;
            }

            var firstLiveTrade = _trades.Count > 0 ? _trades[0].Time : DateTimeOffset.MaxValue;
            _trades.InsertRange(0, day.Trades.Where(t => t.Time < firstLiveTrade));
            if (_trades.Count > MaxTradesKept) _trades.RemoveRange(0, _trades.Count - MaxTradesKept);

            var firstLiveSnapshot = _snapshots.Count > 0 ? _snapshots[0].Time : DateTimeOffset.MaxValue;
            _snapshots.InsertRange(0, day.Snapshots.Where(x => x.Time < firstLiveSnapshot).Select(x => new DepthSnapshot(x.Time, x.Bids, x.Asks)));

            var known = _icebergs.Select(i => i.Id).ToHashSet();
            _icebergs.InsertRange(0, day.Icebergs.Where(i => !known.Contains(i.Id)).Select(i => new IcebergState
            {
                Id = i.Id, IsBid = i.IsBid, Price = i.Price, StartedAt = i.StartedAt, DetectedAt = i.DetectedAt, LastSeenAt = i.LastSeenAt,
                // An episode still open when the day was saved cannot be followed any more.
                EndedAt = i.EndedAt ?? i.LastSeenAt, Traded = i.Traded, MaxDisplayed = i.MaxDisplayed, Refills = i.Refills,
            }));
                return true;
        }
    }

    /// <summary>An engine holding a saved day - what replay serves a past day's Snapshot from.</summary>
    public static OrderFlowEngine FromDay(OrderFlowDay day)
    {
        var engine = new OrderFlowEngine(day.Underlying, day.SecurityId, day.ContractSymbol, day.ExchangeSegment, day.TickSize, day.LotSize, day.Expiry);
        engine.ImportDay(day);
        return engine;
    }
}

/// <summary>A book side's heatmap row: Row x HeatmapBaseRow is the row's price.</summary>
public readonly record struct HeatRow(int Row, int Quantity);

/// <summary>One day of a contract's order flow - see OrderFlowEngine.ExportDay and OrderFlowDayStore.</summary>
public sealed class OrderFlowDay
{
    public required string Underlying { get; init; }
    public required uint SecurityId { get; init; }
    public required string ContractSymbol { get; init; }
    public required string ExchangeSegment { get; init; }
    public required decimal TickSize { get; init; }
    public required int LotSize { get; init; }
    public required DateOnly Day { get; init; }
    public DateOnly? Expiry { get; init; }
    public long Sequence { get; init; }
    public decimal LastPrice { get; init; }
    public DateTimeOffset? LastTradeAt { get; init; }
    public DateTimeOffset Clock { get; init; }
    public int DepthLevels { get; init; }
    public List<Bar> Bars { get; init; } = new();
    public List<OrderFlowTrade> Trades { get; init; } = new();
    public List<OrderFlowIceberg> Icebergs { get; init; } = new();
    public List<Snapshot> Snapshots { get; init; } = new();

    public sealed record Bar(DateTimeOffset Time, decimal Open, decimal High, decimal Low, decimal Close, long Buy, long Sell, int Trades, FootprintLevel[] Levels);
    public sealed record Snapshot(DateTimeOffset Time, HeatRow[] Bids, HeatRow[] Asks);
}

/// <summary>One inferred print of at least a lot: Buy = the buyer was the aggressor (lifted the offer).</summary>
public sealed record OrderFlowTrade(long Seq, DateTimeOffset Time, decimal Price, long Quantity, bool Buy);

/// <summary>Market orders that ate through Levels prices in one burst (see OrderFlowEngine.SweepGap):
/// Buy = buyers lifting offers from FromPrice up to ToPrice.</summary>
public sealed record OrderFlowSweep(
    long Id, bool Buy, DateTimeOffset StartedAt, DateTimeOffset EndedAt, decimal FromPrice, decimal ToPrice, long Quantity, int Prints, int Levels);

/// <summary>Volume traded at one price row of a bar: Buy = at the ask (buyers aggressive), Sell = at the bid.</summary>
public sealed record FootprintLevel(decimal Price, long Buy, long Sell);

public sealed record OrderFlowBar(
    DateTimeOffset Time, decimal Open, decimal High, decimal Low, decimal Close, long Buy, long Sell, int Trades,
    IReadOnlyList<FootprintLevel> Levels);

/// <summary>IsBid: a hidden buyer resting at a bid (else a hidden seller at an ask). Traded: volume
/// done at the level during the episode; MaxDisplayed: the most ever shown there.</summary>
public sealed record OrderFlowIceberg(
    long Id, bool IsBid, decimal Price, DateTimeOffset StartedAt, DateTimeOffset DetectedAt, DateTimeOffset LastSeenAt,
    DateTimeOffset? EndedAt, long Traded, long MaxDisplayed, int Refills);

public sealed record BookLevel(decimal Price, long Quantity, int Orders);
public sealed record OrderFlowBook(IReadOnlyList<BookLevel> Bids, IReadOnlyList<BookLevel> Asks);

/// <summary>One heatmap column: every bid/ask row as [price, quantity].</summary>
public sealed record HeatmapColumn(DateTimeOffset Time, IReadOnlyList<decimal[]> Bids, IReadOnlyList<decimal[]> Asks);

/// <summary>The DOM ladder's push - see OrderFlowEngine.Dom.</summary>
public sealed record OrderFlowDom(
    OrderFlowMeta Meta, DateTimeOffset Time, OrderFlowBook Book, IReadOnlyList<FootprintLevel> Volume, IReadOnlyList<OrderFlowTrade> Trades);

/// <summary>DepthLevels: 200 or 20 while that depth feed is streaming this contract, else 5 (0 for
/// a day estimated from candles, which has no book). Day: the IST trading day the data is for.
/// Expiry: the futures contract's expiry.</summary>
public sealed record OrderFlowMeta(
    string Underlying, string ContractSymbol, uint SecurityId, string ExchangeSegment, int LotSize, decimal TickSize,
    decimal LastPrice, DateTimeOffset? LastTradeAt, int DepthLevels, DateOnly? Day = null, DateOnly? Expiry = null, OrderFlowDepthFeed? DepthFeed = null);

/// <summary>The depth connection a live contract is on: Levels 200 / 20 / 5 (5 = the market feed's Full
/// packet only), whether it is connected, when its book last arrived, and why it is not deeper / not
/// streaming (Dhan's error, BSE, all 200-level connections taken).</summary>
public sealed record OrderFlowDepthFeed(int Levels, bool Connected, DateTimeOffset? LastBookAt, string? Note);

/// <summary>Source: "live" (built from the tick feed and depth - exact) or "estimated" (a past day
/// rebuilt from Dhan's 1-minute candles - see OrderFlowEstimator); Note explains an estimate.</summary>
public sealed record OrderFlowSnapshot(
    OrderFlowMeta Meta, decimal RowSize, IReadOnlyList<OrderFlowBar> Bars, IReadOnlyList<OrderFlowTrade> Trades,
    IReadOnlyList<OrderFlowIceberg> Icebergs, IReadOnlyList<HeatmapColumn> Heatmap, OrderFlowBook Book,
    string Source = "live", string? Note = null)
{
    public IReadOnlyList<OrderFlowSweep> Sweeps { get; init; } = Array.Empty<OrderFlowSweep>();
}

/// <summary>Time: the server's time of the latest event - what the page stamps its live heatmap
/// columns with, so they line up with the loaded history whatever this device's clock says. Book: the
/// top LiveBookLevels per side (the ladder). Heat: the WHOLE book in HeatmapBaseRow rows - the live
/// heatmap column, much smaller than 200 levels per side as they are.</summary>
public sealed record OrderFlowLive(
    OrderFlowMeta Meta, DateTimeOffset Time, IReadOnlyList<OrderFlowBar> Bars, IReadOnlyList<OrderFlowTrade> Trades,
    IReadOnlyList<OrderFlowIceberg> Icebergs, OrderFlowBook Book, HeatmapColumn? Heat = null)
{
    public IReadOnlyList<OrderFlowSweep> Sweeps { get; init; } = Array.Empty<OrderFlowSweep>();
}

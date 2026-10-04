using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Services.OrderFlow;

/// <summary>
/// Order flow for one futures contract, built from the live tick feed plus its market depth.
///
/// TRADES. Dhan sends a tick per update, not per trade, so trades are inferred: the increase in the
/// day's cumulative volume since the previous tick is the volume traded since then, at the tick's
/// last price. Its aggressor side - did a buyer lift the offer or a seller hit the bid - is the
/// standard quote rule against the book as it stood BEFORE the trade (at/above the previous best ask =
/// buy, at/below the previous best bid = sell), falling back to the tick rule (up from the previous
/// trade price = buy, down = sell, unchanged = same side as the last trade).
///
/// FOOTPRINT. Every trade lands in its IST minute's bar, at its price, as buy (ask-side) or sell
/// (bid-side) volume. The page re-buckets minutes into its 1/3/5/15-minute bars and price rows, and
/// derives delta, cumulative delta, imbalances, absorption and exhaustion from them.
///
/// BOOK. The 20-level book from DhanDepthFeedClient when it is streaming, else the Full packet's 5
/// levels. Sampled every SnapshotInterval for the depth heatmap.
///
/// ICEBERGS. A price level that keeps trading while it stays in the book: once more than IcebergFactor
/// times the most quantity ever SHOWN at that level has traded there (and at least IcebergMinLots
/// lots), something larger than the display is resting - a hidden buyer at a bid, seller at an ask.
/// The episode ends when the level leaves the book (price moved through it).
///
/// Everything is the current IST day only, and resets at the next day's first tick.
/// </summary>
public sealed class OrderFlowEngine
{
    public static readonly TimeSpan SnapshotInterval = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan DeepBookFreshness = TimeSpan.FromSeconds(5);
    public const decimal IcebergFactor = 2m;
    public const int IcebergMinLots = 5;
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
    private DateTimeOffset _lastSnapshotAt = DateTimeOffset.MinValue;
    private DateTimeOffset? _lastTradeAt;
    // The latest event time seen - what "is the 20-level book still fresh" is judged against.
    private DateTimeOffset _clock;
    private long _sequence;

    private readonly SortedDictionary<DateTimeOffset, MinuteBar> _bars = new();
    private readonly List<OrderFlowTrade> _trades = new();
    private readonly List<DepthSnapshot> _snapshots = new();
    private readonly Dictionary<decimal, LevelEpisode> _bidEpisodes = new();
    private readonly Dictionary<decimal, LevelEpisode> _askEpisodes = new();
    private readonly List<IcebergState> _icebergs = new();

    public OrderFlowEngine(string underlying, uint securityId, string contractSymbol, string exchangeSegment, decimal tickSize, int lotSize)
    {
        Underlying = underlying;
        SecurityId = securityId;
        ContractSymbol = contractSymbol;
        ExchangeSegment = exchangeSegment;
        TickSize = tickSize > 0 ? tickSize : 0.05m;
        LotSize = Math.Max(1, lotSize);
    }

    public string Underlying { get; }
    public uint SecurityId { get; }
    public string ContractSymbol { get; }
    public string ExchangeSegment { get; }
    public decimal TickSize { get; }
    public int LotSize { get; }

    internal static int Classify(decimal price, decimal prevBid, decimal prevAsk, decimal prevLtp, int lastSide)
    {
        if (prevAsk > 0 && price >= prevAsk) return 1;
        if (prevBid > 0 && price <= prevBid) return -1;
        if (prevLtp > 0 && price > prevLtp) return 1;
        if (prevLtp > 0 && price < prevLtp) return -1;
        return lastSide;
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
            RollDay(now);
            var price = tick.LastPrice > 0 ? Normalize(tick.LastPrice) : 0;

            if (_prevVolume is { } prevVolume && tick.Volume >= prevVolume)
            {
                var traded = tick.Volume - prevVolume;
                if (traded > 0 && price > 0)
                {
                    var side = Classify(price, _prevBid, _prevAsk, _prevLtp, _lastSide);
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
            UpdateEpisodes(now);
            MaybeSnapshot(now);
        }
    }

    public void OnDepth(DepthSidePacket packet, DateTimeOffset now)
    {
        if (packet.Levels.Length == 0) return;
        lock (_lock)
        {
            RollDay(now);
            if (packet.IsBid) { _bids = packet.Levels; _deepBidAt = now; _prevBid = packet.Levels[0].Price; }
            else { _asks = packet.Levels; _deepAskAt = now; _prevAsk = packet.Levels[0].Price; }
            UpdateEpisodes(now);
            MaybeSnapshot(now);
        }
    }

    private static bool Fresh(DateTimeOffset? at, DateTimeOffset now) => at is { } t && now - t < DeepBookFreshness;

    private void RollDay(DateTimeOffset now)
    {
        if (now > _clock) _clock = now;
        var day = DateOnly.FromDateTime(now.ToOffset(IstClock.Offset).DateTime);
        if (day == _day) return;
        _day = day;
        _prevVolume = null;
        _prevLtp = _prevBid = _prevAsk = 0;
        _bars.Clear();
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
        if (side > 0) { level.Buy += quantity; bar.Buy += quantity; }
        else { level.Sell += quantity; bar.Sell += quantity; }
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
        _snapshots.Add(new DepthSnapshot(now, _bids, _asks));
    }

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
            return new OrderFlowSnapshot(Meta(), rowSize, bars, trades, Icebergs(), heatmap, BookDto());
        }
    }

    /// <summary>The live push: the forming and the previous minute (native price levels - the page
    /// buckets them into its own rows), the book, the latest prints and recent icebergs.</summary>
    public OrderFlowLive Live()
    {
        lock (_lock)
        {
            var recentBars = _bars.Values.TakeLast(2).Select(b => ToDto(b, 0)).ToList();
            return new OrderFlowLive(Meta(), _clock, recentBars, _trades.TakeLast(40).ToList(),
                Icebergs().TakeLast(30).ToList(), BookDto());
        }
    }

    private OrderFlowMeta Meta() => new(
        Underlying, ContractSymbol, SecurityId, ExchangeSegment, LotSize, TickSize, _prevLtp, _lastTradeAt,
        Fresh(_deepBidAt, _clock) || Fresh(_deepAskAt, _clock) ? 20 : 5);

    private IReadOnlyList<OrderFlowIceberg> Icebergs() => _icebergs
        .Select(i => new OrderFlowIceberg(i.Id, i.IsBid, i.Price, i.StartedAt, i.DetectedAt, i.LastSeenAt, i.EndedAt, i.Traded, i.MaxDisplayed, i.Refills))
        .ToList();

    private OrderFlowBook BookDto() => new(
        _bids.Select(l => new BookLevel(l.Price, l.Quantity, l.Orders)).ToList(),
        _asks.Select(l => new BookLevel(l.Price, l.Quantity, l.Orders)).ToList());

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

    private static IReadOnlyList<decimal[]> Bucket(DepthLevel[] levels, decimal rowSize)
    {
        var rows = new SortedDictionary<decimal, long>();
        foreach (var level in levels)
        {
            var row = Row(level.Price, rowSize);
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

    private sealed record DepthSnapshot(DateTimeOffset Time, DepthLevel[] Bids, DepthLevel[] Asks);
}

/// <summary>One inferred print of at least a lot: Buy = the buyer was the aggressor (lifted the offer).</summary>
public sealed record OrderFlowTrade(long Seq, DateTimeOffset Time, decimal Price, long Quantity, bool Buy);

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

/// <summary>DepthLevels: 20 while the 20-level depth feed is streaming this contract, else 5.</summary>
public sealed record OrderFlowMeta(
    string Underlying, string ContractSymbol, uint SecurityId, string ExchangeSegment, int LotSize, decimal TickSize,
    decimal LastPrice, DateTimeOffset? LastTradeAt, int DepthLevels);

public sealed record OrderFlowSnapshot(
    OrderFlowMeta Meta, decimal RowSize, IReadOnlyList<OrderFlowBar> Bars, IReadOnlyList<OrderFlowTrade> Trades,
    IReadOnlyList<OrderFlowIceberg> Icebergs, IReadOnlyList<HeatmapColumn> Heatmap, OrderFlowBook Book);

/// <summary>Time: the server's time of the latest event - what the page stamps its live heatmap
/// columns with, so they line up with the loaded history whatever this device's clock says.</summary>
public sealed record OrderFlowLive(
    OrderFlowMeta Meta, DateTimeOffset Time, IReadOnlyList<OrderFlowBar> Bars, IReadOnlyList<OrderFlowTrade> Trades,
    IReadOnlyList<OrderFlowIceberg> Icebergs, OrderFlowBook Book);

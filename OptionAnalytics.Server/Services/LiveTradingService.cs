using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Real-money manual trading from the OI Replay page's trade panel (its Live mode), plus the
/// account's live positions with their P&amp;L.
///
/// Orders go out exactly like a live strategy trigger's (StrategyTriggerHostedService): a Dhan Super
/// Order - entry LIMIT plus target and stop-loss legs Dhan manages after the fill - priced off the
/// contract's live best ASK (buy) or BID (sell), never the last traded price, with the given slippage
/// beyond it so it fills at once in practice; INTRADAY; sliced at the exchange freeze limit.
///
/// Positions are Dhan's own (GET /positions, with each position's super-order legs from
/// GET /super/orders) - so after a restart they come straight back from Dhan, and any position on
/// the account shows, whatever opened it. They are read from REST once at start-up and whenever Dhan's
/// order-update socket (re)connects; after that they are EVENT-DRIVEN: each socket message
/// (DhanOrderUpdateFeed) is applied to the in-memory orders and positions - status, legs, and every new
/// fill at its price (ApplyOrderUpdate) - with no REST polling (only while the socket is down does a
/// 30-second fallback read run). P&amp;L moves with the live tick feed: every open position's
/// contract is subscribed on the shared Dhan feed, and each tick re-prices it and pushes the
/// "livePositions" snapshot to the admin-only "positions" group through the conflated batcher.
/// </summary>
public sealed class LiveTradingService : BackgroundService
{
    public const string PositionsGroup = "positions";
    private const string ProductType = "INTRADAY";
    // Only while Dhan's order-update socket is DOWN: with it up, nothing is polled - see ApplyOrderUpdate.
    private static readonly TimeSpan FallbackRefreshWhileSocketDown = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan QuoteWait = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan SliceCallDelay = TimeSpan.FromMilliseconds(250);
    private static readonly TimeSpan ExitCheckInterval = TimeSpan.FromSeconds(2);
    private const int MaxExitAttempts = 6;
    private static readonly string[] PendingStatuses = { "PENDING", "TRANSIT", "PART_TRADED" };
    /// <summary>A stop-loss order an EARLIER version of partial exit placed to protect the rest of a
    /// position, its tag carrying the target ("OIRP-T{target in paise}-..." - see TargetFromTag). No longer
    /// placed (a partial exit now leaves the super order as it is); any still working today keep being
    /// shown, watched for their target and cancelled by Close / Exit all.</summary>
    internal const string ProtectionPrefix = "OIRP-";

    private readonly DhanPositionsClient _positions;
    private readonly DhanSuperOrderClient _superOrders;
    private readonly DhanOrderClient _orders;
    private readonly DhanOptionChainMaster _chain;
    private readonly DhanMarketFeedClient _feed;
    private readonly DhanSession _session;
    private readonly DhanOrderUpdateFeed _orderUpdates;
    private readonly LiveBroadcastBatcher _batcher;
    private readonly ILogger<LiveTradingService> _logger;
    private readonly int _maxLots;

    private readonly object _lock = new();
    private IReadOnlyList<DhanPosition> _currentPositions = Array.Empty<DhanPosition>();
    private IReadOnlyList<SuperOrderSummary> _currentOrders = Array.Empty<SuperOrderSummary>();
    private IReadOnlyList<PlainOrderSummary> _currentPlainOrders = Array.Empty<PlainOrderSummary>();
    private HashSet<uint> _trackedSecurityIds = new();
    // Protection orders (OIRP-) with a target, by security - watched on every tick (see OnTick).
    private Dictionary<uint, List<ProtectionOrder>> _protections = new();
    private readonly HashSet<string> _firingTargets = new();
    private DateTimeOffset? _refreshedUtc;
    private DateTimeOffset? _lastEventUtc;
    // Traded quantity (and average price) already counted into positions, per order and super-order leg -
    // so a socket message moves a position by exactly the NEW fill (see ApplyOrderUpdate).
    private Dictionary<(string OrderId, int Leg), (int Qty, decimal? Avg)> _fills = new();
    // Keys counted from the socket since the last REST read - the only ones carried over a read that
    // does not list their order yet (everything else is re-seeded, so nothing outlives the day).
    private readonly HashSet<(string OrderId, int Leg)> _fillsSinceRefresh = new();
    private bool _refreshing;
    private bool _eventDuringRefresh;
    private DateOnly _refreshedDay;
    // Contracts this service subscribed for live P&L, with their expiry - released once expired.
    private readonly Dictionary<uint, DateOnly> _subscribedForPositions = new();
    private readonly SemaphoreSlim _refreshSignal = new(0, 1);
    private readonly SemaphoreSlim _actionLock = new(1, 1);
    private IDisposable? _tickSubscription;

    public LiveTradingService(
        DhanPositionsClient positions, DhanSuperOrderClient superOrders, DhanOrderClient orders,
        DhanOptionChainMaster chain, DhanMarketFeedClient feed, DhanSession session, DhanOrderUpdateFeed orderUpdates,
        LiveBroadcastBatcher batcher, ILogger<LiveTradingService> logger, IConfiguration? configuration = null)
    {
        _positions = positions;
        _superOrders = superOrders;
        _orders = orders;
        _chain = chain;
        _feed = feed;
        _session = session;
        _orderUpdates = orderUpdates;
        _batcher = batcher;
        _logger = logger;
        // A hard ceiling on one manual order, whatever the panel sends - a typo of 100 for 10 lots
        // must not reach the exchange. ManualTrading__MaxLots raises it.
        _maxLots = configuration?.GetValue("ManualTrading:MaxLots", 20) ?? 20;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _tickSubscription = _feed.AddTickConsumer("Positions", OnTick);
        _orderUpdates.OrderUpdated += ApplyOrderUpdate;
        _orderUpdates.Connected += RequestRefresh;
        try
        {
            var refresh = true;
            while (!stoppingToken.IsCancellationRequested)
            {
                if (refresh)
                {
                    try
                    {
                        await RefreshAsync(stoppingToken);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        _logger.LogWarning(ex, "Live positions refresh failed.");
                    }
                }

                // Event-driven: the next REST read happens only when asked for - the order-update socket
                // (re)connecting, an order it reports that is not in memory yet, or a fill that raced a
                // read. Only while that socket is down does the 30s wake-up read anyway.
                bool signalled;
                try { signalled = await _refreshSignal.WaitAsync(FallbackRefreshWhileSocketDown, stoppingToken); }
                catch (OperationCanceledException) { break; }
                bool newDay;
                lock (_lock) newDay = _refreshedUtc is not null && _refreshedDay != IstClock.Today();
                refresh = signalled || !_orderUpdates.IsConnected || newDay;
                if (newDay) await ReleaseExpiredSubscriptionsAsync(stoppingToken);
                if (!refresh) continue;
                // Coalesce a burst of order updates (entry + both legs land together) into one refresh.
                try { await Task.Delay(TimeSpan.FromMilliseconds(400), stoppingToken); }
                catch (OperationCanceledException) { break; }
            }
        }
        finally
        {
            _orderUpdates.OrderUpdated -= ApplyOrderUpdate;
            _orderUpdates.Connected -= RequestRefresh;
            _tickSubscription?.Dispose();
        }
    }

    public void RequestRefresh()
    {
        if (_refreshSignal.CurrentCount == 0)
        {
            try { _refreshSignal.Release(); } catch (SemaphoreFullException) { }
        }
    }

    /// <summary>After this panel's own action: the order-update socket reports what it did (the order
    /// placed, cancelled, filled), so a REST read is needed only while that socket is down.</summary>
    private void RefreshUnlessStreaming()
    {
        if (!_orderUpdates.IsConnected) RequestRefresh();
    }

    /// <summary>Reads positions and both order books from Dhan's REST API - at start-up, when the
    /// order-update socket (re)connects, and when an update can't be applied from memory alone.</summary>
    public async Task RefreshAsync(CancellationToken cancellationToken)
    {
        if (!_session.IsAuthenticated) return;
        lock (_lock) { _refreshing = true; _eventDuringRefresh = false; }
        IReadOnlyList<DhanPosition> positions;
        IReadOnlyList<SuperOrderSummary> orders;
        IReadOnlyList<PlainOrderSummary> plainOrders;
        try
        {
            positions = await _positions.ListAsync(cancellationToken);
            orders = await _superOrders.ListAsync(cancellationToken);
            plainOrders = await _orders.ListAsync(cancellationToken);
        }
        catch
        {
            lock (_lock) _refreshing = false;
            throw;
        }

        // Every open position's contract streams on the shared feed (Full mode, for bid/ask) - that
        // is what moves its P&L without asking Dhan's REST API.
        var toSubscribe = new Dictionary<uint, string>();
        var tracked = new HashSet<uint>();
        foreach (var position in positions.Where(p => p.IsOpen))
        {
            if (!uint.TryParse(position.SecurityId, out var id)) continue;
            tracked.Add(id);
            if (!_feed.IsSubscribed(id)) toSubscribe[id] = position.ExchangeSegment;
            RememberSubscription(id);
        }
        if (toSubscribe.Count > 0) await _feed.SubscribeAsync(toSubscribe, cancellationToken, full: true);

        bool raced;
        lock (_lock)
        {
            _currentPositions = positions;
            _currentOrders = orders;
            _currentPlainOrders = plainOrders;
            _trackedSecurityIds = tracked;
            _protections = BuildProtections(positions, plainOrders);
            // An order the books do not list yet keeps what the socket already counted for it, so its
            // next message is not counted twice.
            var seeded = SeedFills(orders, plainOrders);
            foreach (var key in _fillsSinceRefresh)
                if (_fills.TryGetValue(key, out var value)) seeded.TryAdd(key, value);
            _fills = seeded;
            _fillsSinceRefresh.Clear();
            _refreshedDay = IstClock.Today();
            _refreshedUtc = DateTimeOffset.UtcNow;
            raced = _eventDuringRefresh;
            _refreshing = false;
        }
        // An update that arrived while the books were being read may or may not be in them - one more
        // read once things settle makes the in-memory state exact again.
        if (raced) RequestRefresh();
        Push();
    }

    private void RememberSubscription(uint id)
    {
        lock (_subscribedForPositions)
            if (!_subscribedForPositions.ContainsKey(id) && _chain.FindBySecurityId(id) is { } contract) _subscribedForPositions[id] = contract.Expiry;
    }

    /// <summary>At a new IST day, stops streaming the contracts subscribed for live P&amp;L that have expired
    /// since - nothing else can need a contract that no longer trades, and without this a server that
    /// stays up for weeks would keep every option it ever held a position in on the shared feed.</summary>
    private async Task ReleaseExpiredSubscriptionsAsync(CancellationToken cancellationToken)
    {
        List<uint> expired;
        var today = IstClock.Today();
        lock (_subscribedForPositions)
        {
            expired = _subscribedForPositions.Where(kv => kv.Value < today).Select(kv => kv.Key).ToList();
            foreach (var id in expired) _subscribedForPositions.Remove(id);
        }
        if (expired.Count == 0) return;
        try { await _feed.UnsubscribeAsync(expired, cancellationToken); }
        catch (Exception ex) when (ex is not OperationCanceledException) { _logger.LogWarning(ex, "Releasing {Count} expired position contract(s) from the feed failed.", expired.Count); }
    }

    /// <summary>Protection orders (OIRP-) with a target, for the open positions they guard.</summary>
    private static Dictionary<uint, List<ProtectionOrder>> BuildProtections(IReadOnlyList<DhanPosition> positions, IReadOnlyList<PlainOrderSummary> plainOrders)
    {
        var protections = new Dictionary<uint, List<ProtectionOrder>>();
        foreach (var order in plainOrders.Where(o => PendingStatuses.Contains(o.OrderStatus) && IsProtection(o)))
        {
            if (!uint.TryParse(order.SecurityId, out var id) || TargetFromTag(order.CorrelationId) is not { } target) continue;
            var position = positions.FirstOrDefault(p => p.SecurityId == order.SecurityId && p.IsOpen);
            if (position is null) continue;
            (protections.TryGetValue(id, out var list) ? list : protections[id] = new()).Add(
                new ProtectionOrder(order.OrderId, id, position.ExchangeSegment, order.TransactionType == "SELL", target, position.TradingSymbol));
        }
        return protections;
    }

    /// <summary>What the REST books say has already traded - the baseline each socket message's traded
    /// quantity is compared against. Plain orders are leg 0; a super order's entry is leg 1, its
    /// stop-loss 2 and target 3 (the socket's LegNo).</summary>
    internal static Dictionary<(string OrderId, int Leg), (int Qty, decimal? Avg)> SeedFills(
        IReadOnlyList<SuperOrderSummary> orders, IReadOnlyList<PlainOrderSummary> plainOrders)
    {
        var fills = new Dictionary<(string, int), (int, decimal?)>();
        foreach (var o in plainOrders) fills[(o.OrderId, 0)] = (o.FilledQty, null);
        foreach (var o in orders)
        {
            fills[(o.OrderId, 1)] = (o.FilledQty ?? (o.OrderStatus == "TRADED" ? o.Quantity : 0), null);
            foreach (var leg in o.LegDetails)
            {
                var legNo = LegNumber(leg.LegName);
                if (legNo == 0) continue;
                fills[(o.OrderId, legNo)] = (leg.OrderStatus == "TRADED" ? leg.TriggeredQuantity ?? o.Quantity : 0, null);
            }
        }
        return fills;
    }

    private static int LegNumber(string legName) => legName switch { "ENTRY_LEG" => 1, "STOP_LOSS_LEG" => 2, "TARGET_LEG" => 3, _ => 0 };
    private static string LegName(int legNo) => legNo switch { 2 => "STOP_LOSS_LEG", 3 => "TARGET_LEG", _ => "ENTRY_LEG" };

    /// <summary>
    /// One message from Dhan's order-update socket, applied straight to the in-memory books - no REST
    /// call: the order's status, traded and remaining quantity (a super order's entry, stop-loss or target
    /// leg by LegNo), and any NEW traded quantity moved into its position at the fill's price (worked out
    /// from the average traded price before and after). P&amp;L then moves on the contract's ticks.
    /// Only a super order not yet in memory (its legs' prices come from the super-order book) asks for a
    /// REST read, as does a fill whose price can't be told.
    /// </summary>
    internal void ApplyOrderUpdate(DhanOrderUpdate u)
    {
        if (string.IsNullOrEmpty(u.OrderNo) || string.IsNullOrEmpty(u.SecurityId)) return;
        var needsRead = false;
        KeyValuePair<uint, string>? subscribe = null;
        lock (_lock)
        {
            if (_refreshing) _eventDuringRefresh = true;
            _lastEventUtc = DateTimeOffset.UtcNow;

            // 1. The order books.
            if (u.IsSuperOrder)
            {
                var orders = _currentOrders.ToList();
                var index = orders.FindIndex(o => o.OrderId == u.OrderNo);
                if (index < 0) needsRead = true;
                else
                {
                    orders[index] = ApplyToSuperOrder(orders[index], u);
                    _currentOrders = orders;
                }
            }
            else
            {
                var plain = _currentPlainOrders.ToList();
                var index = plain.FindIndex(o => o.OrderId == u.OrderNo);
                if (index >= 0)
                {
                    var o = plain[index];
                    plain[index] = o with
                    {
                        OrderStatus = u.Status.Length > 0 ? u.Status : o.OrderStatus,
                        Quantity = u.Quantity > 0 ? u.Quantity : o.Quantity,
                        FilledQty = Math.Max(o.FilledQty, u.TradedQty),
                        Price = u.Price > 0 ? u.Price : o.Price,
                        OmsErrorDescription = u.Status == "REJECTED" ? u.Reason ?? o.OmsErrorDescription : o.OmsErrorDescription,
                        OrderType = u.OrderType,
                        TriggerPrice = u.TriggerPrice > 0 ? u.TriggerPrice : o.TriggerPrice,
                    };
                }
                else
                {
                    plain.Add(new PlainOrderSummary(u.OrderNo, u.Status, u.SecurityId, u.TransactionType, u.Quantity, u.TradedQty, u.Price,
                        u.CorrelationId, u.Status == "REJECTED" ? u.Reason : null) { OrderType = u.OrderType, TriggerPrice = u.TriggerPrice > 0 ? u.TriggerPrice : null });
                }
                _currentPlainOrders = plain;
            }

            // 2. New traded quantity into the position.
            var key = (u.OrderNo, u.IsSuperOrder ? Math.Max(1, u.LegNo) : 0);
            var seen = _fills.TryGetValue(key, out var s) ? s : (Qty: 0, Avg: (decimal?)null);
            if (u.TradedQty > seen.Qty)
            {
                var quantity = u.TradedQty - seen.Qty;
                var price = FillPrice(seen.Qty, seen.Avg, u);
                if (price is { } px)
                {
                    var positions = _currentPositions.ToList();
                    var index = positions.FindIndex(p => p.SecurityId == u.SecurityId && p.ProductType == u.ProductType);
                    if (index < 0) index = positions.FindIndex(p => p.SecurityId == u.SecurityId);
                    var existing = index >= 0 ? positions[index] : null;
                    uint.TryParse(u.SecurityId, out var id);
                    var symbol = existing?.TradingSymbol ?? _chain.FindBySecurityId(id)?.TradingSymbol ?? u.Symbol ?? u.SecurityId;
                    var updated = ApplyFill(existing, u, quantity, px, symbol);
                    if (index >= 0) positions[index] = updated; else positions.Add(updated);
                    _currentPositions = positions;
                    if (updated.IsOpen && id != 0)
                    {
                        if (_trackedSecurityIds.Add(id) && !_feed.IsSubscribed(id)) subscribe = new(id, updated.ExchangeSegment);
                        RememberSubscription(id);
                    }
                    else if (!updated.IsOpen) _trackedSecurityIds.Remove(id);
                    _fills[key] = (u.TradedQty, u.AvgTradedPrice > 0 ? u.AvgTradedPrice : null);
                    _fillsSinceRefresh.Add(key);
                }
                else needsRead = true;
            }
            else if (u.AvgTradedPrice > 0 && seen.Avg is null && u.TradedQty == seen.Qty && seen.Qty > 0)
            {
                _fills[key] = (seen.Qty, u.AvgTradedPrice);
            }

            _protections = BuildProtections(_currentPositions, _currentPlainOrders);
        }

        if (subscribe is { } sub)
        {
            _ = Task.Run(async () =>
            {
                try { await _feed.SubscribeAsync(new Dictionary<uint, string> { [sub.Key] = sub.Value }, CancellationToken.None, full: true); }
                catch (Exception ex) { _logger.LogWarning(ex, "Subscribing {SecurityId} for live P&L failed.", sub.Key); }
            });
        }
        if (needsRead) RequestRefresh();
        Push();
    }

    private static SuperOrderSummary ApplyToSuperOrder(SuperOrderSummary order, DhanOrderUpdate u)
    {
        if (u.LegNo is 2 or 3)
        {
            var name = LegName(u.LegNo);
            var legs = order.LegDetails.ToList();
            var index = legs.FindIndex(l => l.LegName == name);
            // A stop-loss leg's price is its trigger; a target leg's is its limit.
            var price = u.LegNo == 2 ? (u.TriggerPrice > 0 ? u.TriggerPrice : u.Price) : u.Price;
            if (index >= 0)
            {
                var leg = legs[index];
                legs[index] = leg with
                {
                    OrderStatus = u.Status.Length > 0 ? u.Status : leg.OrderStatus,
                    Price = price > 0 ? price : leg.Price,
                    TriggeredQuantity = u.TradedQty > 0 ? u.TradedQty : leg.TriggeredQuantity,
                };
            }
            else legs.Add(new SuperOrderLeg(name, u.Status, u.TransactionType, price > 0 ? price : null, null, u.TradedQty > 0 ? u.TradedQty : null));
            // One-cancels-other: once the target (stop-loss) leg has filled, Dhan cancels the other exit leg.
            if (u.Status == "TRADED")
            {
                var other = u.LegNo == 2 ? "TARGET_LEG" : "STOP_LOSS_LEG";
                var j = legs.FindIndex(l => l.LegName == other && l.OrderStatus == "PENDING");
                if (j >= 0) legs[j] = legs[j] with { OrderStatus = "CANCELLED" };
            }
            return order with
            {
                LegDetails = legs,
                TargetPrice = u.LegNo == 3 && price > 0 ? price : order.TargetPrice,
                StopLossPrice = u.LegNo == 2 && price > 0 ? price : order.StopLossPrice,
            };
        }
        return order with
        {
            OrderStatus = u.Status.Length > 0 ? u.Status : order.OrderStatus,
            Quantity = u.Quantity > 0 ? u.Quantity : order.Quantity,
            Price = u.Price > 0 ? u.Price : order.Price,
            FilledQty = Math.Max(order.FilledQty ?? 0, u.TradedQty),
            OmsErrorDescription = u.Status == "REJECTED" ? u.Reason ?? order.OmsErrorDescription : order.OmsErrorDescription,
        };
    }

    /// <summary>The price of the NEW part of a fill: from the average traded price before and after
    /// (exact for any number of partial fills), else the last traded price, else the average.</summary>
    internal static decimal? FillPrice(int seenQty, decimal? seenAvg, DhanOrderUpdate u)
    {
        var quantity = u.TradedQty - seenQty;
        if (quantity <= 0) return null;
        if (u.AvgTradedPrice > 0 && (seenQty == 0 || seenAvg is not null))
        {
            var price = (u.AvgTradedPrice * u.TradedQty - (seenAvg ?? 0) * seenQty) / quantity;
            if (price > 0) return Math.Round(price, 4);
        }
        if (u.TradedPrice > 0) return u.TradedPrice;
        return u.AvgTradedPrice > 0 ? u.AvgTradedPrice : null;
    }

    /// <summary>A position after a fill of <paramref name="quantity"/> at <paramref name="price"/>: net
    /// quantity, the day's buy/sell quantities and averages, and booked P&amp;L - which moves by the change
    /// in matched quantity x (sell average - buy average), on top of what Dhan last reported.</summary>
    internal static DhanPosition ApplyFill(DhanPosition? position, DhanOrderUpdate u, int quantity, decimal price, string symbol)
    {
        var p = position ?? new DhanPosition(u.SecurityId, symbol, u.ExchangeSegment, u.ProductType, "CLOSED", 0);
        int buyQty = p.BuyQty, sellQty = p.SellQty;
        decimal buyAvg = p.BuyAvg, sellAvg = p.SellAvg;
        var bookedBefore = Math.Min(buyQty, sellQty) * (sellAvg - buyAvg);
        var isBuy = u.TransactionType == "BUY";
        if (isBuy) { buyAvg = (buyAvg * buyQty + price * quantity) / (buyQty + quantity); buyQty += quantity; }
        else { sellAvg = (sellAvg * sellQty + price * quantity) / (sellQty + quantity); sellQty += quantity; }
        var bookedAfter = Math.Min(buyQty, sellQty) * (sellAvg - buyAvg);
        var net = p.NetQty + (isBuy ? quantity : -quantity);
        return p with
        {
            NetQty = net,
            PositionType = net > 0 ? "LONG" : net < 0 ? "SHORT" : "CLOSED",
            BuyQty = buyQty, SellQty = sellQty,
            BuyAvg = Math.Round(buyAvg, 4), SellAvg = Math.Round(sellAvg, 4),
            RealizedProfit = Math.Round(p.RealizedProfit + bookedAfter - bookedBefore, 2),
        };
    }

    internal void OnTick(SpotTick tick)
    {
        bool tracked;
        List<ProtectionOrder>? due = null;
        lock (_lock)
        {
            tracked = _trackedSecurityIds.Contains(tick.SecurityId);
            if (_protections.TryGetValue(tick.SecurityId, out var protections) && tick.LastPrice > 0)
            {
                foreach (var protection in protections)
                {
                    if (!TargetReached(protection.ClosesBySelling, protection.Target, tick.LastPrice) || !_firingTargets.Add(protection.OrderId)) continue;
                    (due ??= new()).Add(protection);
                }
            }
        }
        if (due is not null) foreach (var protection in due) _ = FireTargetAsync(protection);
        if (tracked) Push();
    }

    /// <summary>A long (closed by selling) reaches its target at or above it; a short at or below.</summary>
    internal static bool TargetReached(bool closesBySelling, decimal target, decimal lastPrice) =>
        target > 0 && (closesBySelling ? lastPrice >= target : lastPrice <= target);

    internal static bool IsProtection(PlainOrderSummary order) => order.CorrelationId?.StartsWith(ProtectionPrefix, StringComparison.Ordinal) == true;

    /// <summary>The target a protection order's tag carries, or null.</summary>
    internal static decimal? TargetFromTag(string? correlationId)
    {
        if (correlationId is null || !correlationId.StartsWith(ProtectionPrefix + "T", StringComparison.Ordinal)) return null;
        var digits = correlationId[(ProtectionPrefix.Length + 1)..].Split('-')[0];
        return long.TryParse(digits, out var paise) && paise > 0 ? paise / 100m : null;
    }

    /// <summary>The target of a protected position was reached: its stop-loss order becomes a LIMIT exit
    /// at the live bid (ask) - the same single order, so the position can never be sold twice - and is
    /// chased until it fills. If Dhan will not turn it into a limit, it is cancelled and a fresh chased
    /// exit goes out for whatever it had left.</summary>
    private async Task FireTargetAsync(ProtectionOrder protection)
    {
        try
        {
            await _actionLock.WaitAsync();
            try
            {
                var order = (await _orders.ListAsync(CancellationToken.None)).FirstOrDefault(o => o.OrderId == protection.OrderId);
                if (order is null || !PendingStatuses.Contains(order.OrderStatus)) return;
                var remaining = order.Quantity - order.FilledQty;
                if (remaining <= 0) return;
                var tick = _chain.FindBySecurityId(protection.SecurityId)?.TickSize is > 0 and var t ? t : 0.05m;
                var price = await ExitPriceAsync(protection.SecurityId, protection.Segment, protection.ClosesBySelling, 0, tick, CancellationToken.None);
                if (price is null) return;

                var (modified, error) = await _orders.ModifyAsync(protection.OrderId, "LIMIT", "DAY", remaining, price, CancellationToken.None);
                var exitId = protection.OrderId;
                if (modified is null)
                {
                    _logger.LogWarning("Target {Target} of {Symbol}: could not turn stop-loss {OrderId} into a limit ({Error}) - replacing it.",
                        protection.Target, protection.Symbol, protection.OrderId, error);
                    var (cancelled, cancelError) = await _orders.CancelAsync(protection.OrderId, CancellationToken.None);
                    if (cancelled is null)
                    {
                        _logger.LogWarning("Target of {Symbol}: could not cancel stop-loss {OrderId} either - {Error}. It stays as the protection.", protection.Symbol, protection.OrderId, cancelError);
                        return;
                    }
                    var position = (await _positions.ListAsync(CancellationToken.None)).FirstOrDefault(p => p.SecurityId == order.SecurityId && p.IsOpen);
                    if (position is null) return;
                    var (placed, placeError) = await _orders.PlaceAsync(order.TransactionType, position.ExchangeSegment, position.ProductType, "LIMIT", "DAY",
                        order.SecurityId, Math.Min(remaining, Math.Abs(position.NetQty)), price.Value, $"OIRX-T-{DateTimeOffset.UtcNow:HHmmss}", CancellationToken.None);
                    if (placed is null) { _logger.LogWarning("Target of {Symbol}: exit rejected - {Error}", protection.Symbol, placeError); return; }
                    exitId = placed.OrderId;
                }
                _logger.LogWarning("Target {Target} reached for {Symbol}: exiting {Remaining} at LIMIT {Price} (order {OrderId}).", protection.Target, protection.Symbol, remaining, price, exitId);
                _ = ChaseExitAsync(exitId, protection.SecurityId, protection.Segment, protection.ClosesBySelling, tick, tick, protection.Symbol);
            }
            finally
            {
                _actionLock.Release();
                RefreshUnlessStreaming();
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Firing the target of {Symbol} failed.", protection.Symbol);
        }
        finally
        {
            lock (_lock) _firingTargets.Remove(protection.OrderId);
        }
    }

    private void Push() => _batcher.SetLatest(PositionsGroup, "livePositions", "all", Snapshot);

    public LivePositionsSnapshot Snapshot()
    {
        IReadOnlyList<DhanPosition> positions;
        IReadOnlyList<SuperOrderSummary> orders;
        IReadOnlyList<PlainOrderSummary> plainOrders;
        DateTimeOffset? refreshed, lastEvent;
        lock (_lock)
        {
            positions = _currentPositions;
            orders = _currentOrders;
            plainOrders = _currentPlainOrders;
            refreshed = _refreshedUtc;
            lastEvent = _lastEventUtc;
        }

        var rows = new List<LivePositionRow>(positions.Count);
        foreach (var p in positions)
        {
            decimal? ltp = uint.TryParse(p.SecurityId, out var id) && _feed.LastTickFor(id) is { LastPrice: > 0 } tick ? tick.LastPrice : null;
            var legs = orders.Where(o => o.SecurityId == p.SecurityId && o.OrderStatus is "TRADED" or "PART_TRADED").ToList();
            var target = legs.SelectMany(o => o.LegDetails).FirstOrDefault(l => l.LegName == "TARGET_LEG" && l.OrderStatus == "PENDING");
            var stopLoss = legs.SelectMany(o => o.LegDetails).FirstOrDefault(l => l.LegName == "STOP_LOSS_LEG" && l.OrderStatus == "PENDING");
            // A stop-loss order left by an earlier partial exit (legacy - see ProtectionPrefix).
            var protection = plainOrders.FirstOrDefault(o => o.SecurityId == p.SecurityId && IsProtection(o) && PendingStatuses.Contains(o.OrderStatus));
            rows.Add(new LivePositionRow(
                p.SecurityId, p.TradingSymbol, p.ExchangeSegment, p.ProductType, p.PositionType, p.NetQty, p.IsOpen,
                p.NetQty > 0 ? p.BuyAvg : p.NetQty < 0 ? p.SellAvg : null, ltp,
                UnrealizedPnl(p, ltp), p.RealizedProfit,
                p.IsOpen ? target?.Price ?? TargetFromTag(protection?.CorrelationId) : null,
                p.IsOpen ? stopLoss?.Price ?? protection?.TriggerPrice : null)
            {
                Protection = !p.IsOpen ? null : target is not null || stopLoss is not null ? "super" : protection is not null ? "managed" : "none",
                LotSize = uint.TryParse(p.SecurityId, out var lotId) ? _chain.FindBySecurityId(lotId)?.LotSize ?? 0 : 0,
                LegExcessQty = p.IsOpen ? Math.Max(0, LegQuantity(legs) - Math.Abs(p.NetQty)) : 0,
            });
        }

        // EVERY open order on the account, so each can be cancelled from the panel: unfilled super orders
        // (their entry), the pending target / stop-loss legs of filled ones, and every pending plain
        // order - this panel's exits (OIRX-), protection stop-losses (OIRP-) and anything else.
        string SymbolOf(string securityId) => uint.TryParse(securityId, out var sid) ? _chain.FindBySecurityId(sid)?.TradingSymbol ?? securityId : securityId;
        var superIds = orders.Select(o => o.OrderId).ToHashSet();
        var superTags = orders.Select(o => o.CorrelationId).Where(t => !string.IsNullOrEmpty(t)).ToHashSet();
        var pending = orders
            .Where(o => PendingStatuses.Contains(o.OrderStatus))
            .Select(o => new LivePendingOrder(o.OrderId, o.SecurityId, SymbolOf(o.SecurityId),
                o.TransactionType, o.Quantity - (o.FilledQty ?? 0), o.Price, o.TargetPrice, o.StopLossPrice, o.OrderStatus) { Kind = "Entry", Leg = "ENTRY_LEG" })
            .Concat(orders
                .Where(o => o.OrderStatus is "TRADED" or "PART_TRADED")
                .SelectMany(o => o.LegDetails
                    .Where(l => l.LegName is "TARGET_LEG" or "STOP_LOSS_LEG" && l.OrderStatus == "PENDING")
                    .Select(l => new LivePendingOrder(o.OrderId, o.SecurityId, SymbolOf(o.SecurityId),
                        string.IsNullOrEmpty(l.TransactionType) ? (o.TransactionType == "BUY" ? "SELL" : "BUY") : l.TransactionType,
                        o.FilledQty is > 0 and var f ? f : o.Quantity, l.Price ?? 0,
                        l.LegName == "TARGET_LEG" ? l.Price : o.TargetPrice, l.LegName == "STOP_LOSS_LEG" ? l.Price : o.StopLossPrice, l.OrderStatus)
                    { Kind = l.LegName == "TARGET_LEG" ? "Target leg" : "Stop-loss leg", Leg = l.LegName })))
            .Concat(plainOrders
                .Where(o => PendingStatuses.Contains(o.OrderStatus) && !superIds.Contains(o.OrderId) && (o.CorrelationId is null || !superTags.Contains(o.CorrelationId)))
                .Select(o => new LivePendingOrder(o.OrderId, o.SecurityId, SymbolOf(o.SecurityId),
                    o.TransactionType, o.Quantity - o.FilledQty, o.Price, IsProtection(o) ? TargetFromTag(o.CorrelationId) : null,
                    IsProtection(o) ? o.TriggerPrice : o.TriggerPrice is > 0 ? o.TriggerPrice : null, o.OrderStatus)
                {
                    Kind = IsProtection(o) ? "Protection" : o.CorrelationId?.StartsWith("OIRX-", StringComparison.Ordinal) == true ? "Exit" : "Order",
                    OrderType = o.OrderType,
                }))
            .ToList();
        var rejected = orders
            .Where(o => o.OrderStatus == "REJECTED" && !string.IsNullOrWhiteSpace(o.OmsErrorDescription))
            .Select(o => $"{o.TransactionType} {o.SecurityId} x{o.Quantity}: {o.OmsErrorDescription}")
            .TakeLast(3)
            .ToList();

        return new LivePositionsSnapshot(
            rows.Where(r => r.IsOpen).Concat(rows.Where(r => !r.IsOpen)).ToList(),
            pending, rejected,
            rows.Sum(r => r.RealizedPnl + (r.UnrealizedPnl ?? 0)),
            refreshed, _orderUpdates.IsConnected, _session.IsAuthenticated, _maxLots)
        { LastOrderEventUtc = lastEvent };
    }

    internal static decimal? UnrealizedPnl(DhanPosition position, decimal? ltp)
    {
        if (!position.IsOpen || ltp is null) return position.IsOpen ? null : 0;
        return position.NetQty > 0
            ? (ltp.Value - position.BuyAvg) * position.NetQty
            : (position.SellAvg - ltp.Value) * -position.NetQty;
    }

    /// <summary>The entry LIMIT, target and stop-loss for a manual order, all off the live side of the
    /// book: a BUY prices off the best ask, a SELL off the best bid - the price that actually clears,
    /// not the last trade. The limit sits `slippage` beyond it; target and stop-loss are measured from
    /// it. Null with a reason when there is no usable quote or the numbers would be rejected by Dhan
    /// (a super order needs the target beyond the entry limit).</summary>
    internal static (ManualOrderPrices? Prices, string? Error) PriceOrder(
        bool isSell, decimal bestBid, decimal bestAsk, decimal slippage, decimal stopLossPoints, decimal targetPoints, decimal tickSize)
    {
        var reference = isSell ? bestBid : bestAsk;
        if (reference <= 0) return (null, $"no live {(isSell ? "bid" : "ask")} for this contract yet");
        if (stopLossPoints <= 0 || targetPoints <= 0) return (null, "live orders go out as super orders and need both a stop-loss and a target");
        if (slippage < 0) return (null, "slippage cannot be negative");
        if (targetPoints <= slippage) return (null, "the target must be further than the slippage, or it would sit inside the entry price");

        var tick = tickSize > 0 ? tickSize : 0.05m;
        var limit = StrategyTriggerHostedService.RoundToTick(isSell ? reference - slippage : reference + slippage, tick);
        var target = StrategyTriggerHostedService.RoundToTick(isSell ? reference - targetPoints : reference + targetPoints, tick);
        var stopLoss = StrategyTriggerHostedService.RoundToTick(isSell ? reference + stopLossPoints : reference - stopLossPoints, tick);
        if (limit <= 0 || target <= 0 || stopLoss <= 0) return (null, "the stop-loss or target would be at or below zero for this premium");
        return (new ManualOrderPrices(reference, limit, target, stopLoss), null);
    }

    public async Task<ManualOrderResult> PlaceAsync(ManualOrderRequest request, CancellationToken cancellationToken)
    {
        if (!_session.IsAuthenticated) return ManualOrderResult.Fail("not logged in to Dhan right now");
        if (request.Lots <= 0) return ManualOrderResult.Fail("quantity must be at least one lot");
        if (request.Lots > _maxLots) return ManualOrderResult.Fail($"{request.Lots} lots is over the {_maxLots}-lot limit for one manual order (ManualTrading__MaxLots)");
        var isSell = string.Equals(request.Direction, "SELL", StringComparison.OrdinalIgnoreCase);
        if (!isSell && !string.Equals(request.Direction, "BUY", StringComparison.OrdinalIgnoreCase))
            return ManualOrderResult.Fail("direction must be BUY or SELL");
        var isCall = string.Equals(request.Side, "CE", StringComparison.OrdinalIgnoreCase);
        if (!isCall && !string.Equals(request.Side, "PE", StringComparison.OrdinalIgnoreCase))
            return ManualOrderResult.Fail("side must be CE or PE");

        await _chain.EnsureLoadedAsync(cancellationToken);
        var contract = _chain.Find(request.Underlying, request.Expiry, request.Strike, isCall);
        if (contract is null) return ManualOrderResult.Fail($"no listed {request.Underlying} {request.Strike:0.##}{request.Side.ToUpperInvariant()} for {request.Expiry:dd MMM yyyy}");

        await _actionLock.WaitAsync(cancellationToken);
        try
        {
            var quote = await LiveQuoteAsync(contract.SecurityId, contract.DhanSegment, cancellationToken);
            var (prices, error) = PriceOrder(isSell, quote?.BestBidPrice ?? 0, quote?.BestAskPrice ?? 0,
                request.SlippagePoints, request.StopLossPoints, request.TargetPoints, contract.TickSize);
            if (prices is null) return ManualOrderResult.Fail(error!);

            var quantity = request.Lots * contract.LotSize;
            var slices = StrategyTriggerHostedService.SliceQuantity(quantity, contract.LotSize, StrategyTriggerHostedService.FreezeQuantityFor(request.Underlying));
            var transactionType = isSell ? "SELL" : "BUY";
            var orderIds = new List<string>();
            var stamp = DateTimeOffset.UtcNow.ToString("yyyyMMddHHmmss");
            for (var i = 0; i < slices.Count; i++)
            {
                if (i > 0) await Task.Delay(SliceCallDelay, cancellationToken);
                var (result, placeError) = await _superOrders.PlaceAsync(
                    transactionType, contract.DhanSegment, ProductType, "LIMIT", contract.SecurityId.ToString(), slices[i],
                    prices.Limit, prices.Target, prices.StopLoss, $"OIR-{stamp}-{i + 1}", 0, cancellationToken);
                if (result is null)
                {
                    RefreshUnlessStreaming();
                    return ManualOrderResult.Fail(orderIds.Count == 0
                        ? $"Dhan rejected the order: {placeError}"
                        : $"placed {orderIds.Count} of {slices.Count} slices, then Dhan rejected the next: {placeError}", orderIds, prices);
                }
                orderIds.Add(result.OrderId);
            }

            _logger.LogWarning("Manual LIVE order: {Transaction} {Symbol} x{Quantity} LIMIT {Limit} (ref {Reference}), target {Target}, SL {StopLoss} - orders {Orders}.",
                transactionType, contract.TradingSymbol, quantity, prices.Limit, prices.Reference, prices.Target, prices.StopLoss, string.Join(",", orderIds));
            RefreshUnlessStreaming();
            return new ManualOrderResult(true,
                $"{transactionType} {contract.TradingSymbol} x{quantity} at LIMIT {prices.Limit:0.##} ({(isSell ? "bid" : "ask")} {prices.Reference:0.##}) · target {prices.Target:0.##} · SL {prices.StopLoss:0.##}",
                orderIds, prices);
        }
        finally
        {
            _actionLock.Release();
        }
    }

    /// <summary>Squares off an open position at its live bid (closing a long) or ask (closing a short)
    /// with the given slippage. Its super-order target/stop-loss legs are cancelled FIRST and the
    /// position re-read afterwards, so a leg that fires in between can never be doubled by this exit
    /// into a reversed position; exit orders already working for it are subtracted for the same reason
    /// (a double click, or Exit all after a Close). Each exit order is then chased until it fills - see
    /// ChaseExitAsync.</summary>
    public async Task<ManualOrderResult> CloseAsync(string securityId, decimal slippagePoints, CancellationToken cancellationToken)
    {
        if (!_session.IsAuthenticated) return ManualOrderResult.Fail("not logged in to Dhan right now");
        await _actionLock.WaitAsync(cancellationToken);
        try { return await CloseCoreAsync(securityId, slippagePoints, cancellationToken); }
        finally { _actionLock.Release(); }
    }

    /// <summary>Exit all from the trade panel: cancels EVERY pending order on the account first - unfilled
    /// super orders (cancelling the entry cancels all its legs) and pending plain orders, except this
    /// panel's own working exits ("OIRX-", already closing) - then closes every open position the same
    /// careful way Close does: legs and protection cancelled first, a priced, chased LIMIT exit for
    /// exactly what is open. Unlike Dhan's DELETE /positions (EmergencyExitAllAsync) no exit is a blind
    /// market order.</summary>
    public async Task<ManualOrderResult> ExitAllAsync(decimal slippagePoints, CancellationToken cancellationToken)
    {
        if (!_session.IsAuthenticated) return ManualOrderResult.Fail("not logged in to Dhan right now");
        await _actionLock.WaitAsync(cancellationToken);
        try
        {
            var messages = new List<string>();
            var failures = new List<string>();
            var orderIds = new List<string>();

            var (cancelledCount, cancelFailures) = await CancelPendingAsync(null, cancellationToken);
            failures.AddRange(cancelFailures);
            if (cancelledCount > 0) messages.Add($"cancelled {cancelledCount} pending order(s)");

            var open = (await _positions.ListAsync(cancellationToken)).Where(p => p.IsOpen).ToList();
            foreach (var position in open)
            {
                var result = await CloseCoreAsync(position.SecurityId, slippagePoints, cancellationToken);
                (result.Success ? messages : failures).Add(result.Message);
                orderIds.AddRange(result.OrderIds);
            }

            RefreshUnlessStreaming();
            if (open.Count == 0 && messages.Count == 0 && failures.Count == 0)
                return new ManualOrderResult(true, "nothing to exit - no open positions or pending orders", Array.Empty<string>(), null);
            var text = string.Join(" · ", failures.Concat(messages));
            return failures.Count == 0 ? new ManualOrderResult(true, text, orderIds, null) : ManualOrderResult.Fail(text, orderIds);
        }
        finally
        {
            _actionLock.Release();
        }
    }

    /// <summary>Dhan's own exit-everything (DELETE /positions): every position and every open order on
    /// the account, strategy triggers' included. For when the careful Exit all is not enough.</summary>
    public async Task<ManualOrderResult> EmergencyExitAllAsync(CancellationToken cancellationToken)
    {
        if (!_session.IsAuthenticated) return ManualOrderResult.Fail("not logged in to Dhan right now");
        var error = await _positions.ExitAllAccountAsync(cancellationToken);
        _logger.LogWarning("EMERGENCY exit-all (Dhan DELETE /positions) requested: {Result}.", error ?? "accepted");
        RefreshUnlessStreaming();
        return error is null
            ? new ManualOrderResult(true, "Dhan accepted exit-all: every position on the account is being closed and every open order cancelled", Array.Empty<string>(), null)
            : ManualOrderResult.Fail($"Dhan rejected exit-all: {error}");
    }

    /// <summary>Cancels pending orders - for one contract, or all of them (null): unfilled super orders
    /// (ENTRY_LEG cancels the whole super order, legs included) and pending plain orders other than this
    /// panel's working exits (OIRX-) and protection stop-losses (OIRP-, which CancelProtectionAsync owns).
    /// Returns how many were cancelled and what failed.</summary>
    private async Task<(int Cancelled, List<string> Failures)> CancelPendingAsync(string? securityId, CancellationToken cancellationToken)
    {
        var failures = new List<string>();
        var cancelled = 0;
        var superOrders = await _superOrders.ListAsync(cancellationToken);
        foreach (var entry in superOrders.Where(o => PendingStatuses.Contains(o.OrderStatus) && (securityId is null || o.SecurityId == securityId)))
        {
            var (result, error) = await _superOrders.CancelAsync(entry.OrderId, "ENTRY_LEG", cancellationToken);
            if (result is null) failures.Add($"could not cancel pending super order {entry.OrderId}: {error}");
            else cancelled++;
        }
        // A super order's own legs can show in the plain order book too - those go with their super order.
        var superIds = superOrders.Select(o => o.OrderId).ToHashSet();
        foreach (var order in (await _orders.ListAsync(cancellationToken)).Where(o =>
                     PendingStatuses.Contains(o.OrderStatus) && (securityId is null || o.SecurityId == securityId) && !superIds.Contains(o.OrderId)
                     && o.CorrelationId?.StartsWith("OIRX-", StringComparison.Ordinal) != true && !IsProtection(o)))
        {
            var (result, error) = await _orders.CancelAsync(order.OrderId, cancellationToken);
            if (result is null) failures.Add($"could not cancel pending order {order.OrderId}: {error}");
            else cancelled++;
        }
        return (cancelled, failures);
    }

    /// <summary>Close one position: its unfilled super orders (and other pending orders in the contract)
    /// are cancelled, its filled super orders' target/stop-loss legs and any protection order too - all
    /// BEFORE the position is re-read and sized - then one priced, chased exit.</summary>
    private async Task<ManualOrderResult> CloseCoreAsync(string securityId, decimal slippagePoints, CancellationToken cancellationToken)
    {
        var (_, cancelFailures) = await CancelPendingAsync(securityId, cancellationToken);
        foreach (var failure in cancelFailures) _logger.LogWarning("Closing {Security}: {Failure}", securityId, failure);
        await CancelProtectionAsync(securityId, cancellationToken);

        var position = (await _positions.ListAsync(cancellationToken)).FirstOrDefault(p => p.SecurityId == securityId && p.IsOpen);
        if (position is null)
        {
            RefreshUnlessStreaming();
            return new ManualOrderResult(true, "nothing left to close - the position is already flat", Array.Empty<string>(), null);
        }

        var working = await WorkingExitQuantityAsync(position, cancellationToken);
        var quantity = ExitQuantity(position.NetQty, working);
        if (quantity <= 0)
        {
            RefreshUnlessStreaming();
            return new ManualOrderResult(true, $"{position.TradingSymbol}: exit orders for the whole position are already working", Array.Empty<string>(), null);
        }

        var (orderIds, price, error) = await PlaceExitAsync(position, quantity, slippagePoints, cancellationToken);
        RefreshUnlessStreaming();
        if (error is not null) return ManualOrderResult.Fail(error, orderIds);
        return new ManualOrderResult(true, $"{(position.ClosesBySelling ? "SELL" : "BUY")} {position.TradingSymbol} x{quantity} at LIMIT {price:0.##} to close", orderIds, null);
    }

    /// <summary>
    /// Takes partial profit (or cuts part of a position): ONE priced, chased LIMIT exit for
    /// <paramref name="lots"/> lots, nothing else - the position's super order stays exactly as it is, so no
    /// extra orders (and no extra order cost) come from a partial exit.
    ///
    /// Dhan cannot shrink a super order once its entry has filled ("only TARGET_LEG and STOP_LOSS_LEG price
    /// and trail jump can be modified"), so its target and stop-loss legs keep the ORIGINAL quantity: if one
    /// fires after a partial exit it closes more than is left - the snapshot flags that (LegExcessQty) and
    /// Close / Exit all cancel the legs before exiting the rest.
    /// Exiting everything is a plain Close.
    /// </summary>
    public async Task<ManualOrderResult> PartialExitAsync(string securityId, int lots, decimal slippagePoints, CancellationToken cancellationToken)
    {
        if (!_session.IsAuthenticated) return ManualOrderResult.Fail("not logged in to Dhan right now");
        if (lots <= 0) return ManualOrderResult.Fail("exit at least one lot");
        await _actionLock.WaitAsync(cancellationToken);
        try
        {
            var position = (await _positions.ListAsync(cancellationToken)).FirstOrDefault(p => p.SecurityId == securityId && p.IsOpen);
            if (position is null) return ManualOrderResult.Fail("no open position in that contract");
            uint.TryParse(securityId, out var id);
            var contract = _chain.FindBySecurityId(id);
            if (contract is null) return ManualOrderResult.Fail($"{position.TradingSymbol}: contract details (lot size) not found - use Close instead");
            var requested = lots * contract.LotSize;
            var open = Math.Abs(position.NetQty);
            if (requested >= open) return await CloseCoreAsync(securityId, slippagePoints, cancellationToken);

            var superOrders = (await _superOrders.ListAsync(cancellationToken)).Where(o => o.SecurityId == securityId).ToList();
            if (superOrders.Any(o => o.OrderStatus is "PENDING" or "TRANSIT" or "PART_TRADED"))
                return ManualOrderResult.Fail($"{position.TradingSymbol}: an entry for this contract is still filling - wait for it (or cancel it) before a partial exit");

            var working = await WorkingExitQuantityAsync(position, cancellationToken);
            var quantity = (int)Math.Min(requested, ExitQuantity(position.NetQty, working));
            if (quantity <= 0)
                return ManualOrderResult.Fail($"{position.TradingSymbol}: exit orders for the whole position are already working");
            var (orderIds, price, error) = await PlaceExitAsync(position, quantity, slippagePoints, cancellationToken);
            // Read the order books right away so the new exit (and every leg still working) shows in the
            // panel at once, ready to cancel.
            RequestRefresh();
            if (error is not null) return ManualOrderResult.Fail(error, orderIds);

            var rest = open - quantity;
            var legs = LegQuantity(superOrders);
            var note = legs > rest
                ? $" · its super order's SL/target still cover {legs} (Dhan cannot shrink them) - if one fires it closes {legs - rest} more than you hold; Close cancels them"
                : "";
            _logger.LogWarning("Manual LIVE partial exit: {Symbol} x{Quantity} at LIMIT {Price}, {Rest} left, super-order legs cover {Legs}.", position.TradingSymbol, quantity, price, rest, legs);
            return new ManualOrderResult(true,
                $"{(position.ClosesBySelling ? "SELL" : "BUY")} {position.TradingSymbol} x{quantity} at LIMIT {price:0.##} · {rest} left{note}",
                orderIds, null);
        }
        finally
        {
            _actionLock.Release();
        }
    }

    /// <summary>The quantity a contract's filled super orders' still-pending stop-loss (or target) legs
    /// would close if they fired.</summary>
    internal static int LegQuantity(IEnumerable<SuperOrderSummary> superOrders) => superOrders
        .Where(o => o.OrderStatus is "TRADED" or "PART_TRADED"
            && o.LegDetails.Any(l => l.LegName is "STOP_LOSS_LEG" or "TARGET_LEG" && l.OrderStatus == "PENDING"))
        .Sum(o => o.FilledQty is > 0 and var f ? f : o.Quantity);

    /// <summary>Cancels what protects a position - its super orders' pending target/stop-loss legs and any
    /// protection order (OIRP-) - and returns the target and stop-loss they had.</summary>
    private async Task<(decimal? Target, decimal? StopLoss)> CancelProtectionAsync(string securityId, CancellationToken cancellationToken)
    {
        decimal? target = null, stopLoss = null;
        foreach (var order in (await _superOrders.ListAsync(cancellationToken)).Where(o => o.SecurityId == securityId && o.OrderStatus is "TRADED" or "PART_TRADED"))
        {
            foreach (var leg in order.LegDetails.Where(l => l.LegName is "TARGET_LEG" or "STOP_LOSS_LEG" && l.OrderStatus == "PENDING"))
            {
                if (leg.LegName == "TARGET_LEG") target ??= leg.Price ?? order.TargetPrice;
                else stopLoss ??= leg.Price ?? order.StopLossPrice;
                var (cancelled, error) = await _superOrders.CancelAsync(order.OrderId, leg.LegName, cancellationToken);
                if (cancelled is null) _logger.LogWarning("{Security}: could not cancel {Leg} of {Order} - {Error}", securityId, leg.LegName, order.OrderId, error);
            }
        }
        foreach (var order in (await _orders.ListAsync(cancellationToken)).Where(o => o.SecurityId == securityId && IsProtection(o) && PendingStatuses.Contains(o.OrderStatus)))
        {
            target ??= TargetFromTag(order.CorrelationId);
            stopLoss ??= order.TriggerPrice is > 0 ? order.TriggerPrice : null;
            var (cancelled, error) = await _orders.CancelAsync(order.OrderId, cancellationToken);
            if (cancelled is null) _logger.LogWarning("{Security}: could not cancel protection order {Order} - {Error}", securityId, order.OrderId, error);
        }
        return (target, stopLoss);
    }

    /// <summary>Exit quantity already working for a position (pending orders on its closing side).</summary>
    private async Task<long> WorkingExitQuantityAsync(DhanPosition position, CancellationToken cancellationToken)
    {
        var transactionType = position.ClosesBySelling ? "SELL" : "BUY";
        // A super order's own target/stop-loss legs, if Dhan lists them in the order book too, are not
        // exits working now - they only fire at their price.
        var superOrders = await _superOrders.ListAsync(cancellationToken);
        var superIds = superOrders.Select(o => o.OrderId).ToHashSet();
        var superTags = superOrders.Select(o => o.CorrelationId).Where(t => !string.IsNullOrEmpty(t)).ToHashSet();
        return (await _orders.ListAsync(cancellationToken))
            .Where(o => o.SecurityId == position.SecurityId && o.TransactionType == transactionType && PendingStatuses.Contains(o.OrderStatus)
                && !superIds.Contains(o.OrderId) && (o.CorrelationId is null || !superTags.Contains(o.CorrelationId)))
            .Sum(o => (long)Math.Max(0, o.Quantity - o.FilledQty));
    }

    /// <summary>Sends <paramref name="quantity"/> of a position out as chased LIMIT exits, sliced at the
    /// freeze limit, priced off the live bid (ask) with the slippage.</summary>
    private async Task<(List<string> OrderIds, decimal? Price, string? Error)> PlaceExitAsync(
        DhanPosition position, int quantity, decimal slippagePoints, CancellationToken cancellationToken)
    {
        var orderIds = new List<string>();
        uint.TryParse(position.SecurityId, out var id);
        var contract = _chain.FindBySecurityId(id);
        var tick = contract?.TickSize is > 0 ? contract.TickSize : 0.05m;
        var closingIsSell = position.ClosesBySelling;
        var transactionType = closingIsSell ? "SELL" : "BUY";
        var price = await ExitPriceAsync(id, position.ExchangeSegment, closingIsSell, slippagePoints, tick, cancellationToken);
        if (price is null) return (orderIds, null, $"{position.TradingSymbol}: no live price - cannot price the exit");

        IReadOnlyList<int> slices = contract is null
            ? new[] { quantity }
            : StrategyTriggerHostedService.SliceQuantity(quantity, contract.LotSize, StrategyTriggerHostedService.FreezeQuantityFor(contract.Underlying));
        var stamp = DateTimeOffset.UtcNow.ToString("yyyyMMddHHmmss");
        for (var i = 0; i < slices.Count; i++)
        {
            if (i > 0) await Task.Delay(SliceCallDelay, cancellationToken);
            var (result, error) = await _orders.PlaceAsync(transactionType, position.ExchangeSegment, position.ProductType, "LIMIT", "DAY",
                position.SecurityId, slices[i], price.Value, $"OIRX-{stamp}-{i + 1}", cancellationToken);
            if (result is null) return (orderIds, price, $"{position.TradingSymbol}: Dhan rejected the exit order: {error}");
            orderIds.Add(result.OrderId);
            _ = ChaseExitAsync(result.OrderId, id, position.ExchangeSegment, closingIsSell, slippagePoints, tick, position.TradingSymbol);
        }

        _logger.LogWarning("Manual LIVE exit: {Transaction} {Symbol} x{Quantity} LIMIT {Price} - orders {Orders}.",
            transactionType, position.TradingSymbol, quantity, price, string.Join(",", orderIds));
        return (orderIds, price, null);
    }

    /// <summary>How much more to send to flatten a position, given exit quantity already working.</summary>
    internal static int ExitQuantity(int netQty, long workingQuantity) => (int)Math.Max(0, Math.Abs(netQty) - workingQuantity);

    /// <summary>The exit's LIMIT: the live bid when selling (ask when buying back) minus/plus the
    /// slippage, falling back to the last price only when the book side is empty, never below a tick.</summary>
    private async Task<decimal?> ExitPriceAsync(uint securityId, string segment, bool isSell, decimal slippage, decimal tick, CancellationToken cancellationToken)
    {
        var quote = await LiveQuoteAsync(securityId, segment, cancellationToken);
        var reference = isSell ? quote?.BestBidPrice ?? 0 : quote?.BestAskPrice ?? 0;
        if (reference <= 0) reference = quote?.LastPrice ?? 0;
        if (reference <= 0) return null;
        return StrategyTriggerHostedService.RoundToTick(Math.Max(tick, isSell ? reference - slippage : reference + slippage), tick);
    }

    /// <summary>Keeps an exit order moving until it fills: every ExitCheckInterval, if it is still
    /// unfilled, re-prices it to the CURRENT bid (ask) with the slippage widened each attempt
    /// (2x, 3x, ...) - a fast market must not leave a position open behind a stale limit price. The
    /// quantity sent is the remaining (unfilled) part, so an ambiguous modify can only under-close,
    /// never reverse the position. Gives up after MaxExitAttempts, leaving the order resting (visible
    /// and cancellable in the panel).</summary>
    private async Task ChaseExitAsync(string orderId, uint securityId, string segment, bool isSell, decimal slippage, decimal tick, string symbol)
    {
        try
        {
            for (var attempt = 1; attempt <= MaxExitAttempts; attempt++)
            {
                await Task.Delay(ExitCheckInterval);
                var order = await CurrentOrderAsync(orderId);
                if (order is null) continue;
                if (order.OrderStatus == "TRADED") { RefreshUnlessStreaming(); return; }
                if (order.OrderStatus is "CANCELLED" or "REJECTED" or "EXPIRED")
                {
                    _logger.LogWarning("Manual exit {OrderId} ({Symbol}) ended {Status}: {Reason}", orderId, symbol, order.OrderStatus, order.OmsErrorDescription);
                    RefreshUnlessStreaming();
                    return;
                }
                if (attempt == MaxExitAttempts) break;

                var price = await ExitPriceAsync(securityId, segment, isSell, slippage * (attempt + 1), tick, CancellationToken.None);
                if (price is null || price == order.Price) continue;
                var remaining = order.Quantity - order.FilledQty;
                var (modified, error) = await _orders.ModifyAsync(orderId, "LIMIT", "DAY", remaining, price, CancellationToken.None);
                if (modified is null) _logger.LogWarning("Re-pricing manual exit {OrderId} ({Symbol}) failed: {Error}", orderId, symbol, error);
                else _logger.LogInformation("Re-priced manual exit {OrderId} ({Symbol}) to {Price} for {Remaining} (attempt {Attempt}).", orderId, symbol, price, remaining, attempt);
            }
            _logger.LogWarning("Manual exit {OrderId} ({Symbol}) still not filled after {Attempts} attempts - left resting.", orderId, symbol, MaxExitAttempts);
            RefreshUnlessStreaming();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Chasing manual exit {OrderId} ({Symbol}) failed.", orderId, symbol);
        }
    }

    /// <summary>An order's current state: from memory while the order-update socket keeps it current,
    /// from Dhan's order book only when the socket is down (or has not reported the order yet).</summary>
    private async Task<PlainOrderSummary?> CurrentOrderAsync(string orderId)
    {
        if (_orderUpdates.IsConnected)
        {
            lock (_lock)
            {
                var known = _currentPlainOrders.FirstOrDefault(o => o.OrderId == orderId);
                if (known is not null) return known;
            }
        }
        return (await _orders.ListAsync(CancellationToken.None)).FirstOrDefault(o => o.OrderId == orderId);
    }

    /// <summary>Cancels an unfilled order: a manual entry (the whole super order) or a working exit.</summary>
    /// <param name="leg">For a super order: ENTRY_LEG (the whole order), TARGET_LEG or STOP_LOSS_LEG
    /// (just that leg); null with <paramref name="isExitOrder"/> for a plain order.</param>
    public async Task<ManualOrderResult> CancelAsync(string orderId, bool isExitOrder, CancellationToken cancellationToken, string? leg = null)
    {
        string? error;
        if (isExitOrder && leg is null) { var (result, e) = await _orders.CancelAsync(orderId, cancellationToken); error = result is null ? e ?? "no reason given" : null; }
        else
        {
            var legName = leg is "TARGET_LEG" or "STOP_LOSS_LEG" ? leg : "ENTRY_LEG";
            var (result, e) = await _superOrders.CancelAsync(orderId, legName, cancellationToken);
            error = result is null ? e ?? "no reason given" : null;
        }
        RefreshUnlessStreaming();
        return error is null ? new ManualOrderResult(true, $"order {orderId} cancelled", new[] { orderId }, null) : ManualOrderResult.Fail($"Dhan did not cancel it: {error}");
    }

    /// <summary>The contract's latest tick with a two-sided book - subscribing it in Full mode first if
    /// the feed is not streaming it yet, and waiting briefly for the first quote.</summary>
    private async Task<SpotTick?> LiveQuoteAsync(uint securityId, string segment, CancellationToken cancellationToken)
    {
        if (!_feed.IsSubscribed(securityId))
            await _feed.SubscribeAsync(new Dictionary<uint, string> { [securityId] = segment }, cancellationToken, full: true);
        var deadline = DateTimeOffset.UtcNow + QuoteWait;
        while (true)
        {
            var tick = _feed.LastTickFor(securityId);
            if (tick is { BestBidPrice: > 0, BestAskPrice: > 0 } || DateTimeOffset.UtcNow >= deadline) return tick;
            await Task.Delay(100, cancellationToken);
        }
    }
}

public sealed record ManualOrderRequest(
    string Underlying, DateOnly Expiry, decimal Strike, string Side, string Direction, int Lots,
    decimal SlippagePoints, decimal StopLossPoints, decimal TargetPoints);

public sealed record ManualOrderPrices(decimal Reference, decimal Limit, decimal Target, decimal StopLoss);

public sealed record ManualOrderResult(bool Success, string Message, IReadOnlyList<string> OrderIds, ManualOrderPrices? Prices)
{
    public static ManualOrderResult Fail(string message, IReadOnlyList<string>? orderIds = null, ManualOrderPrices? prices = null) =>
        new(false, message, orderIds ?? Array.Empty<string>(), prices);
}

/// <summary>Protection: "super" (the super order's own target/stop-loss legs), "managed" (a stop-loss
/// order left by an earlier partial exit, plus a target this server watches), or "none". LegExcessQty:
/// how much MORE the super order's legs would close than is held (after a partial exit), else 0.</summary>
public sealed record LivePositionRow(
    string SecurityId, string TradingSymbol, string ExchangeSegment, string ProductType, string PositionType,
    int NetQty, bool IsOpen, decimal? AvgPrice, decimal? Ltp, decimal? UnrealizedPnl, decimal RealizedPnl,
    decimal? TargetPrice, decimal? StopLossPrice)
{
    public string? Protection { get; init; }
    public int LotSize { get; init; }
    public int LegExcessQty { get; init; }
}

/// <summary>A protection order's target watch - see LiveTradingService.FireTargetAsync.</summary>
internal sealed record ProtectionOrder(string OrderId, uint SecurityId, string Segment, bool ClosesBySelling, decimal Target, string Symbol);

public sealed record LivePendingOrder(
    string OrderId, string SecurityId, string TradingSymbol, string TransactionType, int Quantity, decimal Price,
    decimal? TargetPrice, decimal? StopLossPrice, string Status)
{
    /// <summary>A super order's leg (ENTRY_LEG / TARGET_LEG / STOP_LOSS_LEG) - what cancelling it removes;
    /// null for a plain order.</summary>
    public string? Leg { get; init; }
    /// <summary>A plain order's type (LIMIT, MARKET, STOP_LOSS, STOP_LOSS_MARKET).</summary>
    public string? OrderType { get; init; }
    /// <summary>"Entry" (an unfilled super order from the panel) or "Exit" (a working exit order).</summary>
    public string Kind { get; init; } = "Entry";
}

/// <summary>What the trade panel's Live mode shows. DayPnl = realized + unrealized across every
/// position today. OrderUpdatesConnected: whether position changes are arriving by event right now.</summary>
public sealed record LivePositionsSnapshot(
    IReadOnlyList<LivePositionRow> Positions, IReadOnlyList<LivePendingOrder> PendingOrders, IReadOnlyList<string> RecentRejections,
    decimal DayPnl, DateTimeOffset? RefreshedUtc, bool OrderUpdatesConnected, bool DhanLoggedIn, int MaxLots)
{
    /// <summary>When the order-update socket last changed an order or position (RefreshedUtc is the last
    /// full read from Dhan's REST API, which now happens only on (re)connect).</summary>
    public DateTimeOffset? LastOrderEventUtc { get; init; }
}

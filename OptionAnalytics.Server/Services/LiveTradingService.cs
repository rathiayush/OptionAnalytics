using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Telegram;

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
    private static readonly string[] FinishedStatuses = { "TRADED", "CANCELLED", "REJECTED", "EXPIRED", "CLOSED" };
    /// <summary>Still working at the exchange - anything not finished (a status Dhan adds later, such as a
    /// triggered stop-loss, still counts as open, so no open order can go missing from the panel).</summary>
    internal static bool IsOpenStatus(string? status) =>
        !string.IsNullOrWhiteSpace(status) && !FinishedStatuses.Contains(status.Trim().ToUpperInvariant());
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
    private readonly TelegramAlertService? _telegram;
    // What happened to this panel's / the strategy scanner's orders on Dhan today - entry filled,
    // stop-loss hit, target hit, exit filled, rejected - newest last (see TradeEventOf). Shown with the
    // live positions (the pages pop a notification for each new one) and sent to Telegram.
    private readonly List<LiveTradeEvent> _events = new();
    private readonly HashSet<string> _eventKeys = new();
    // Trailing stop-loss of this app's live trades, per super order (premium points) - see TrailStop.
    // In memory only: after a restart the stop-loss leg stays where it was last moved (never looser).
    private readonly Dictionary<string, TrailState> _trails = new();
    private static readonly TimeSpan TrailModifyInterval = TimeSpan.FromSeconds(2);
    // Live trades the server closes itself at a set time - the strategy scanner's time stop / 15:10
    // square-off - with or without a browser open (SetTimeExit, RunDueTimeExitsAsync). Kept on disk.
    private readonly List<LiveTimeExit> _timeExits = new();
    private readonly LiveTimeExitStore? _timeExitStore;
    /// <summary>The latest a time exit runs: 15:10 IST, before the broker's own intraday square-off.</summary>
    internal const int TimeExitCutoffMinute = 15 * 60 + 10;
    internal static readonly TimeSpan TimeExitRetryInterval = TimeSpan.FromSeconds(10);
    /// <summary>A failing time exit (Dhan down, logged out) is retried this many times - about five minutes.</summary>
    internal const int MaxTimeExitAttempts = 30;
    /// <summary>The clock time exits are set against (tests pin it).</summary>
    internal Func<DateTimeOffset> UtcNow { get; set; } = () => DateTimeOffset.UtcNow;
    private DateOnly _eventsDay;
    internal const int MaxEvents = 40;

    public LiveTradingService(
        DhanPositionsClient positions, DhanSuperOrderClient superOrders, DhanOrderClient orders,
        DhanOptionChainMaster chain, DhanMarketFeedClient feed, DhanSession session, DhanOrderUpdateFeed orderUpdates,
        LiveBroadcastBatcher batcher, ILogger<LiveTradingService> logger, IConfiguration? configuration = null,
        TelegramAlertService? telegram = null, LiveTimeExitStore? timeExitStore = null)
    {
        _telegram = telegram;
        _timeExitStore = timeExitStore;
        // Today's time exits come back after a restart; older days' are dropped.
        if (timeExitStore is not null) _timeExits.AddRange(timeExitStore.Load().Where(e => IstClock.IstDate(e.ExitAt) == IstClock.Today()));
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
        // Background work: its Dhan calls are not sent outside market hours (MarketHours).
        using var background = MarketHours.BackgroundScope();
        _tickSubscription = _feed.AddTickConsumer("Positions", OnTick);
        _ = RunTimeExitLoopAsync(stoppingToken);
        _orderUpdates.OrderUpdated += ApplyOrderUpdate;
        _orderUpdates.Connected += RequestRefresh;
        try
        {
            var refresh = true;
            while (!stoppingToken.IsCancellationRequested)
            {
                // Market hours only (MarketHours): after the close nothing reads positions / orders on its own - a page
                // opening still reads them once (LiveTradingController).
                if (refresh && MarketHours.IsOpenNow)
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
        decimal? filledPrice = null;
        LiveTradeEvent? newEvent = null;
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
                filledPrice = price;
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

            // 3. What it means for the trader - once per order, leg and outcome.
            var tag = u.CorrelationId ?? (u.IsSuperOrder ? _currentOrders.FirstOrDefault(o => o.OrderId == u.OrderNo)?.CorrelationId : null);
            uint.TryParse(u.SecurityId, out var symbolId);
            var symbolName = _currentPositions.FirstOrDefault(p => p.SecurityId == u.SecurityId)?.TradingSymbol
                ?? _chain.FindBySecurityId(symbolId)?.TradingSymbol ?? u.Symbol ?? u.SecurityId;
            if (TradeEventOf(u, tag, symbolName, filledPrice) is { } e)
            {
                var today = IstClock.Today();
                if (_eventsDay != today) { _events.Clear(); _eventKeys.Clear(); _eventsDay = today; }
                if (_eventKeys.Add(e.Id))
                {
                    _events.Add(e);
                    if (_events.Count > MaxEvents) _events.RemoveAt(0);
                    newEvent = e;
                }
            }
        }

        if (newEvent is { } announced && _telegram is not null)
        {
            var text = $"{announced.Title}: {announced.Text}";
            _ = Task.Run(async () =>
            {
                try { await _telegram.SendAsync(System.Net.WebUtility.HtmlEncode(text), CancellationToken.None); }
                catch (Exception ex) { _logger.LogWarning(ex, "Telegram for a live trade event failed."); }
            });
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

    /// <summary>The trader-facing meaning of an order update - only for orders this app placed (tags
    /// "OIR-" entries, "OIRX-" exits, "OIRP-" protection; strategy triggers report their own): a super
    /// order's entry (leg 1) filling, its stop-loss (leg 2) or target (leg 3) hitting, an exit filling, or
    /// a rejection. Part fills are reported once ("partly"), the full fill once more. Null otherwise.</summary>
    internal static LiveTradeEvent? TradeEventOf(DhanOrderUpdate u, string? tag, string symbol, decimal? fillPrice)
    {
        if (tag is null || !tag.StartsWith("OIR", StringComparison.Ordinal)) return null;
        var status = (u.Status ?? "").Trim().ToUpperInvariant();
        var at = DateTimeOffset.UtcNow;
        var leg = u.IsSuperOrder ? Math.Max(1, u.LegNo) : 0;
        if (status == "REJECTED")
            return new LiveTradeEvent($"{u.OrderNo}-{leg}-REJ", at, "rejected", symbol, "Order rejected",
                $"{u.TransactionType} {symbol} x{u.Quantity}{(string.IsNullOrWhiteSpace(u.Reason) ? "" : $" - {u.Reason}")}");
        if (status is not ("TRADED" or "PART_TRADED") || u.TradedQty <= 0) return null;
        var kind = leg switch
        {
            2 => "stopLoss",
            3 => "target",
            1 => "entry",
            _ => tag.StartsWith("OIRP-", StringComparison.Ordinal) ? "stopLoss" : tag.StartsWith("OIRX-", StringComparison.Ordinal) ? "exit" : "entry",
        };
        var title = kind switch { "stopLoss" => "Stop-loss hit", "target" => "Target hit", "exit" => "Exit filled", _ => "Entry filled" };
        var full = status == "TRADED";
        var price = u.AvgTradedPrice > 0 ? u.AvgTradedPrice : fillPrice ?? (u.TradedPrice > 0 ? u.TradedPrice : (decimal?)null);
        var text = $"{u.TransactionType} {symbol} x{u.TradedQty}{(full ? "" : $" of {u.Quantity} (partly)")}{(price is { } px ? $" @ {px:0.##}" : "")}";
        return new LiveTradeEvent($"{u.OrderNo}-{leg}-{(full ? "T" : "P")}", at, kind, symbol, full ? title : $"{title} (partly)", text);
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
                var j = legs.FindIndex(l => l.LegName == other && IsOpenStatus(l.OrderStatus));
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
        if (TrailsDue(tick) is { } moves) foreach (var (orderId, stop) in moves) _ = MoveTrailingStopAsync(orderId, stop);
        if (tracked) Push();
    }

    /// <summary>Where a trailing stop-loss should be for the best premium so far: once the trade is
    /// <paramref name="start"/> points in profit, <paramref name="gap"/> points behind the best (a BUY's stop
    /// below it, a SELL's above), rounded to the tick; null when off or not that far in profit yet. The
    /// same rule as the paper trades (optionanalytics.client/src/optionTrail.js).</summary>
    internal static decimal? TrailStop(bool entryIsSell, decimal entry, decimal best, decimal start, decimal gap, decimal tick)
    {
        if (gap <= 0 || entry <= 0 || best <= 0) return null;
        var profit = entryIsSell ? entry - best : best - entry;
        if (profit < Math.Max(0, start)) return null;
        var level = StrategyTriggerHostedService.RoundToTick(entryIsSell ? best + gap : best - gap, tick > 0 ? tick : 0.05m);
        return level > 0 ? level : null;
    }

    /// <summary>Starts (gap above 0) or stops trailing the stop-loss of these super orders.</summary>
    public void SetTrail(IReadOnlyList<string> orderIds, decimal startPoints, decimal gapPoints)
    {
        lock (_lock)
        {
            foreach (var id in orderIds)
            {
                if (gapPoints <= 0) { _trails.Remove(id); continue; }
                if (_trails.TryGetValue(id, out var existing)) { existing.Start = startPoints; existing.Gap = gapPoints; }
                else _trails[id] = new TrailState { Start = startPoints, Gap = gapPoints };
            }
        }
    }

    /// <summary>Has the server close these super orders' trade at <paramref name="exitAt"/> (no later than
    /// 15:10 IST that day) - cancel its legs and exit its quantity, ExitTradeAsync - whether or not a
    /// browser is open. Replaces any time exit already set for them. Returns the time set, or null for
    /// no orders / a time already past.</summary>
    public DateTimeOffset? SetTimeExit(IReadOnlyList<string> orderIds, DateTimeOffset exitAt, decimal slippagePoints, string reason)
    {
        if (orderIds.Count == 0) return null;
        var cutoff = IstClock.AtIstTime(IstClock.IstDate(exitAt), TimeExitCutoffMinute);
        if (exitAt > cutoff) exitAt = cutoff;
        if (exitAt <= UtcNow()) return null;
        lock (_lock)
        {
            _timeExits.RemoveAll(e => e.OrderIds.Intersect(orderIds).Any());
            _timeExits.Add(new LiveTimeExit(orderIds.ToArray(), exitAt, slippagePoints, reason));
            SaveTimeExits();
        }
        _logger.LogInformation("Time exit set for {Orders} at {At:HH:mm:ss} IST ({Reason}).", string.Join(",", orderIds), exitAt.ToOffset(IstClock.Offset), reason);
        return exitAt;
    }

    /// <summary>Drops the time exit of these super orders (their trade was closed some other way).</summary>
    public void ClearTimeExit(IReadOnlyList<string> orderIds)
    {
        lock (_lock)
        {
            if (_timeExits.RemoveAll(e => e.OrderIds.Intersect(orderIds).Any()) > 0) SaveTimeExits();
        }
    }

    /// <summary>The time exits waiting, soonest first.</summary>
    public IReadOnlyList<LiveTimeExit> TimeExits()
    {
        lock (_lock) return _timeExits.OrderBy(e => e.ExitAt).ToList();
    }

    private void SaveTimeExits() => _timeExitStore?.Save(_timeExits.ToList());

    private async Task RunTimeExitLoopAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken); }
            catch (OperationCanceledException) { break; }
            try { await RunDueTimeExitsAsync(UtcNow(), stoppingToken); }
            catch (Exception ex) when (ex is not OperationCanceledException) { _logger.LogWarning(ex, "Running the time exits failed."); }
        }
    }

    /// <summary>Closes every trade whose time exit is due at <paramref name="now"/>: ExitTradeAsync with
    /// <c>onlyWithWorkingLegs</c> - a trade already closed by hand, by its own legs or by the page is left
    /// alone (never an exit of a newer position in the same contract). A failure is retried every
    /// TimeExitRetryInterval, up to MaxTimeExitAttempts; each outcome is logged and sent to Telegram.</summary>
    internal async Task RunDueTimeExitsAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        List<LiveTimeExit> due;
        lock (_lock) due = _timeExits.Where(e => e.ExitAt <= now && e.NextTry <= now).ToList();
        foreach (var exit in due)
        {
            var result = await ExitTradeAsync(exit.OrderIds, exit.SlippagePoints, cancellationToken, onlyWithWorkingLegs: true);
            var attempts = exit.Attempts + 1;
            var done = result.Success || result.Message.Contains("does not list these super orders", StringComparison.Ordinal) || attempts >= MaxTimeExitAttempts;
            lock (_lock)
            {
                var index = _timeExits.IndexOf(exit);
                if (index < 0) continue; // cleared meanwhile
                if (done) _timeExits.RemoveAt(index);
                else _timeExits[index] = exit with { Attempts = attempts, NextTry = now + TimeExitRetryInterval };
                SaveTimeExits();
            }
            var at = exit.ExitAt.ToOffset(IstClock.Offset).ToString("HH:mm");
            var text = result.Success
                ? $"Server time exit ({exit.Reason}, {at} IST) of {string.Join(",", exit.OrderIds)}: {result.Message}"
                : done
                    ? $"Server time exit ({exit.Reason}, {at} IST) of {string.Join(",", exit.OrderIds)} FAILED after {attempts} tries - check Dhan: {result.Message}"
                    : null;
            if (result.Success) _logger.LogWarning("{Text}", text);
            else _logger.LogWarning("Time exit of {Orders} (try {Attempt}) failed: {Message}", string.Join(",", exit.OrderIds), attempts, result.Message);
            if (text is not null && _telegram is not null)
            {
                try { await _telegram.SendAsync(System.Net.WebUtility.HtmlEncode(text), CancellationToken.None); }
                catch (Exception ex) { _logger.LogWarning(ex, "Telegram for a time exit failed."); }
            }
        }
    }

    /// <summary>The trailing stops this tick moves: for each trailed super order of the tick's contract
    /// whose entry has filled and whose stop-loss leg is still working, the best premium is updated and,
    /// when the trailing level is at least a tick tighter than the leg (and still on the right side of
    /// the market), the leg is moved - at most once per TrailModifyInterval, one request at a time.</summary>
    private List<(string OrderId, decimal Stop)>? TrailsDue(SpotTick tick)
    {
        if (tick.LastPrice <= 0) return null;
        List<(string, decimal)>? due = null;
        lock (_lock)
        {
            if (_trails.Count == 0) return null;
            var now = DateTimeOffset.UtcNow;
            foreach (var (orderId, trail) in _trails)
            {
                var order = _currentOrders.FirstOrDefault(o => o.OrderId == orderId);
                if (order is null || order.SecurityId != tick.SecurityId.ToString() || !string.Equals(order.OrderStatus, "TRADED", StringComparison.OrdinalIgnoreCase)) continue;
                var leg = order.LegDetails.FirstOrDefault(l => l.LegName == "STOP_LOSS_LEG" && IsOpenStatus(l.OrderStatus));
                if (leg?.Price is not { } legStop || legStop <= 0) continue;
                var isSell = string.Equals(order.TransactionType, "SELL", StringComparison.OrdinalIgnoreCase);
                var entry = _fills.TryGetValue((orderId, 1), out var fill) && fill.Avg is > 0 ? fill.Avg.Value : order.Price;
                trail.Best = trail.Best <= 0 ? entry : isSell ? Math.Min(trail.Best, tick.LastPrice) : Math.Max(trail.Best, tick.LastPrice);
                var tickSize = _chain.FindBySecurityId(tick.SecurityId)?.TickSize is > 0 and var t ? t : 0.05m;
                if (TrailStop(isSell, entry, trail.Best, trail.Start, trail.Gap, tickSize) is not { } stop) continue;
                var current = trail.LastSent is { } sent ? (isSell ? Math.Min(legStop, sent) : Math.Max(legStop, sent)) : legStop;
                var tighter = isSell ? stop <= current - tickSize : stop >= current + tickSize;
                var marketSide = isSell ? stop > tick.LastPrice : stop < tick.LastPrice;
                if (!tighter || !marketSide || trail.InFlight || now - trail.LastSentAt < TrailModifyInterval) continue;
                trail.InFlight = true;
                (due ??= new()).Add((orderId, stop));
            }
        }
        return due;
    }

    private async Task MoveTrailingStopAsync(string orderId, decimal stop)
    {
        try
        {
            // Never alongside a Close / Exit / Cancel: if one is running, this move waits for a later tick.
            if (!await _actionLock.WaitAsync(0)) return;
            try
            {
                var (result, error) = await _superOrders.ModifyAsync(orderId, "STOP_LOSS_LEG", null, null, null, null, stop, null, CancellationToken.None);
                if (result is null) { _logger.LogWarning("Trailing stop of {Order}: Dhan did not move it to {Stop} - {Error}", orderId, stop, error); return; }
                lock (_lock)
                {
                    if (_trails.TryGetValue(orderId, out var trail)) { trail.LastSent = stop; trail.LastSentAt = DateTimeOffset.UtcNow; }
                }
                _logger.LogInformation("Trailing stop of {Order} moved to {Stop}.", orderId, stop);
            }
            finally
            {
                _actionLock.Release();
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Moving the trailing stop of {Order} failed.", orderId);
        }
        finally
        {
            lock (_lock) { if (_trails.TryGetValue(orderId, out var trail)) trail.InFlight = false; }
        }
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
        List<LiveTradeEvent> events;
        lock (_lock)
        {
            positions = _currentPositions;
            orders = _currentOrders;
            plainOrders = _currentPlainOrders;
            refreshed = _refreshedUtc;
            lastEvent = _lastEventUtc;
            events = _eventsDay == IstClock.Today() ? _events.ToList() : new List<LiveTradeEvent>();
        }

        var rows = new List<LivePositionRow>(positions.Count);
        foreach (var p in positions)
        {
            decimal? ltp = uint.TryParse(p.SecurityId, out var id) && _feed.LastTickFor(id) is { LastPrice: > 0 } tick ? tick.LastPrice : null;
            var legs = orders.Where(o => o.SecurityId == p.SecurityId && o.OrderStatus is "TRADED" or "PART_TRADED").ToList();
            var target = legs.SelectMany(o => o.LegDetails).FirstOrDefault(l => l.LegName == "TARGET_LEG" && IsOpenStatus(l.OrderStatus));
            var stopLoss = legs.SelectMany(o => o.LegDetails).FirstOrDefault(l => l.LegName == "STOP_LOSS_LEG" && IsOpenStatus(l.OrderStatus));
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
            .Where(o => IsOpenStatus(o.OrderStatus))
            .Select(o => new LivePendingOrder(o.OrderId, o.SecurityId, SymbolOf(o.SecurityId),
                o.TransactionType, o.Quantity - (o.FilledQty ?? 0), o.Price, o.TargetPrice, o.StopLossPrice, o.OrderStatus) { Kind = "Entry", Leg = "ENTRY_LEG" })
            .Concat(orders
                .Where(o => o.OrderStatus is "TRADED" or "PART_TRADED")
                .SelectMany(o => o.LegDetails
                    .Where(l => l.LegName is "TARGET_LEG" or "STOP_LOSS_LEG" && IsOpenStatus(l.OrderStatus))
                    .Select(l => new LivePendingOrder(o.OrderId, o.SecurityId, SymbolOf(o.SecurityId),
                        string.IsNullOrEmpty(l.TransactionType) ? (o.TransactionType == "BUY" ? "SELL" : "BUY") : l.TransactionType,
                        o.FilledQty is > 0 and var f ? f : o.Quantity, l.Price ?? 0,
                        l.LegName == "TARGET_LEG" ? l.Price : o.TargetPrice, l.LegName == "STOP_LOSS_LEG" ? l.Price : o.StopLossPrice, l.OrderStatus)
                    { Kind = l.LegName == "TARGET_LEG" ? "Target leg" : "Stop-loss leg", Leg = l.LegName })))
            .Concat(plainOrders
                .Where(o => IsOpenStatus(o.OrderStatus) && !superIds.Contains(o.OrderId) && (o.CorrelationId is null || !superTags.Contains(o.CorrelationId)))
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
        { LastOrderEventUtc = lastEvent, Events = events };
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

    /// <summary>The entry price alone, for an order with no stop-loss / target (ManualOrderRequest.NoStop): the live
    /// ask plus the slippage for a buy, the bid minus it for a sell, on the tick. Target / StopLoss are 0.</summary>
    internal static (ManualOrderPrices? Prices, string? Error) PriceEntryOnly(bool isSell, decimal bestBid, decimal bestAsk, decimal slippage, decimal tickSize)
    {
        var reference = isSell ? bestBid : bestAsk;
        if (reference <= 0) return (null, $"no live {(isSell ? "bid" : "ask")} for this contract yet");
        if (slippage < 0) return (null, "slippage cannot be negative");
        var tick = tickSize > 0 ? tickSize : 0.05m;
        var limit = StrategyTriggerHostedService.RoundToTick(isSell ? reference - slippage : reference + slippage, tick);
        if (limit <= 0) return (null, "the limit price would be at or below zero for this premium");
        return (new ManualOrderPrices(reference, limit, 0, 0), null);
    }

    /// <summary>Why no new order may go out now - the daily loss limit's kill switch (KillSwitchService) -
    /// else null. Checked before every new order; exits are never blocked.</summary>
    public Func<string?>? NewOrderBlock { get; set; }

    public async Task<ManualOrderResult> PlaceAsync(ManualOrderRequest request, CancellationToken cancellationToken)
    {
        if (NewOrderBlock?.Invoke() is { } blocked) return ManualOrderResult.Fail($"Blocked: {blocked}.");
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
            var (prices, error) = request.NoStop
                ? PriceEntryOnly(isSell, quote?.BestBidPrice ?? 0, quote?.BestAskPrice ?? 0, request.SlippagePoints, contract.TickSize)
                : PriceOrder(isSell, quote?.BestBidPrice ?? 0, quote?.BestAskPrice ?? 0,
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
                // No SL: a plain LIMIT entry (intraday, day validity) - no legs. Otherwise a super order with both legs.
                var (placedId, placeError) = request.NoStop
                    ? await PlacePlainEntryAsync(transactionType, contract, slices[i], prices.Limit, $"OIR-{stamp}-{i + 1}", cancellationToken)
                    : await PlaceSuperEntryAsync(transactionType, contract, slices[i], prices, $"OIR-{stamp}-{i + 1}", cancellationToken);
                if (placedId is null)
                {
                    RefreshUnlessStreaming();
                    if (request.ExitAtMs > 0) SetTimeExit(orderIds, DateTimeOffset.FromUnixTimeMilliseconds(request.ExitAtMs), request.SlippagePoints, request.ExitReason ?? "time stop");
                    return ManualOrderResult.Fail(orderIds.Count == 0
                        ? $"Dhan rejected the order: {placeError}"
                        : $"placed {orderIds.Count} of {slices.Count} slices, then Dhan rejected the next: {placeError}", orderIds, prices) with { LotSize = contract.LotSize };
                }
                orderIds.Add(placedId);
            }

            if (request.TrailGapPoints > 0 && !request.NoStop) SetTrail(orderIds, request.TrailStartPoints, request.TrailGapPoints);
            var exitAt = request.ExitAtMs > 0 ? SetTimeExit(orderIds, DateTimeOffset.FromUnixTimeMilliseconds(request.ExitAtMs), request.SlippagePoints, request.ExitReason ?? "time stop") : null;
            _logger.LogWarning("Manual LIVE order: {Transaction} {Symbol} x{Quantity} LIMIT {Limit} (ref {Reference}), {Legs} - orders {Orders}.",
                transactionType, contract.TradingSymbol, quantity, prices.Limit, prices.Reference,
                request.NoStop ? "no stop-loss / target" : $"target {prices.Target}, SL {prices.StopLoss}", string.Join(",", orderIds));
            RefreshUnlessStreaming();
            var legs = request.NoStop
                ? " · no stop-loss / target - it stays open until you close it (Dhan squares intraday positions off at the end of the day)"
                : $" · target {prices.Target:0.##} · SL {prices.StopLoss:0.##}";
            return new ManualOrderResult(true,
                $"{transactionType} {contract.TradingSymbol} x{quantity} at LIMIT {prices.Limit:0.##} ({(isSell ? "bid" : "ask")} {prices.Reference:0.##}){legs}"
                + (exitAt is { } t ? $" · the server closes it at {t.ToOffset(IstClock.Offset):HH:mm} IST" : ""),
                orderIds, prices) { LotSize = contract.LotSize };
        }
        finally
        {
            _actionLock.Release();
        }
    }

    private async Task<(string? OrderId, string? Error)> PlaceSuperEntryAsync(
        string transactionType, DhanOptionInstrument contract, int quantity, ManualOrderPrices prices, string tag, CancellationToken cancellationToken)
    {
        var (result, error) = await _superOrders.PlaceAsync(
            transactionType, contract.DhanSegment, ProductType, "LIMIT", contract.SecurityId.ToString(), quantity,
            prices.Limit, prices.Target, prices.StopLoss, tag, 0, cancellationToken);
        return (result?.OrderId, error);
    }

    private async Task<(string? OrderId, string? Error)> PlacePlainEntryAsync(
        string transactionType, DhanOptionInstrument contract, int quantity, decimal limit, string tag, CancellationToken cancellationToken)
    {
        var (result, error) = await _orders.PlaceAsync(
            transactionType, contract.DhanSegment, ProductType, "LIMIT", "DAY", contract.SecurityId.ToString(), quantity, limit, tag, cancellationToken);
        return (result?.OrderId, error);
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

            // Whatever is still open once the positions are being closed - legs and protection orders of
            // positions that were already flat, orders that appeared meanwhile. The exits just placed stay.
            var (leftover, leftoverLegs, sweepFailures) = await SweepOpenOrdersAsync(includeWorkingExits: false, cancellationToken);
            failures.AddRange(sweepFailures);
            if (leftover + leftoverLegs > 0) messages.Add($"cancelled {leftover} leftover order(s) and {leftoverLegs} stop-loss / target leg(s)");

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

    /// <summary>Cancels every open order on the account - unfilled super orders (with their legs) and
    /// pending plain orders - and the target / stop-loss legs and protection orders of open positions,
    /// WITHOUT closing any position. Positions are left with no stop-loss or target.</summary>
    public async Task<ManualOrderResult> CancelAllOrdersAsync(CancellationToken cancellationToken)
    {
        if (!_session.IsAuthenticated) return ManualOrderResult.Fail("not logged in to Dhan right now");
        await _actionLock.WaitAsync(cancellationToken);
        try
        {
            var (cancelled, legs, failures) = await SweepOpenOrdersAsync(includeWorkingExits: true, cancellationToken);
            RequestRefresh();
            var text = $"cancelled {cancelled} order(s) and {legs} stop-loss / target leg(s)";
            return failures.Count == 0 ? new ManualOrderResult(true, text, Array.Empty<string>(), null) : ManualOrderResult.Fail($"{string.Join(" · ", failures)} · {text}");
        }
        finally
        {
            _actionLock.Release();
        }
    }

    /// <summary>Cancels EVERYTHING still open on the account: unfilled super orders (with their legs), pending
    /// plain orders, the target / stop-loss legs of filled super orders and protection stop-losses -
    /// and, with <paramref name="includeWorkingExits"/>, this panel's own working exits (OIRX-) too. The
    /// last step of Exit all and Emergency exit, so no order is left behind for a position that is
    /// already flat (or that Dhan closed itself).</summary>
    private async Task<(int Cancelled, int Legs, List<string> Failures)> SweepOpenOrdersAsync(bool includeWorkingExits, CancellationToken cancellationToken)
    {
        var (cancelled, failures) = await CancelPendingAsync(null, cancellationToken);
        var legs = 0;
        foreach (var order in (await _superOrders.ListAsync(cancellationToken)).Where(o => o.OrderStatus is "TRADED" or "PART_TRADED"))
        {
            foreach (var leg in order.LegDetails.Where(l => l.LegName is "TARGET_LEG" or "STOP_LOSS_LEG" && IsOpenStatus(l.OrderStatus)))
            {
                var (result, error) = await _superOrders.CancelAsync(order.OrderId, leg.LegName, cancellationToken);
                if (result is null) failures.Add($"could not cancel {leg.LegName} of {order.OrderId}: {error}"); else legs++;
            }
        }
        foreach (var order in (await _orders.ListAsync(cancellationToken)).Where(o => IsOpenStatus(o.OrderStatus)
                     && (IsProtection(o) || (includeWorkingExits && o.CorrelationId?.StartsWith("OIRX-", StringComparison.Ordinal) == true))))
        {
            var (result, error) = await _orders.CancelAsync(order.OrderId, cancellationToken);
            if (result is null) failures.Add($"could not cancel {order.OrderId}: {error}"); else cancelled++;
        }
        return (cancelled, legs, failures);
    }

    /// <summary>Dhan's own exit-everything (DELETE /positions): every position and every open order on
    /// the account, strategy triggers' included. For when the careful Exit all is not enough.</summary>
    public async Task<ManualOrderResult> EmergencyExitAllAsync(CancellationToken cancellationToken)
    {
        if (!_session.IsAuthenticated) return ManualOrderResult.Fail("not logged in to Dhan right now");
        var error = await _positions.ExitAllAccountAsync(cancellationToken);
        _logger.LogWarning("EMERGENCY exit-all (Dhan DELETE /positions) requested: {Result}.", error ?? "accepted");
        // Dhan's call does not reliably clear every open order (target / stop-loss legs and pending orders
        // can stay behind), so after it - even when it failed - every order still open is cancelled here.
        // Dhan needs a moment to book the exits before the legs of the closed positions show as open.
        var failures = new List<string>();
        var swept = 0;
        try { await Task.Delay(TimeSpan.FromSeconds(1.5), cancellationToken); } catch (OperationCanceledException) { }
        await _actionLock.WaitAsync(CancellationToken.None);
        try
        {
            for (var pass = 0; pass < 2; pass++)
            {
                var (cancelled, legs, passFailures) = await SweepOpenOrdersAsync(includeWorkingExits: true, CancellationToken.None);
                swept += cancelled + legs;
                failures = passFailures;
                if (cancelled + legs == 0 && passFailures.Count == 0) break;
                await Task.Delay(TimeSpan.FromSeconds(1), CancellationToken.None);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Emergency exit: the sweep of leftover orders failed.");
            failures.Add($"leftover-order sweep failed: {ex.Message}");
        }
        finally
        {
            _actionLock.Release();
        }
        RefreshUnlessStreaming();
        var sweepText = swept > 0 ? $" · {swept} leftover order(s) / leg(s) cancelled" : "";
        var failureText = failures.Count > 0 ? $" · {string.Join(" · ", failures)}" : "";
        if (error is not null) return ManualOrderResult.Fail($"Dhan rejected exit-all: {error}{sweepText}{failureText}");
        return failures.Count == 0
            ? new ManualOrderResult(true, $"Dhan accepted exit-all: every position on the account is being closed and every open order cancelled{sweepText}", Array.Empty<string>(), null)
            : ManualOrderResult.Fail($"Dhan accepted exit-all, but some orders could not be cancelled{failureText}{sweepText}");
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
        foreach (var entry in superOrders.Where(o => IsOpenStatus(o.OrderStatus) && (securityId is null || o.SecurityId == securityId)))
        {
            var (result, error) = await _superOrders.CancelAsync(entry.OrderId, "ENTRY_LEG", cancellationToken);
            if (result is null) failures.Add($"could not cancel pending super order {entry.OrderId}: {error}");
            else cancelled++;
        }
        // A super order's own legs can show in the plain order book too - those go with their super order.
        var superIds = superOrders.Select(o => o.OrderId).ToHashSet();
        foreach (var order in (await _orders.ListAsync(cancellationToken)).Where(o =>
                     IsOpenStatus(o.OrderStatus) && (securityId is null || o.SecurityId == securityId) && !superIds.Contains(o.OrderId)
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

        var netQty = ClosableNetQty(position);
        if (netQty == 0)
        {
            RequestRefresh();
            return new ManualOrderResult(true, $"{position.TradingSymbol}: the position has just closed on Dhan (its stop-loss or target filled) - nothing sent; check it and press Close again if it is still open", Array.Empty<string>(), null);
        }
        var working = await WorkingExitQuantityAsync(position, cancellationToken);
        var quantity = ExitQuantity(netQty, working);
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
            if (superOrders.Any(o => IsOpenStatus(o.OrderStatus)))
                return ManualOrderResult.Fail($"{position.TradingSymbol}: an entry for this contract is still filling - wait for it (or cancel it) before a partial exit");

            var working = await WorkingExitQuantityAsync(position, cancellationToken);
            var quantity = (int)Math.Min(requested, ExitQuantity(ClosableNetQty(position), working));
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

    /// <summary>
    /// Closes ONE trade - the super order(s) it was placed as (a strategy trade from the Order Flow page,
    /// sliced orders included) - and nothing else in that contract. Dhan nets a contract into one
    /// position, so Close would also close any other trade in the same strike; this works per order:
    ///  - entry not (fully) filled: cancel its ENTRY_LEG, which cancels the whole super order, legs too;
    ///  - entry filled: cancel its still-open TARGET_LEG and STOP_LOSS_LEG, then one chased LIMIT exit
    ///    for exactly the quantity this trade filled (never more than is open, less any exit working);
    ///  - a target or stop-loss leg already filled: Dhan closed it (and cancelled the other leg) - nothing to do.
    /// </summary>
    /// <param name="onlyWithWorkingLegs">For a filled entry, exit only while its stop-loss or target leg is
    /// still working - legs gone means the trade was already closed (by hand, an exit-all, a partial exit's
    /// own protection), so nothing is placed. The server's time exit uses it, so a later position in the
    /// same contract is never closed in the trade's name.</param>
    public async Task<ManualOrderResult> ExitTradeAsync(IReadOnlyList<string> orderIds, decimal slippagePoints, CancellationToken cancellationToken, bool onlyWithWorkingLegs = false)
    {
        if (!_session.IsAuthenticated) return ManualOrderResult.Fail("not logged in to Dhan right now");
        if (orderIds.Count == 0) return ManualOrderResult.Fail("no orders given");
        await _actionLock.WaitAsync(cancellationToken);
        try
        {
            var mine = (await _superOrders.ListAsync(cancellationToken)).Where(o => orderIds.Contains(o.OrderId)).ToList();
            if (mine.Count == 0) return ManualOrderResult.Fail("Dhan does not list these super orders today");
            var messages = new List<string>();
            var failures = new List<string>();
            long toExit = 0;
            var cancelledEntries = new HashSet<string>();
            var securityId = mine[0].SecurityId;

            async Task CancelLeg(string orderId, string leg)
            {
                var (result, error) = await _superOrders.CancelAsync(orderId, leg, cancellationToken);
                if (result is null) failures.Add($"{orderId} {leg}: Dhan did not cancel it ({error ?? "no reason given"})");
                else messages.Add($"{orderId} {leg} cancelled");
            }

            foreach (var order in mine)
            {
                var status = (order.OrderStatus ?? "").Trim().ToUpperInvariant();
                var filled = order.FilledQty ?? (status == "TRADED" ? order.Quantity : 0);
                if (status == "TRADED")
                {
                    var closedBy = order.LegDetails.FirstOrDefault(l => l.LegName is "TARGET_LEG" or "STOP_LOSS_LEG"
                        && string.Equals(l.OrderStatus, "TRADED", StringComparison.OrdinalIgnoreCase));
                    if (closedBy is not null) { messages.Add($"{order.OrderId}: already closed on Dhan by its {(closedBy.LegName == "TARGET_LEG" ? "target" : "stop-loss")}"); continue; }
                    var workingLegs = order.LegDetails.Where(l => l.LegName is "TARGET_LEG" or "STOP_LOSS_LEG" && IsOpenStatus(l.OrderStatus)).ToList();
                    if (onlyWithWorkingLegs && workingLegs.Count == 0) { messages.Add($"{order.OrderId}: no working stop-loss / target - already closed, nothing to do"); continue; }
                    foreach (var leg in workingLegs)
                        await CancelLeg(order.OrderId, leg.LegName);
                    toExit += filled;
                }
                else if (IsOpenStatus(status))
                {
                    await CancelLeg(order.OrderId, "ENTRY_LEG");
                    cancelledEntries.Add(order.OrderId);
                    toExit += filled;
                }
                else messages.Add($"{order.OrderId}: {status.ToLowerInvariant()} - nothing to do");
            }

            // An entry still filling when its cancel went out can fill more before the cancel lands: read
            // those orders again so the exit covers what they ended up filling, not what they had before.
            if (cancelledEntries.Count > 0)
            {
                var after = (await _superOrders.ListAsync(cancellationToken)).Where(o => cancelledEntries.Contains(o.OrderId)).ToList();
                foreach (var order in after)
                {
                    var before = mine.First(o => o.OrderId == order.OrderId).FilledQty ?? 0;
                    var now = order.FilledQty ?? (string.Equals(order.OrderStatus, "TRADED", StringComparison.OrdinalIgnoreCase) ? order.Quantity : 0);
                    if (now > before) toExit += now - before;
                }
            }

            var orderIdsOut = new List<string>();
            if (toExit > 0)
            {
                var position = (await _positions.ListAsync(cancellationToken)).FirstOrDefault(p => p.SecurityId == securityId && p.IsOpen);
                if (position is null) messages.Add("the position is already flat");
                else
                {
                    var working = await WorkingExitQuantityAsync(position, cancellationToken);
                    var quantity = (int)Math.Min(toExit, ExitQuantity(ClosableNetQty(position), working));
                    if (quantity <= 0) messages.Add("exit orders for it are already working");
                    else
                    {
                        var (ids, price, error) = await PlaceExitAsync(position, quantity, slippagePoints, cancellationToken);
                        orderIdsOut.AddRange(ids);
                        if (error is not null) failures.Add(error);
                        else messages.Add($"{(position.ClosesBySelling ? "SELL" : "BUY")} {position.TradingSymbol} x{quantity} at LIMIT {price:0.##} to close this trade");
                    }
                }
            }
            _logger.LogWarning("Live trade exit for {Orders}: {Messages} {Failures}", string.Join(",", orderIds), string.Join(" · ", messages), string.Join(" · ", failures));
            RequestRefresh();
            var text = string.Join(" · ", failures.Concat(messages));
            return failures.Count == 0 ? new ManualOrderResult(true, text, orderIdsOut, null) : ManualOrderResult.Fail(text, orderIdsOut);
        }
        finally
        {
            _actionLock.Release();
        }
    }

    /// <summary>Moves ONE trade's stop-loss and target to <paramref name="stopLossPoints"/> /
    /// <paramref name="targetPoints"/> premium points from its entry price - the actual fill once known,
    /// else the entry's limit (0 = leave that leg as it is):
    /// the TARGET_LEG / STOP_LOSS_LEG of a filled entry, or the ENTRY_LEG's own levels while it is still
    /// pending - the only parts of a super order Dhan lets change.</summary>
    public async Task<ManualOrderResult> UpdateTradeLevelsAsync(IReadOnlyList<string> orderIds, decimal stopLossPoints, decimal targetPoints, CancellationToken cancellationToken)
    {
        if (!_session.IsAuthenticated) return ManualOrderResult.Fail("not logged in to Dhan right now");
        if (orderIds.Count == 0) return ManualOrderResult.Fail("no orders given");
        await _actionLock.WaitAsync(cancellationToken);
        try
        {
            var mine = (await _superOrders.ListAsync(cancellationToken)).Where(o => orderIds.Contains(o.OrderId)).ToList();
            var messages = new List<string>();
            var failures = new List<string>();
            foreach (var order in mine)
            {
                uint.TryParse(order.SecurityId, out var id);
                var tick = _chain.FindBySecurityId(id)?.TickSize is > 0 and var t ? t : 0.05m;
                var isSell = string.Equals(order.TransactionType, "SELL", StringComparison.OrdinalIgnoreCase);
                var status = (order.OrderStatus ?? "").Trim().ToUpperInvariant();
                // From the entry's actual fill (its average traded price, known from the order-update
                // socket) once it has filled - the order's own price is only its LIMIT (bid/ask plus the
                // slippage), so levels measured from it would sit off by the slippage.
                decimal entry = order.Price;
                lock (_lock)
                {
                    if (status == "TRADED" && _fills.TryGetValue((order.OrderId, 1), out var fill) && fill.Avg is > 0) entry = fill.Avg.Value;
                }
                decimal? target = targetPoints > 0 ? StrategyTriggerHostedService.RoundToTick(Math.Max(tick, isSell ? entry - targetPoints : entry + targetPoints), tick) : null;
                decimal? stop = stopLossPoints > 0 ? StrategyTriggerHostedService.RoundToTick(Math.Max(tick, isSell ? entry + stopLossPoints : entry - stopLossPoints), tick) : null;
                var changes = new List<(string Leg, decimal? Target, decimal? Stop)>();
                if (status == "TRADED")
                {
                    if (target is not null && order.LegDetails.Any(l => l.LegName == "TARGET_LEG" && IsOpenStatus(l.OrderStatus))) changes.Add(("TARGET_LEG", target, null));
                    // A stop that has already trailed past the new level stays where it is - a new Max SL never loosens it.
                    decimal? trailed;
                    lock (_lock) trailed = _trails.TryGetValue(order.OrderId, out var tr) ? tr.LastSent : null;
                    if (stop is { } st && trailed is { } tl && (isSell ? tl < st : tl > st)) stop = null;
                    if (stop is not null && order.LegDetails.Any(l => l.LegName == "STOP_LOSS_LEG" && IsOpenStatus(l.OrderStatus))) changes.Add(("STOP_LOSS_LEG", null, stop));
                }
                else if (IsOpenStatus(status) && (target is not null || stop is not null)) changes.Add(("ENTRY_LEG", target, stop));
                foreach (var (leg, newTarget, newStop) in changes)
                {
                    var (result, error) = await _superOrders.ModifyAsync(order.OrderId, leg, null, null, null, newTarget, newStop, null, cancellationToken);
                    if (result is null) failures.Add($"{order.OrderId} {leg}: Dhan did not modify it ({error ?? "no reason given"})");
                    else messages.Add($"{order.OrderId} {leg} -> {(newTarget is { } nt ? $"target {nt:0.##}" : "")}{(newTarget is not null && newStop is not null ? ", " : "")}{(newStop is { } ns ? $"stop-loss {ns:0.##}" : "")}");
                }
            }
            RequestRefresh();
            if (messages.Count == 0 && failures.Count == 0) return new ManualOrderResult(true, "nothing to change - the trade has no open stop-loss / target legs", Array.Empty<string>(), null);
            var text = string.Join(" · ", failures.Concat(messages));
            return failures.Count == 0 ? new ManualOrderResult(true, text, Array.Empty<string>(), null) : ManualOrderResult.Fail(text);
        }
        finally
        {
            _actionLock.Release();
        }
    }

    /// <summary>Puts a stop-loss and/or target (ABSOLUTE option prices, 0 = leave that one alone) on an open
    /// position, whatever opened it. If the position has a super order's working legs those are moved to the
    /// new prices (a trailing stop continues from the new level, tightening only); a position with no
    /// stop-loss leg - a manual entry, one outside this app, or one left bare - gets a STOP_LOSS order on
    /// Dhan (trigger = the stop, limit <paramref name="slippagePoints"/> beyond it) whose tag carries the
    /// target for the server to watch, exactly like the protection order a partial exit used to place. An
    /// earlier protection order is replaced. A stop must sit on the losing side of the live price and a
    /// target on the winning side, or the order would fire at once.</summary>
    public async Task<ManualOrderResult> SetPositionProtectionAsync(string securityId, decimal stopLossPrice, decimal targetPrice, decimal slippagePoints, CancellationToken cancellationToken)
    {
        if (!_session.IsAuthenticated) return ManualOrderResult.Fail("not logged in to Dhan right now");
        if (stopLossPrice <= 0 && targetPrice <= 0) return ManualOrderResult.Fail("give a stop-loss and/or a target price");
        await _actionLock.WaitAsync(cancellationToken);
        try
        {
            var position = (await _positions.ListAsync(cancellationToken)).FirstOrDefault(p => p.SecurityId == securityId && p.IsOpen);
            if (position is null) return ManualOrderResult.Fail("no open position in that contract");
            if (!uint.TryParse(securityId, out var id)) return ManualOrderResult.Fail("unknown contract");
            var tick = _chain.FindBySecurityId(id)?.TickSize is > 0 and var t ? t : 0.05m;
            var sells = position.ClosesBySelling;
            decimal? stop = stopLossPrice > 0 ? StrategyTriggerHostedService.RoundToTick(stopLossPrice, tick) : null;
            decimal? target = targetPrice > 0 ? StrategyTriggerHostedService.RoundToTick(targetPrice, tick) : null;
            if (_feed.LastTickFor(id) is { LastPrice: > 0 } last)
            {
                var ltp = last.LastPrice;
                if (stop is { } sl && (sells ? sl >= ltp : sl <= ltp))
                    return ManualOrderResult.Fail($"{position.TradingSymbol}: the stop-loss {sl:0.##} must be {(sells ? "below" : "above")} the live price {ltp:0.##} - it would fire at once");
                if (target is { } tg && (sells ? tg <= ltp : tg >= ltp))
                    return ManualOrderResult.Fail($"{position.TradingSymbol}: the target {tg:0.##} must be {(sells ? "above" : "below")} the live price {ltp:0.##}");
            }

            var messages = new List<string>();
            var failures = new List<string>();
            var superOrders = (await _superOrders.ListAsync(cancellationToken))
                .Where(o => o.SecurityId == securityId && o.OrderStatus is "TRADED" or "PART_TRADED").ToList();
            var slLegQty = 0;
            var hasTargetLeg = false;
            foreach (var order in superOrders)
            {
                var slLeg = order.LegDetails.FirstOrDefault(l => l.LegName == "STOP_LOSS_LEG" && IsOpenStatus(l.OrderStatus));
                var tgLeg = order.LegDetails.FirstOrDefault(l => l.LegName == "TARGET_LEG" && IsOpenStatus(l.OrderStatus));
                if (slLeg is not null)
                {
                    slLegQty += order.FilledQty is > 0 and var f ? f : order.Quantity;
                    if (stop is { } newStop)
                    {
                        var (result, error) = await _superOrders.ModifyAsync(order.OrderId, "STOP_LOSS_LEG", null, null, null, null, newStop, null, cancellationToken);
                        if (result is null) failures.Add($"{order.OrderId} stop-loss: Dhan did not modify it ({error ?? "no reason given"})");
                        else
                        {
                            messages.Add($"{order.OrderId} stop-loss -> {newStop:0.##}");
                            // A trailing stop carries on from the new level, tightening only.
                            lock (_lock) { if (_trails.TryGetValue(order.OrderId, out var trail)) { trail.LastSent = newStop; trail.LastSentAt = DateTimeOffset.UtcNow; } }
                        }
                    }
                }
                if (tgLeg is not null)
                {
                    hasTargetLeg = true;
                    if (target is { } newTarget)
                    {
                        var (result, error) = await _superOrders.ModifyAsync(order.OrderId, "TARGET_LEG", null, null, null, newTarget, null, null, cancellationToken);
                        if (result is null) failures.Add($"{order.OrderId} target: Dhan did not modify it ({error ?? "no reason given"})");
                        else messages.Add($"{order.OrderId} target -> {newTarget:0.##}");
                    }
                }
            }

            // The part of the position no stop-loss leg covers gets a protection order.
            var uncovered = Math.Abs(position.NetQty) - slLegQty;
            var existing = (await _orders.ListAsync(cancellationToken)).Where(o => o.SecurityId == securityId && IsProtection(o) && IsOpenStatus(o.OrderStatus)).ToList();
            var needOrder = uncovered > 0 && (stop is not null || (target is not null && !hasTargetLeg && existing.Count > 0));
            if (target is not null && !hasTargetLeg && stop is null && existing.Count == 0 && slLegQty < Math.Abs(position.NetQty))
                failures.Add($"{position.TradingSymbol}: a target on its own needs a stop-loss too - the target is watched on the stop-loss order; add a stop-loss as well");
            if (needOrder)
            {
                // Keep what the old protection order held when only one of the two is being changed.
                var keepStop = stop ?? existing.Select(o => o.TriggerPrice).FirstOrDefault(v => v is > 0);
                var keepTarget = target ?? existing.Select(o => TargetFromTag(o.CorrelationId)).FirstOrDefault(v => v is not null);
                if (keepStop is not { } trigger)
                    failures.Add($"{position.TradingSymbol}: no stop-loss to place");
                else
                {
                    foreach (var old in existing)
                    {
                        var (cancelled, cancelError) = await _orders.CancelAsync(old.OrderId, cancellationToken);
                        if (cancelled is null) failures.Add($"could not replace the old protection order {old.OrderId}: {cancelError}");
                    }
                    if (failures.Count == 0)
                    {
                        var slip = Math.Max(0, slippagePoints);
                        var limit = StrategyTriggerHostedService.RoundToTick(Math.Max(tick, sells ? trigger - slip : trigger + slip), tick);
                        var tag = keepTarget is { } tg ? $"{ProtectionPrefix}T{(long)Math.Round(tg * 100)}-{DateTimeOffset.UtcNow:HHmmss}" : $"{ProtectionPrefix}{DateTimeOffset.UtcNow:HHmmss}";
                        var (placed, placeError) = await _orders.PlaceAsync(sells ? "SELL" : "BUY", position.ExchangeSegment, position.ProductType, "STOP_LOSS", "DAY",
                            securityId, uncovered, limit, tag, cancellationToken, triggerPrice: trigger);
                        if (placed is null) failures.Add($"{position.TradingSymbol}: Dhan rejected the stop-loss order ({placeError ?? "no reason given"})");
                        else messages.Add($"{position.TradingSymbol}: stop-loss order at trigger {trigger:0.##}{(keepTarget is { } kt ? $", target {kt:0.##} watched by the server" : "")} for {uncovered}");
                    }
                }
            }
            RequestRefresh();
            if (messages.Count == 0 && failures.Count == 0) return new ManualOrderResult(true, "nothing to change", Array.Empty<string>(), null);
            var text = string.Join(" · ", failures.Concat(messages));
            return failures.Count == 0 ? new ManualOrderResult(true, text, Array.Empty<string>(), null) : ManualOrderResult.Fail(text);
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
            && o.LegDetails.Any(l => l.LegName is "STOP_LOSS_LEG" or "TARGET_LEG" && IsOpenStatus(l.OrderStatus)))
        .Sum(o => o.FilledQty is > 0 and var f ? f : o.Quantity);

    /// <summary>Cancels what protects a position - its super orders' working target/stop-loss legs (any
    /// status not finished: PENDING, but also TRANSIT / TRIGGERED / PART_TRADED - a leg left working
    /// would fire after the exit and reverse the position) and any
    /// protection order (OIRP-) - and returns the target and stop-loss they had.</summary>
    private async Task<(decimal? Target, decimal? StopLoss)> CancelProtectionAsync(string securityId, CancellationToken cancellationToken)
    {
        decimal? target = null, stopLoss = null;
        foreach (var order in (await _superOrders.ListAsync(cancellationToken)).Where(o => o.SecurityId == securityId && o.OrderStatus is "TRADED" or "PART_TRADED"))
        {
            foreach (var leg in order.LegDetails.Where(l => l.LegName is "TARGET_LEG" or "STOP_LOSS_LEG" && IsOpenStatus(l.OrderStatus)))
            {
                if (leg.LegName == "TARGET_LEG") target ??= leg.Price ?? order.TargetPrice;
                else stopLoss ??= leg.Price ?? order.StopLossPrice;
                var (cancelled, error) = await _superOrders.CancelAsync(order.OrderId, leg.LegName, cancellationToken);
                if (cancelled is null) _logger.LogWarning("{Security}: could not cancel {Leg} of {Order} - {Error}", securityId, leg.LegName, order.OrderId, error);
            }
        }
        foreach (var order in (await _orders.ListAsync(cancellationToken)).Where(o => o.SecurityId == securityId && IsProtection(o) && IsOpenStatus(o.OrderStatus)))
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
            .Where(o => o.SecurityId == position.SecurityId && o.TransactionType == transactionType && IsOpenStatus(o.OrderStatus)
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

    /// <summary>The open quantity an exit may close, signed like the position: Dhan's REST positions
    /// can lag a fill by a moment - a stop-loss or target leg that filled just before Close cancelled it -
    /// and an exit sized from the stale number would REVERSE the position. While the order-update socket
    /// is connected its in-memory position is at least as fresh for fills, so the smaller of the two is
    /// used (flat, or the other side, in memory = nothing to close). Under-closing leaves a visible
    /// position to close again; over-closing opens a new one.</summary>
    internal int ClosableNetQty(DhanPosition rest)
    {
        if (!_orderUpdates.IsConnected) return rest.NetQty;
        DhanPosition? memory;
        lock (_lock)
            memory = _currentPositions.FirstOrDefault(p => p.SecurityId == rest.SecurityId && p.ProductType == rest.ProductType)
                ?? _currentPositions.FirstOrDefault(p => p.SecurityId == rest.SecurityId);
        return SaferNetQty(rest.NetQty, memory?.NetQty);
    }

    internal static int SaferNetQty(int restNetQty, int? memoryNetQty)
    {
        if (memoryNetQty is not { } mem) return restNetQty;
        if (mem == 0 || Math.Sign(mem) != Math.Sign(restNetQty)) return 0;
        return Math.Sign(restNetQty) * Math.Min(Math.Abs(restNetQty), Math.Abs(mem));
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
        await _actionLock.WaitAsync(cancellationToken);
        try
        {
            string? error;
            var warning = "";
            if (isExitOrder && leg is null) { var (result, e) = await _orders.CancelAsync(orderId, cancellationToken); error = result is null ? e ?? "no reason given" : null; }
            else
            {
                var legName = leg is "TARGET_LEG" or "STOP_LOSS_LEG" ? leg : "ENTRY_LEG";
                // Cancelling a PART-filled entry cancels the rest AND its stop-loss / target legs: what did
                // fill stays open unprotected - say so (the caller should Close it or set levels).
                SuperOrderSummary? order;
                lock (_lock) order = _currentOrders.FirstOrDefault(o => o.OrderId == orderId);
                var filled = order?.FilledQty ?? 0;
                if (legName == "ENTRY_LEG" && filled > 0)
                    warning = $" - {filled} qty of it had already filled and stays OPEN without a stop-loss or target: Close it or set its levels";
                else if (legName == "STOP_LOSS_LEG")
                    warning = " - the position no longer has a stop-loss on Dhan";
                var (result, e) = await _superOrders.CancelAsync(orderId, legName, cancellationToken);
                error = result is null ? e ?? "no reason given" : null;
            }
            RefreshUnlessStreaming();
            return error is null ? new ManualOrderResult(true, $"order {orderId} cancelled{warning}", new[] { orderId }, null) : ManualOrderResult.Fail($"Dhan did not cancel it: {error}");
        }
        finally
        {
            _actionLock.Release();
        }
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

/// <summary>TrailStartPoints / TrailGapPoints: the stop-loss leg trails the best premium TrailGapPoints behind
/// once the trade is TrailStartPoints in profit (0 gap = no trailing) - LiveTradingService.TrailStop.
/// ExitAtMs (epoch ms, 0 = none): the server closes the trade itself then (no later than 15:10 IST) -
/// LiveTradingService.SetTimeExit; ExitReason names it (e.g. "time stop").</summary>
/// <summary>NoStop: a plain LIMIT entry with no stop-loss / target legs (the panel's "No SL" box) - it stays open
/// until it is closed (or Dhan squares intraday positions off at the end of the day); a stop can still be added
/// later with Protect. StopLossPoints / TargetPoints / trailing are ignored then.</summary>
public sealed record ManualOrderRequest(
    string Underlying, DateOnly Expiry, decimal Strike, string Side, string Direction, int Lots,
    decimal SlippagePoints, decimal StopLossPoints, decimal TargetPoints, decimal TrailStartPoints = 0, decimal TrailGapPoints = 0,
    long ExitAtMs = 0, string? ExitReason = null, bool NoStop = false);

internal sealed class TrailState
{
    public decimal Start { get; set; }
    public decimal Gap { get; set; }
    public decimal Best { get; set; }
    public decimal? LastSent { get; set; }
    public DateTimeOffset LastSentAt { get; set; }
    public bool InFlight { get; set; }
}

public sealed record ManualOrderPrices(decimal Reference, decimal Limit, decimal Target, decimal StopLoss);

public sealed record ManualOrderResult(bool Success, string Message, IReadOnlyList<string> OrderIds, ManualOrderPrices? Prices)
{
    /// <summary>The contract's lot size, for an order placed (or partly placed) - what the caller's P&amp;L
    /// and loss limits must use, not a hard-coded table that NSE's lot-size revisions make stale.</summary>
    public int? LotSize { get; init; }

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
    /// <summary>Today's trade events (see LiveTradingService.TradeEventOf), oldest first.</summary>
    public IReadOnlyList<LiveTradeEvent> Events { get; init; } = Array.Empty<LiveTradeEvent>();
}

/// <summary>Something that happened to an order this app placed: Kind entry / stopLoss / target / exit /
/// rejected. Id is stable per order, leg and outcome - a page notifies each Id once.</summary>
public sealed record LiveTradeEvent(string Id, DateTimeOffset AtUtc, string Kind, string Symbol, string Title, string Text);

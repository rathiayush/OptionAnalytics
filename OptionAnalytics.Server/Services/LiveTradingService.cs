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
/// the account shows, whatever opened it. They are refreshed when Dhan's order-update socket reports
/// a change (DhanOrderUpdateFeed), after this app places or closes anything, and on a slow safety
/// timer - never polled for P&amp;L. P&amp;L moves with the live tick feed instead: every open position's
/// contract is subscribed on the shared Dhan feed, and each tick re-prices it and pushes the
/// "livePositions" snapshot to the admin-only "positions" group through the conflated batcher.
/// </summary>
public sealed class LiveTradingService : BackgroundService
{
    public const string PositionsGroup = "positions";
    private const string ProductType = "INTRADAY";
    private static readonly TimeSpan SafetyRefreshWhileOpen = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan SafetyRefreshIdle = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan QuoteWait = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan SliceCallDelay = TimeSpan.FromMilliseconds(250);
    private static readonly TimeSpan ExitCheckInterval = TimeSpan.FromSeconds(2);
    private const int MaxExitAttempts = 6;
    private static readonly string[] PendingStatuses = { "PENDING", "TRANSIT", "PART_TRADED" };

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
    private DateTimeOffset? _refreshedUtc;
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
        _orderUpdates.OrderChanged += RequestRefresh;
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    await RefreshAsync(stoppingToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.LogWarning(ex, "Live positions refresh failed.");
                }

                var anyOpen = HasOpenPositionsOrPendingOrders();
                try { await _refreshSignal.WaitAsync(anyOpen ? SafetyRefreshWhileOpen : SafetyRefreshIdle, stoppingToken); }
                catch (OperationCanceledException) { break; }
                // Coalesce a burst of order updates (entry + both legs land together) into one refresh.
                try { await Task.Delay(TimeSpan.FromMilliseconds(400), stoppingToken); }
                catch (OperationCanceledException) { break; }
            }
        }
        finally
        {
            _orderUpdates.OrderChanged -= RequestRefresh;
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

    private bool HasOpenPositionsOrPendingOrders()
    {
        lock (_lock)
            return _currentPositions.Any(p => p.IsOpen) || _currentOrders.Any(o => PendingStatuses.Contains(o.OrderStatus));
    }

    public async Task RefreshAsync(CancellationToken cancellationToken)
    {
        if (!_session.IsAuthenticated) return;
        var positions = await _positions.ListAsync(cancellationToken);
        var orders = await _superOrders.ListAsync(cancellationToken);
        var plainOrders = await _orders.ListAsync(cancellationToken);

        // Every open position's contract streams on the shared feed (Full mode, for bid/ask) - that
        // is what moves its P&L without asking Dhan's REST API.
        var toSubscribe = new Dictionary<uint, string>();
        var tracked = new HashSet<uint>();
        foreach (var position in positions.Where(p => p.IsOpen))
        {
            if (!uint.TryParse(position.SecurityId, out var id)) continue;
            tracked.Add(id);
            if (!_feed.IsSubscribed(id)) toSubscribe[id] = position.ExchangeSegment;
        }
        if (toSubscribe.Count > 0) await _feed.SubscribeAsync(toSubscribe, cancellationToken, full: true);

        lock (_lock)
        {
            _currentPositions = positions;
            _currentOrders = orders;
            _currentPlainOrders = plainOrders;
            _trackedSecurityIds = tracked;
            _refreshedUtc = DateTimeOffset.UtcNow;
        }
        Push();
    }

    private void OnTick(SpotTick tick)
    {
        bool tracked;
        lock (_lock) tracked = _trackedSecurityIds.Contains(tick.SecurityId);
        if (tracked) Push();
    }

    private void Push() => _batcher.SetLatest(PositionsGroup, "livePositions", "all", Snapshot);

    public LivePositionsSnapshot Snapshot()
    {
        IReadOnlyList<DhanPosition> positions;
        IReadOnlyList<SuperOrderSummary> orders;
        IReadOnlyList<PlainOrderSummary> plainOrders;
        DateTimeOffset? refreshed;
        lock (_lock)
        {
            positions = _currentPositions;
            orders = _currentOrders;
            plainOrders = _currentPlainOrders;
            refreshed = _refreshedUtc;
        }

        var rows = new List<LivePositionRow>(positions.Count);
        foreach (var p in positions)
        {
            decimal? ltp = uint.TryParse(p.SecurityId, out var id) && _feed.LastTickFor(id) is { LastPrice: > 0 } tick ? tick.LastPrice : null;
            var legs = orders.Where(o => o.SecurityId == p.SecurityId && o.OrderStatus is "TRADED" or "PART_TRADED").ToList();
            var target = legs.SelectMany(o => o.LegDetails).FirstOrDefault(l => l.LegName == "TARGET_LEG" && l.OrderStatus == "PENDING");
            var stopLoss = legs.SelectMany(o => o.LegDetails).FirstOrDefault(l => l.LegName == "STOP_LOSS_LEG" && l.OrderStatus == "PENDING");
            rows.Add(new LivePositionRow(
                p.SecurityId, p.TradingSymbol, p.ExchangeSegment, p.ProductType, p.PositionType, p.NetQty, p.IsOpen,
                p.NetQty > 0 ? p.BuyAvg : p.NetQty < 0 ? p.SellAvg : null, ltp,
                UnrealizedPnl(p, ltp), p.RealizedProfit,
                p.IsOpen ? target?.Price : null, p.IsOpen ? stopLoss?.Price : null));
        }

        var pending = orders
            .Where(o => PendingStatuses.Contains(o.OrderStatus))
            .Select(o => new LivePendingOrder(o.OrderId, o.SecurityId,
                uint.TryParse(o.SecurityId, out var pendingId) ? _chain.FindBySecurityId(pendingId)?.TradingSymbol ?? o.SecurityId : o.SecurityId,
                o.TransactionType, o.Quantity, o.Price, o.TargetPrice, o.StopLossPrice, o.OrderStatus) { Kind = "Entry" })
            // Working exit orders (this panel's own "OIRX-") - visible so a stuck exit is never invisible.
            .Concat(plainOrders
                .Where(o => PendingStatuses.Contains(o.OrderStatus) && o.CorrelationId?.StartsWith("OIRX-", StringComparison.Ordinal) == true)
                .Select(o => new LivePendingOrder(o.OrderId, o.SecurityId,
                    uint.TryParse(o.SecurityId, out var exitId) ? _chain.FindBySecurityId(exitId)?.TradingSymbol ?? o.SecurityId : o.SecurityId,
                    o.TransactionType, o.Quantity - o.FilledQty, o.Price, null, null, o.OrderStatus) { Kind = "Exit" }))
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
            refreshed, _orderUpdates.IsConnected, _session.IsAuthenticated, _maxLots);
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
                    RequestRefresh();
                    return ManualOrderResult.Fail(orderIds.Count == 0
                        ? $"Dhan rejected the order: {placeError}"
                        : $"placed {orderIds.Count} of {slices.Count} slices, then Dhan rejected the next: {placeError}", orderIds, prices);
                }
                orderIds.Add(result.OrderId);
            }

            _logger.LogWarning("Manual LIVE order: {Transaction} {Symbol} x{Quantity} LIMIT {Limit} (ref {Reference}), target {Target}, SL {StopLoss} - orders {Orders}.",
                transactionType, contract.TradingSymbol, quantity, prices.Limit, prices.Reference, prices.Target, prices.StopLoss, string.Join(",", orderIds));
            RequestRefresh();
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

    /// <summary>Exit all from the trade panel: cancels this panel's own unfilled entries ("OIR-" super
    /// orders) and closes every open position on the account the same careful way Close does. Unlike
    /// Dhan's account-wide DELETE /positions (EmergencyExitAllAsync) it never touches other pending
    /// orders, and every exit is a priced, chased LIMIT order.</summary>
    public async Task<ManualOrderResult> ExitAllAsync(decimal slippagePoints, CancellationToken cancellationToken)
    {
        if (!_session.IsAuthenticated) return ManualOrderResult.Fail("not logged in to Dhan right now");
        await _actionLock.WaitAsync(cancellationToken);
        try
        {
            var messages = new List<string>();
            var failures = new List<string>();
            var orderIds = new List<string>();

            foreach (var entry in (await _superOrders.ListAsync(cancellationToken))
                .Where(o => PendingStatuses.Contains(o.OrderStatus) && o.CorrelationId?.StartsWith("OIR-", StringComparison.Ordinal) == true))
            {
                var (cancelled, error) = await _superOrders.CancelAsync(entry.OrderId, "ENTRY_LEG", cancellationToken);
                if (cancelled is null) failures.Add($"could not cancel pending entry {entry.OrderId}: {error}");
                else messages.Add($"cancelled pending entry {entry.OrderId}");
            }

            var open = (await _positions.ListAsync(cancellationToken)).Where(p => p.IsOpen).ToList();
            foreach (var position in open)
            {
                var result = await CloseCoreAsync(position.SecurityId, slippagePoints, cancellationToken);
                (result.Success ? messages : failures).Add(result.Message);
                orderIds.AddRange(result.OrderIds);
            }

            RequestRefresh();
            if (open.Count == 0 && messages.Count == 0 && failures.Count == 0)
                return new ManualOrderResult(true, "nothing to exit - no open positions or pending panel orders", Array.Empty<string>(), null);
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
        RequestRefresh();
        return error is null
            ? new ManualOrderResult(true, "Dhan accepted exit-all: every position on the account is being closed and every open order cancelled", Array.Empty<string>(), null)
            : ManualOrderResult.Fail($"Dhan rejected exit-all: {error}");
    }

    private async Task<ManualOrderResult> CloseCoreAsync(string securityId, decimal slippagePoints, CancellationToken cancellationToken)
    {
        var superOrders = await _superOrders.ListAsync(cancellationToken);
        foreach (var order in superOrders.Where(o => o.SecurityId == securityId && o.OrderStatus is "TRADED" or "PART_TRADED"))
        {
            foreach (var leg in order.LegDetails.Where(l => l.LegName is "TARGET_LEG" or "STOP_LOSS_LEG" && l.OrderStatus == "PENDING"))
            {
                var (cancelled, error) = await _superOrders.CancelAsync(order.OrderId, leg.LegName, cancellationToken);
                if (cancelled is null) _logger.LogWarning("Closing {Security}: could not cancel {Leg} of {Order} - {Error}", securityId, leg.LegName, order.OrderId, error);
            }
        }

        var position = (await _positions.ListAsync(cancellationToken)).FirstOrDefault(p => p.SecurityId == securityId && p.IsOpen);
        if (position is null)
        {
            RequestRefresh();
            return new ManualOrderResult(true, "nothing left to close - the position is already flat", Array.Empty<string>(), null);
        }

        var closingIsSell = position.ClosesBySelling;
        var transactionType = closingIsSell ? "SELL" : "BUY";
        var working = (await _orders.ListAsync(cancellationToken))
            .Where(o => o.SecurityId == securityId && o.TransactionType == transactionType && PendingStatuses.Contains(o.OrderStatus))
            .Sum(o => (long)Math.Max(0, o.Quantity - o.FilledQty));
        var quantity = ExitQuantity(position.NetQty, working);
        if (quantity <= 0)
        {
            RequestRefresh();
            return new ManualOrderResult(true, $"{position.TradingSymbol}: exit orders for the whole position are already working", Array.Empty<string>(), null);
        }

        uint.TryParse(securityId, out var id);
        var contract = _chain.FindBySecurityId(id);
        var tick = contract?.TickSize is > 0 ? contract.TickSize : 0.05m;
        var price = await ExitPriceAsync(id, position.ExchangeSegment, closingIsSell, slippagePoints, tick, cancellationToken);
        if (price is null) return ManualOrderResult.Fail($"{position.TradingSymbol}: no live price - cannot price the exit");

        IReadOnlyList<int> slices = contract is null
            ? new[] { quantity }
            : StrategyTriggerHostedService.SliceQuantity(quantity, contract.LotSize, StrategyTriggerHostedService.FreezeQuantityFor(contract.Underlying));
        var orderIds = new List<string>();
        var stamp = DateTimeOffset.UtcNow.ToString("yyyyMMddHHmmss");
        for (var i = 0; i < slices.Count; i++)
        {
            if (i > 0) await Task.Delay(SliceCallDelay, cancellationToken);
            var (result, error) = await _orders.PlaceAsync(transactionType, position.ExchangeSegment, position.ProductType, "LIMIT", "DAY",
                securityId, slices[i], price.Value, $"OIRX-{stamp}-{i + 1}", cancellationToken);
            if (result is null)
            {
                RequestRefresh();
                return ManualOrderResult.Fail($"{position.TradingSymbol}: Dhan rejected the exit order: {error}", orderIds, null);
            }
            orderIds.Add(result.OrderId);
            _ = ChaseExitAsync(result.OrderId, id, position.ExchangeSegment, closingIsSell, slippagePoints, tick, position.TradingSymbol);
        }

        _logger.LogWarning("Manual LIVE exit: {Transaction} {Symbol} x{Quantity} LIMIT {Price} - orders {Orders}.",
            transactionType, position.TradingSymbol, quantity, price, string.Join(",", orderIds));
        RequestRefresh();
        return new ManualOrderResult(true, $"{transactionType} {position.TradingSymbol} x{quantity} at LIMIT {price:0.##} to close", orderIds, null);
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
                var order = (await _orders.ListAsync(CancellationToken.None)).FirstOrDefault(o => o.OrderId == orderId);
                if (order is null) continue;
                if (order.OrderStatus == "TRADED") { RequestRefresh(); return; }
                if (order.OrderStatus is "CANCELLED" or "REJECTED" or "EXPIRED")
                {
                    _logger.LogWarning("Manual exit {OrderId} ({Symbol}) ended {Status}: {Reason}", orderId, symbol, order.OrderStatus, order.OmsErrorDescription);
                    RequestRefresh();
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
            RequestRefresh();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Chasing manual exit {OrderId} ({Symbol}) failed.", orderId, symbol);
        }
    }

    /// <summary>Cancels an unfilled order: a manual entry (the whole super order) or a working exit.</summary>
    public async Task<ManualOrderResult> CancelAsync(string orderId, bool isExitOrder, CancellationToken cancellationToken)
    {
        string? error;
        if (isExitOrder) { var (result, e) = await _orders.CancelAsync(orderId, cancellationToken); error = result is null ? e ?? "no reason given" : null; }
        else { var (result, e) = await _superOrders.CancelAsync(orderId, "ENTRY_LEG", cancellationToken); error = result is null ? e ?? "no reason given" : null; }
        RequestRefresh();
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

public sealed record LivePositionRow(
    string SecurityId, string TradingSymbol, string ExchangeSegment, string ProductType, string PositionType,
    int NetQty, bool IsOpen, decimal? AvgPrice, decimal? Ltp, decimal? UnrealizedPnl, decimal RealizedPnl,
    decimal? TargetPrice, decimal? StopLossPrice);

public sealed record LivePendingOrder(
    string OrderId, string SecurityId, string TradingSymbol, string TransactionType, int Quantity, decimal Price,
    decimal? TargetPrice, decimal? StopLossPrice, string Status)
{
    /// <summary>"Entry" (an unfilled super order from the panel) or "Exit" (a working exit order).</summary>
    public string Kind { get; init; } = "Entry";
}

/// <summary>What the trade panel's Live mode shows. DayPnl = realized + unrealized across every
/// position today. OrderUpdatesConnected: whether position changes are arriving by event right now.</summary>
public sealed record LivePositionsSnapshot(
    IReadOnlyList<LivePositionRow> Positions, IReadOnlyList<LivePendingOrder> PendingOrders, IReadOnlyList<string> RecentRejections,
    decimal DayPnl, DateTimeOffset? RefreshedUtc, bool OrderUpdatesConnected, bool DhanLoggedIn, int MaxLots);

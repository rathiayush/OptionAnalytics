using System.Collections.Concurrent;
using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Services.OrderFlow;

/// <summary>
/// Runs an OrderFlowEngine for each underlying's nearest futures contract (NIFTY, BANKNIFTY, SENSEX):
/// subscribes the contract in Full mode on the shared market feed (trades + 5-level book) and on the
/// 20-level depth feed where Dhan offers it (NSE), feeds both into the engine, and pushes the live
/// view ("orderFlowLive") to the Order Flow page's "of:{underlying}" group through the conflated
/// batcher - only while someone has the page open. Re-resolves the contracts every few minutes, so a
/// futures rollover starts a fresh engine. OrderFlow:Enabled = false turns it off.
/// </summary>
public sealed class OrderFlowService : BackgroundService
{
    public static readonly string[] Underlyings = { "NIFTY", "BANKNIFTY", "SENSEX" };
    private static readonly TimeSpan ResolveInterval = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan RetryInterval = TimeSpan.FromSeconds(30);

    private readonly DhanFuturesInstrumentMaster _futures;
    private readonly DhanMarketFeedClient _feed;
    private readonly DhanDepthFeedClient _depth;
    private readonly LiveBroadcastBatcher _batcher;
    private readonly ILogger<OrderFlowService> _logger;
    private readonly bool _enabled;

    private readonly ConcurrentDictionary<string, OrderFlowEngine> _byUnderlying = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<uint, OrderFlowEngine> _bySecurityId = new();
    private IDisposable? _tickSubscription;

    public OrderFlowService(
        DhanFuturesInstrumentMaster futures, DhanMarketFeedClient feed, DhanDepthFeedClient depth, LiveBroadcastBatcher batcher,
        ILogger<OrderFlowService> logger, IConfiguration? configuration = null)
    {
        _futures = futures;
        _feed = feed;
        _depth = depth;
        _batcher = batcher;
        _logger = logger;
        _enabled = configuration?.GetValue("OrderFlow:Enabled", true) ?? true;
    }

    public static string Group(string underlying) => $"of:{underlying.ToUpperInvariant()}";

    public OrderFlowEngine? EngineFor(string underlying) => _byUnderlying.TryGetValue(underlying, out var engine) ? engine : null;

    public bool DepthFeedConnected => _depth.IsConnected;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_enabled)
        {
            _logger.LogWarning("Order flow is turned off (OrderFlow:Enabled = false).");
            return;
        }

        _tickSubscription = _feed.AddTickConsumer("Order flow", OnTick);
        _depth.DepthUpdated += OnDepth;
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                var complete = true;
                try { await _futures.EnsureLoadedAsync(stoppingToken); }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.LogWarning(ex, "Order flow: could not load the futures instrument master.");
                }

                foreach (var underlying in Underlyings)
                {
                    try { if (!await ResolveAsync(underlying, stoppingToken)) complete = false; }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        _logger.LogWarning(ex, "Order flow: setting up {Underlying} futures failed.", underlying);
                        complete = false;
                    }
                }

                try { await Task.Delay(complete ? ResolveInterval : RetryInterval, stoppingToken); }
                catch (OperationCanceledException) { break; }
            }
        }
        finally
        {
            _depth.DepthUpdated -= OnDepth;
            _tickSubscription?.Dispose();
        }
    }

    private async Task<bool> ResolveAsync(string underlying, CancellationToken cancellationToken)
    {
        var contract = _futures.GetNearestContract(underlying, IstClock.Today());
        if (contract is null) return false;

        if (!_byUnderlying.TryGetValue(underlying, out var engine) || engine.SecurityId != contract.SecurityId)
        {
            if (engine is not null) _bySecurityId.TryRemove(engine.SecurityId, out _);
            engine = new OrderFlowEngine(underlying, contract.SecurityId, contract.TradingSymbol, contract.DhanSegment, contract.TickSize, contract.LotSize);
            _bySecurityId[contract.SecurityId] = engine;
            _byUnderlying[underlying] = engine;
            _logger.LogInformation("Order flow tracking {Underlying} futures {Symbol} ({SecurityId}).", underlying, contract.TradingSymbol, contract.SecurityId);
        }

        if (!_feed.IsSubscribed(contract.SecurityId))
            await _feed.SubscribeAsync(new Dictionary<uint, string> { [contract.SecurityId] = contract.DhanSegment }, cancellationToken, full: true);
        if (_depth.Supports(contract.DhanSegment))
            await _depth.SubscribeAsync(contract.SecurityId, contract.DhanSegment, cancellationToken);
        return true;
    }

    private void OnTick(SpotTick tick)
    {
        if (!_bySecurityId.TryGetValue(tick.SecurityId, out var engine)) return;
        engine.OnTick(tick, DateTimeOffset.UtcNow);
        Push(engine);
    }

    private void OnDepth(DepthSidePacket packet)
    {
        if (!_bySecurityId.TryGetValue(packet.SecurityId, out var engine)) return;
        engine.OnDepth(packet, DateTimeOffset.UtcNow);
        Push(engine);
    }

    private void Push(OrderFlowEngine engine)
    {
        var group = Group(engine.Underlying);
        if (_batcher.HasMembers(group)) _batcher.SetLatest(group, "orderFlowLive", engine.Underlying, engine.Live);
    }
}

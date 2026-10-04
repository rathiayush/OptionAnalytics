using System.Collections.Concurrent;
using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Services.OrderFlow;

/// <summary>
/// Runs an OrderFlowEngine for each underlying's nearest futures contract (NIFTY, BANKNIFTY, SENSEX):
/// subscribes the contract in Full mode on the shared market feed (trades + 5-level book) and on the
/// deepest depth feed Dhan offers it on, feeds both into the engine, and pushes the live view
/// ("orderFlowLive") to the Order Flow page's "of:{underlying}" group and the whole book ("domLive")
/// to the DOM's "dom:{underlying}" group through the conflated batcher - only while someone is
/// watching. Re-resolves the contracts every few minutes, so a futures rollover starts a fresh engine.
///
/// DEPTH. OrderFlow:DepthMode "200" (default) puts NSE futures on Dhan's 200-level feed - one socket
/// each, at most OrderFlow:MaxTwoHundredDepth of them - and the rest (or all, with "20") on the
/// 20-level feed; "5" uses only the Full packet's 5 levels. A contract whose 200-level book has not
/// arrived within DepthFallbackAfter of subscribing (the account lacks it, or the socket keeps
/// failing) is put on the 20-level feed too, and the 20-level packets are ignored again while the
/// 200-level book streams. BSE (SENSEX) has neither and stays on 5 levels.
///
/// REPLAY. Nothing is stored on disk. Today replays straight from the live engine; when an engine
/// rolls into a new day, or is replaced at a futures rollover, its finished day goes to
/// OrderFlowDayStore in memory, so the last few days replay too - until the server restarts.
/// OrderFlow:Enabled = false turns it all off.
/// </summary>
public sealed class OrderFlowService : BackgroundService
{
    public static readonly string[] Underlyings = { "NIFTY", "BANKNIFTY", "SENSEX" };
    private static readonly TimeSpan ResolveInterval = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan RetryInterval = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan DepthFallbackAfter = TimeSpan.FromSeconds(90);

    private readonly DhanFuturesInstrumentMaster _futures;
    private readonly DhanMarketFeedClient _feed;
    private readonly DhanDepthFeedClient _depth;
    private readonly DhanTwoHundredDepthClient _fullDepth;
    private readonly LiveBroadcastBatcher _batcher;
    private readonly OrderFlowDayStore _pastDays;
    private readonly ILogger<OrderFlowService> _logger;
    private readonly bool _enabled;
    private readonly string _depthMode;

    private readonly ConcurrentDictionary<string, OrderFlowEngine> _byUnderlying = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<uint, OrderFlowEngine> _bySecurityId = new();
    private IDisposable? _tickSubscription;

    public OrderFlowService(
        DhanFuturesInstrumentMaster futures, DhanMarketFeedClient feed, DhanDepthFeedClient depth, DhanTwoHundredDepthClient fullDepth,
        LiveBroadcastBatcher batcher, OrderFlowDayStore pastDays, ILogger<OrderFlowService> logger, IConfiguration? configuration = null)
    {
        _futures = futures;
        _feed = feed;
        _depth = depth;
        _fullDepth = fullDepth;
        _batcher = batcher;
        _pastDays = pastDays;
        _logger = logger;
        _enabled = configuration?.GetValue("OrderFlow:Enabled", true) ?? true;
        _depthMode = configuration?["OrderFlow:DepthMode"]?.Trim() is { Length: > 0 } mode ? mode : "200";
    }

    public static string Group(string underlying) => $"of:{underlying.ToUpperInvariant()}";
    public static string DomGroup(string underlying) => $"dom:{underlying.ToUpperInvariant()}";

    public OrderFlowDayStore PastDays => _pastDays;

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
        _fullDepth.DepthUpdated += OnDepth;
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
            _fullDepth.DepthUpdated -= OnDepth;
            _tickSubscription?.Dispose();
        }
    }

    private async Task<bool> ResolveAsync(string underlying, CancellationToken cancellationToken)
    {
        var contract = _futures.GetNearestContract(underlying, IstClock.Today());
        if (contract is null) return false;

        if (!_byUnderlying.TryGetValue(underlying, out var engine) || engine.SecurityId != contract.SecurityId)
        {
            if (engine is not null)
            {
                _bySecurityId.TryRemove(engine.SecurityId, out _);
                _fullDepth.Unsubscribe(engine.SecurityId);
                engine.DayEnded -= _pastDays.Add;
                // The outgoing contract's day stays replayable.
                if (engine.ExportDay() is { } last) _pastDays.Add(last);
            }
            engine = new OrderFlowEngine(underlying, contract.SecurityId, contract.TradingSymbol, contract.DhanSegment, contract.TickSize, contract.LotSize);
            engine.DayEnded += _pastDays.Add;
            _bySecurityId[contract.SecurityId] = engine;
            _byUnderlying[underlying] = engine;
            _logger.LogInformation("Order flow tracking {Underlying} futures {Symbol} ({SecurityId}).", underlying, contract.TradingSymbol, contract.SecurityId);
        }

        if (!_feed.IsSubscribed(contract.SecurityId))
            await _feed.SubscribeAsync(new Dictionary<uint, string> { [contract.SecurityId] = contract.DhanSegment }, cancellationToken, full: true);

        var onFullDepth = _depthMode == "200" && _fullDepth.Subscribe(contract.SecurityId, contract.DhanSegment);
        var fullDepthFailing = onFullDepth && !_fullDepth.IsStreaming(contract.SecurityId)
            && _fullDepth.SubscribedAt(contract.SecurityId) is { } since && DateTimeOffset.UtcNow - since > DepthFallbackAfter;
        if (_depthMode != "5" && (!onFullDepth || fullDepthFailing) && _depth.Supports(contract.DhanSegment))
        {
            if (fullDepthFailing) _logger.LogWarning("Order flow: no 200-level book for {Underlying} yet - using the 20-level feed as well.", underlying);
            await _depth.SubscribeAsync(contract.SecurityId, contract.DhanSegment, cancellationToken);
        }
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
        // The 20-level fallback alongside a 200-level book that is streaming again: the deeper one wins.
        if (packet.Depth < DhanDepthPacketParser.TwoHundredLevelCount && _fullDepth.IsStreaming(packet.SecurityId)) return;
        engine.OnDepth(packet, DateTimeOffset.UtcNow);
        Push(engine);
    }

    private void Push(OrderFlowEngine engine)
    {
        var group = Group(engine.Underlying);
        if (_batcher.HasMembers(group)) _batcher.SetLatest(group, "orderFlowLive", engine.Underlying, engine.Live);
        var dom = DomGroup(engine.Underlying);
        if (_batcher.HasMembers(dom)) _batcher.SetLatest(dom, "domLive", engine.Underlying, engine.Dom);
    }
}

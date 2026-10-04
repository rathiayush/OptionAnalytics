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
/// OTHER CONTRACTS. The page can pick any listed futures contract (next month, far month): EngineForAsync
/// starts tracking it on demand - Full mode plus the 20-level depth (the 200-level sockets stay on the
/// nearest contracts) - from that moment on, keeping at most MaxExtraEngines of them. Each engine's
/// live view goes to "of:{underlying}:{expiry}"; the nearest one's also to the older "of:{underlying}".
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
    private const int MaxExtraEngines = 4;

    private readonly DhanFuturesInstrumentMaster _futures;
    private readonly NseFuturesContractArchive? _archive;
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
    // Contracts other than the nearest, tracked because the page asked for them - with when last asked.
    private readonly ConcurrentDictionary<uint, (OrderFlowEngine Engine, DateTimeOffset LastAsked)> _extra = new();
    private readonly SemaphoreSlim _extraLock = new(1, 1);
    private IDisposable? _tickSubscription;

    public OrderFlowService(
        DhanFuturesInstrumentMaster futures, DhanMarketFeedClient feed, DhanDepthFeedClient depth, DhanTwoHundredDepthClient fullDepth,
        LiveBroadcastBatcher batcher, OrderFlowDayStore pastDays, ILogger<OrderFlowService> logger, IConfiguration? configuration = null,
        NseFuturesContractArchive? archive = null)
    {
        _futures = futures;
        _archive = archive;
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
    public static string ContractGroup(string underlying, DateOnly expiry) => $"of:{underlying.ToUpperInvariant()}:{expiry:yyyy-MM-dd}";
    public static string DomGroup(string underlying) => $"dom:{underlying.ToUpperInvariant()}";

    public OrderFlowDayStore PastDays => _pastDays;

    public OrderFlowEngine? EngineFor(string underlying) => _byUnderlying.TryGetValue(underlying, out var engine) ? engine : null;

    /// <summary>The live engine already tracking this contract, if any - never starts one.</summary>
    public OrderFlowEngine? TrackedEngine(uint securityId) => _bySecurityId.TryGetValue(securityId, out var engine) ? engine : null;

    /// <summary>The futures contracts listed on <paramref name="asOf"/> (default today), nearest first. A
    /// past date comes from NSE's contract archive, so it includes contracts that have since expired.</summary>
    public async Task<IReadOnlyList<DhanFuturesInstrument>> ContractsAsync(string underlying, CancellationToken cancellationToken, DateOnly? asOf = null)
    {
        var today = IstClock.Today();
        var date = asOf ?? today;
        if (date < today && _archive is not null && NseFuturesContractArchive.Covers(underlying))
        {
            try
            {
                var past = await _archive.ContractsOnAsync(underlying, date, cancellationToken);
                if (past.Count > 0) return past;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogWarning(ex, "Order flow: NSE contract archive for {Date} could not be read.", date);
            }
        }
        await _futures.EnsureLoadedAsync(cancellationToken);
        return _futures.GetExpiries(underlying).Where(e => e >= date)
            .Select(e => _futures.GetContract(underlying, e)).OfType<DhanFuturesInstrument>().ToList();
    }

    /// <summary>The contract for an expiry (null = the front month) as listed on <paramref name="asOf"/> -
    /// for a past date that is the contract that really was the front month then, expired or not.</summary>
    public async Task<DhanFuturesInstrument?> ResolveContractAsync(string underlying, DateOnly? expiry, DateOnly asOf, CancellationToken cancellationToken)
    {
        var contracts = await ContractsAsync(underlying, cancellationToken, asOf);
        return expiry is { } e ? contracts.FirstOrDefault(c => c.Expiry == e) : contracts.FirstOrDefault();
    }

    /// <summary>The live engine for a listed contract (null expiry = the nearest), started on demand for
    /// a contract that is not tracked yet. Null when the contract is unknown or order flow is off.</summary>
    public async Task<OrderFlowEngine?> EngineForAsync(string underlying, DateOnly? expiry, CancellationToken cancellationToken)
    {
        if (!_enabled) return null;
        var nearest = EngineFor(underlying);
        if (expiry is null || nearest?.Expiry == expiry) return nearest;
        var contract = await ResolveContractAsync(underlying, expiry, IstClock.Today(), cancellationToken);
        if (contract is null) return null;
        if (_bySecurityId.TryGetValue(contract.SecurityId, out var tracked))
        {
            if (_extra.ContainsKey(contract.SecurityId)) _extra[contract.SecurityId] = (tracked, DateTimeOffset.UtcNow);
            return tracked;
        }

        await _extraLock.WaitAsync(cancellationToken);
        try
        {
            if (_bySecurityId.TryGetValue(contract.SecurityId, out tracked)) return tracked;
            while (_extra.Count >= MaxExtraEngines)
            {
                var oldest = _extra.OrderBy(kv => kv.Value.LastAsked).First();
                _extra.TryRemove(oldest.Key, out _);
                _bySecurityId.TryRemove(oldest.Key, out _);
                _depth.Unsubscribe(oldest.Key);
                oldest.Value.Engine.DayEnded -= _pastDays.Add;
                if (oldest.Value.Engine.ExportDay() is { } day) _pastDays.Add(day);
                _logger.LogInformation("Order flow: stopped tracking {Symbol} (least recently viewed).", oldest.Value.Engine.ContractSymbol);
            }
            var engine = new OrderFlowEngine(underlying.ToUpperInvariant(), contract.SecurityId, contract.TradingSymbol, contract.DhanSegment, contract.TickSize, contract.LotSize, contract.Expiry);
            engine.DayEnded += _pastDays.Add;
            _extra[contract.SecurityId] = (engine, DateTimeOffset.UtcNow);
            _bySecurityId[contract.SecurityId] = engine;
            if (!_feed.IsSubscribed(contract.SecurityId))
                await _feed.SubscribeAsync(new Dictionary<uint, string> { [contract.SecurityId] = contract.DhanSegment }, cancellationToken, full: true);
            if (_depthMode != "5" && _depth.Supports(contract.DhanSegment))
                await _depth.SubscribeAsync(contract.SecurityId, contract.DhanSegment, cancellationToken);
            _logger.LogInformation("Order flow tracking {Symbol} ({SecurityId}) on request.", contract.TradingSymbol, contract.SecurityId);
            return engine;
        }
        finally
        {
            _extraLock.Release();
        }
    }

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
                _depth.Unsubscribe(engine.SecurityId);
                engine.DayEnded -= _pastDays.Add;
                // The outgoing contract's day stays replayable.
                if (engine.ExportDay() is { } last) _pastDays.Add(last);
            }
            if (_extra.TryRemove(contract.SecurityId, out var promoted))
            {
                // A contract the page had asked for became the nearest (rollover) - keep its day.
                engine = promoted.Engine;
            }
            else
            {
                engine = new OrderFlowEngine(underlying, contract.SecurityId, contract.TradingSymbol, contract.DhanSegment, contract.TickSize, contract.LotSize, contract.Expiry);
                engine.DayEnded += _pastDays.Add;
            }
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
        if (engine.Expiry is { } expiry)
        {
            var contractGroup = ContractGroup(engine.Underlying, expiry);
            if (_batcher.HasMembers(contractGroup)) _batcher.SetLatest(contractGroup, "orderFlowLive", contractGroup, engine.Live);
        }
        if (!_byUnderlying.TryGetValue(engine.Underlying, out var nearest) || nearest != engine) return;
        var group = Group(engine.Underlying);
        if (_batcher.HasMembers(group)) _batcher.SetLatest(group, "orderFlowLive", engine.Underlying, engine.Live);
        var dom = DomGroup(engine.Underlying);
        if (_batcher.HasMembers(dom)) _batcher.SetLatest(dom, "domLive", engine.Underlying, engine.Dom);
    }
}

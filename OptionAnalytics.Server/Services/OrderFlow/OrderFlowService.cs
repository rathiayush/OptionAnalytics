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
/// TIMING. Every tick (from the market feed's own consumer queue) and every depth packet (from the depth sockets'
/// receive loops) goes into ONE inbox stamped with when it came off its socket, and one worker applies them to the
/// engines in that order: the depth sockets' receive loops never wait on an engine (a page load copying the day used to
/// hold the 200-level socket's loop), a trade is judged against the book as it had arrived by its tick (the engine's
/// QuotesAsOf), and the inbox's delay shows in the header's feed health with the market feed's consumers ("Order flow").
/// Alerts and the scanner read the engine's pushes afterwards - they may lag; the ticks are applied as they arrive.
///
/// REPLAY. Today replays straight from the live engine; when an engine rolls into a new day, or is replaced at a
/// futures rollover, its finished day goes to OrderFlowDayStore - memory and, with Storage:OrderFlowPath, DISK - so past
/// days replay exactly (imbalances and all) through a restart too. Today's recording is checkpointed to disk every
/// CheckpointInterval and at shutdown, and a new engine starts today from that checkpoint (OrderFlowEngine.ImportDay): a
/// deploy mid-session keeps the morning exact - only the minutes the server was down are missing.
/// OrderFlow:Enabled = false turns it all off.
/// </summary>
public sealed class OrderFlowService : BackgroundService
{
    public static readonly string[] Underlyings = { "NIFTY", "BANKNIFTY", "SENSEX" };
    private static readonly TimeSpan ResolveInterval = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan RetryInterval = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan DepthFallbackAfter = TimeSpan.FromSeconds(90);
    private const int MaxExtraEngines = 4;
    /// <summary>How often today's recording is written to disk (OrderFlowDayStore.Save - a background write).</summary>
    public static readonly TimeSpan CheckpointInterval = TimeSpan.FromMinutes(5);

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

    /// <summary>The inbox's bound: past it the OLDEST event goes (counted) - a book side is replaced whole by the next
    /// packet and Dhan's volume is a running total, so a dropped event loses detail, never volume. Depth packets of 200
    /// levels are ~6 KB each: 20,000 is minutes of backlog at Dhan's rate and stays far under a GB.</summary>
    public const int InboxCapacity = 20_000;

    private readonly record struct FlowEvent(SpotTick? Tick, DepthSidePacket? Depth, DateTimeOffset ReceivedAt);
    private readonly LiveEventQueue<FlowEvent> _inbox;

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
        // Started by ExecuteAsync (tests drain it themselves).
        _inbox = new LiveEventQueue<FlowEvent>("Order flow", Apply, logger, InboxCapacity, startWorker: false);
    }

    /// <summary>How the inbox is keeping up (see TickConsumerStats) - shown with the market feed's consumers.</summary>
    public TickConsumerStats InboxStats() => _inbox.GetStats();

    public override void Dispose()
    {
        _inbox.Dispose();
        base.Dispose();
    }

    public static string Group(string underlying) => $"of:{underlying.ToUpperInvariant()}";
    public static string ContractGroup(string underlying, DateOnly expiry) => $"of:{underlying.ToUpperInvariant()}:{expiry:yyyy-MM-dd}";
    public static string DomGroup(string underlying) => $"dom:{underlying.ToUpperInvariant()}";
    /// <summary>The nearest contract's delta only ("orderFlowDelta" - OrderFlowEngine.LiveDelta): OI Replay's futures delta
    /// and cumulative delta panes, live as the minutes trade (they reloaded the whole day every minute).</summary>
    public static string DeltaGroup(string underlying) => $"ofd:{underlying.ToUpperInvariant()}";

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
            var engine = NewEngine(underlying.ToUpperInvariant(), contract);
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

    /// <summary>A new engine for a contract: today's recording kept on disk (a restart / deploy) first, so it carries on
    /// from it; its finished days go to the day store.</summary>
    internal OrderFlowEngine NewEngine(string underlying, DhanFuturesInstrument contract)
    {
        var engine = new OrderFlowEngine(underlying, contract.SecurityId, contract.TradingSymbol, contract.DhanSegment, contract.TickSize, contract.LotSize, contract.Expiry);
        if (_pastDays.LoadSaved(underlying, contract.SecurityId, IstClock.Today()) is { } saved && engine.ImportDay(saved))
            _logger.LogInformation("Order flow: {Symbol} carries on from today's recording kept on disk ({Bars} minutes).", contract.TradingSymbol, saved.Bars.Count);
        engine.DayEnded += _pastDays.Add;
        return engine;
    }

    /// <summary>Today's recording of every tracked contract to disk - `now` on the caller's thread (shutdown), else on the
    /// store's background writer.</summary>
    internal void Checkpoint(bool now = false)
    {
        if (!_pastDays.OnDisk) return;
        var today = IstClock.Today();
        foreach (var engine in _bySecurityId.Values.Distinct())
        {
            if (engine.ExportDayDate() != today || engine.ExportDay() is not { } day) continue;
            if (now) _pastDays.SaveNow(day); else _pastDays.Save(day);
        }
    }

    private async Task CheckpointLoopAsync(CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(CheckpointInterval);
        try
        {
            while (await timer.WaitForNextTickAsync(cancellationToken))
                try { Checkpoint(); } catch (Exception ex) { _logger.LogWarning(ex, "Order flow: today's checkpoint failed."); }
        }
        catch (OperationCanceledException) { }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await base.StopAsync(cancellationToken);
        // A deploy / restart: today so far to disk, so the next start carries on from it.
        try { Checkpoint(now: true); } catch (Exception ex) { _logger.LogWarning(ex, "Order flow: the shutdown checkpoint failed."); }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Background work: its Dhan calls are not sent outside market hours (MarketHours).
        using var background = MarketHours.BackgroundScope();
        if (!_enabled)
        {
            _logger.LogWarning("Order flow is turned off (OrderFlow:Enabled = false).");
            return;
        }

        _inbox.Start();
        _tickSubscription = _feed.AddTickConsumer("Order flow ticks", OnTick);
        _depth.DepthUpdated += OnDepth;
        _fullDepth.DepthUpdated += OnDepth;
        var feedStatus = RefreshDepthFeedsAsync(stoppingToken);
        var checkpoints = CheckpointLoopAsync(stoppingToken);
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
            try { await feedStatus; } catch (OperationCanceledException) { }
            try { await checkpoints; } catch (OperationCanceledException) { }
        }
    }

    // Every few seconds: each tracked contract's depth connection state onto its engine (and pushed when
    // it changed), so the page says "200-level connected, waiting for the book" on a closed market - when
    // no tick arrives to carry it - or what Dhan answered when the connection fails.
    private async Task RefreshDepthFeedsAsync(CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
        try
        {
            while (await timer.WaitForNextTickAsync(cancellationToken))
            {
                foreach (var engine in _bySecurityId.Values)
                {
                    var feed = DepthFeedFor(engine.SecurityId, engine.ExchangeSegment);
                    var before = engine.DepthFeed;
                    if (before is not null && before.Levels == feed.Levels && before.Connected == feed.Connected && before.Note == feed.Note
                        && (before.LastBookAt is null) == (feed.LastBookAt is null)) { engine.DepthFeed = feed; continue; }
                    engine.DepthFeed = feed;
                    Push(engine);
                }
            }
        }
        catch (OperationCanceledException) { }
    }

    /// <summary>The depth connection a contract is on, as the page shows it.</summary>
    internal OrderFlowDepthFeed DepthFeedFor(uint securityId, string segment)
    {
        if (!segment.StartsWith("NSE_", StringComparison.OrdinalIgnoreCase))
            return new OrderFlowDepthFeed(5, true, null, "Dhan's 20- and 200-level depth covers NSE only - BSE contracts have the 5 levels of the market feed.");
        if (_depthMode == "5")
            return new OrderFlowDepthFeed(5, true, null, "Deeper depth is turned off (OrderFlow:DepthMode = 5).");
        var full = _fullDepth.Status(securityId);
        var onTwenty = _depth.IsSubscribed(securityId);
        if (full is not null && (full.Connected || !onTwenty))
            return new OrderFlowDepthFeed(200, full.Connected, full.LastBookAt, full.LastError is { } e ? $"200-level: {e}" : null);
        if (onTwenty)
        {
            var twenty = _depth.Status();
            var why = full is not null
                ? $"200-level not streaming{(full.LastError is { } fe ? $" ({fe})" : "")} - on the 20-level feed meanwhile."
                : _depthMode == "200" ? "All 200-level connections are in use (Dhan allows 5 sockets per account) - on the 20-level feed." : null;
            return new OrderFlowDepthFeed(20, twenty.Connected, twenty.LastBookAt, twenty.LastError is { } te ? $"{why} 20-level: {te}".Trim() : why);
        }
        return new OrderFlowDepthFeed(5, true, null, "No depth connection for this contract.");
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
                engine = NewEngine(underlying, contract);
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

    // On the market feed consumer's worker: into the inbox, stamped when it came off the socket.
    internal void OnTick(SpotTick tick)
    {
        if (!_bySecurityId.ContainsKey(tick.SecurityId)) return;
        _inbox.Enqueue(new FlowEvent(tick, null, tick.ReceivedAt ?? DateTimeOffset.UtcNow));
    }

    // On a depth socket's receive loop: stamped now, into the inbox - nothing else, it must never wait.
    internal void OnDepth(DepthSidePacket packet)
    {
        if (!_bySecurityId.ContainsKey(packet.SecurityId)) return;
        // The 20-level fallback alongside a 200-level book that is streaming again: the deeper one wins.
        if (packet.Depth < DhanDepthPacketParser.TwoHundredLevelCount && _fullDepth.IsStreaming(packet.SecurityId)) return;
        _inbox.Enqueue(new FlowEvent(null, packet, DateTimeOffset.UtcNow));
    }

    // The inbox's worker: one event into its engine, then the live view marked for the next push.
    private void Apply(FlowEvent e)
    {
        var securityId = e.Tick?.SecurityId ?? e.Depth?.SecurityId;
        if (securityId is null || !_bySecurityId.TryGetValue(securityId.Value, out var engine)) return;
        if (e.Tick is { } tick) engine.OnTick(tick, e.ReceivedAt);
        else if (e.Depth is { } depth) engine.OnDepth(depth, e.ReceivedAt);
        Push(engine);
    }

    /// <summary>Tests: applies everything in the inbox on the calling thread.</summary>
    internal void DrainInbox() => _inbox.Drain();

    /// <summary>Tests: tracks <paramref name="engine"/> as its contract's nearest engine.</summary>
    internal void TrackForTests(OrderFlowEngine engine)
    {
        _bySecurityId[engine.SecurityId] = engine;
        _byUnderlying[engine.Underlying] = engine;
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
        var delta = DeltaGroup(engine.Underlying);
        if (_batcher.HasMembers(delta)) _batcher.SetLatest(delta, "orderFlowDelta", engine.Underlying, engine.LiveDelta);
    }
}

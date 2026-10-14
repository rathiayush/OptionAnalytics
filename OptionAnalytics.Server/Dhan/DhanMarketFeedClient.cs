using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// Owns the single live connection to Dhan's market feed (wss://api-feed.dhan.co), decodes the
/// binary packets, and hands each update to every tick consumer (AddTickConsumer) - each on its own
/// queue and worker, never on this receive loop (see TickConsumerQueue). Reconnects with exponential backoff
/// and re-subscribes everything on every reconnect. Run as its own hosted service
/// (DhanMarketFeedHostedService owns the RunAsync loop); SpotFeedHostedService and
/// CdvHostedService both subscribe/unsubscribe tokens on this same shared instance rather than
/// each owning a connection - Dhan allows only a handful of concurrent connections per account.
///
/// A smaller cousin of LiveSpreadCalculator's DhanMarketFeedClient: no order-update socket, no
/// instrument-master-driven segment lookup (callers already know each token's segment), just
/// connect, track a subscribed-token set that can change at runtime, and stream. See that file for
/// the full protocol writeup this is ported from.
/// </summary>
public sealed class DhanMarketFeedClient : IAsyncDisposable
{
    // Quote (17) is the default - an index (IDX_I - NIFTY/BANKNIFTY's spot tokens) has no order
    // book at all, so Dhan may not stream Full-mode data for those tokens the way it does for a
    // tradeable instrument, and subscribing everything in Full mode risked spot ticks simply never
    // arriving. Full (21) IS used for option strikes specifically (see SubscribeAsync's `full`
    // parameter and CdvHostedService, the only caller that passes it) - those have a real order
    // book, and StrategyTriggerHostedService re-prices a live order retry off the best bid/ask Full
    // carries (see DhanTickPacketParser), which Quote does not. Each token remembers which mode it
    // was subscribed in (see _tokenSegments) so a reconnect/re-subscribe always asks Dhan for
    // exactly the same mode per instrument rather than silently downgrading everything to Quote.
    private const int RequestCodeQuote = 17;
    private const int RequestCodeUnsubscribeQuote = 18;
    private const int RequestCodeFull = 21;
    private const int RequestCodeUnsubscribeFull = 22;
    private const int RequestCodeDisconnect = 12;
    private const int SubscriptionBatchSize = 100;

    /// <summary>Dhan's documented per-connection instrument limit. Nowhere near it today (~170 with
    /// every tracked expiry subscribed), but the count is no longer fixed - it scales with how many
    /// expiries are tracked - so crossing it should say so rather than show up as a handful of
    /// strikes that mysteriously never tick. Dhan rejects the surplus with error 804 and the
    /// instruments simply stay silent.</summary>
    private const int MaxInstrumentsPerConnection = 5000;

    private static readonly TimeSpan InterBatchDelay = TimeSpan.FromMilliseconds(50);

    private readonly DhanOptions _options;
    private readonly DhanSession _session;
    private readonly ILogger<DhanMarketFeedClient> _logger;

    private readonly ConcurrentDictionary<uint, (string Segment, int SubscribeCode)> _tokenSegments = new();
    private readonly ConcurrentDictionary<uint, SpotTick> _lastTick = new();
    private readonly SemaphoreSlim _sendLock = new(1, 1);

    private ClientWebSocket? _socket;

    /// <summary>Decides whether a quiet feed needs a re-subscribe or a reconnect - see
    /// FeedStallDetector for why those are different answers, and why always reconnecting (what
    /// this used to do) manufactures Dhan's own 805 connection-limit failure.</summary>
    private readonly FeedStallDetector _stall = new();

    private int _lastDisconnectCode;

    // Announced once per security id per connection, so it's obvious from the console alone
    // which subscribed instruments are actually ticking and which are silent - the exact
    // question "what is ATM and what strikes are you tracking, and are they actually live" needs
    // answered together.
    private readonly ConcurrentDictionary<uint, byte> _loggedFirstTick = new();

    // Copy-on-write so the receive loop reads it without a lock.
    private volatile TickConsumerQueue[] _consumers = Array.Empty<TickConsumerQueue>();
    private readonly object _consumersLock = new();

    /// <summary>Delivers every tick to <paramref name="handler"/> on its own worker, in order - see
    /// TickConsumerQueue for why consumers no longer run on the receive loop. Dispose the result to
    /// stop.</summary>
    public IDisposable AddTickConsumer(string name, Action<SpotTick> handler)
    {
        var consumer = new TickConsumerQueue(name, handler, _logger);
        lock (_consumersLock) _consumers = _consumers.Append(consumer).ToArray();
        return new ConsumerRegistration(this, consumer);
    }

    /// <summary>How each tick consumer is keeping up - see TickConsumerStats.</summary>
    public IReadOnlyList<TickConsumerStats> GetConsumerStats() => _consumers.Select(c => c.GetStats()).ToList();

    private void RemoveConsumer(TickConsumerQueue consumer)
    {
        lock (_consumersLock) _consumers = _consumers.Where(c => c != consumer).ToArray();
        consumer.Dispose();
    }

    private sealed class ConsumerRegistration(DhanMarketFeedClient client, TickConsumerQueue consumer) : IDisposable
    {
        private int _disposed;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0) client.RemoveConsumer(consumer);
        }
    }

    public DhanMarketFeedClient(IOptions<DhanOptions> options, DhanSession session, ILogger<DhanMarketFeedClient> logger)
    {
        _options = options.Value;
        _session = session;
        _logger = logger;
    }

    /// <summary>The most recent tick this client holds for one instrument, or null if it has never
    /// ticked on this connection. Read by the contracts page: "subscribed but no tick" is the exact
    /// state that used to be invisible, and it is what distinguishes a feed problem from a scrip
    /// master problem.</summary>
    public SpotTick? LastTickFor(uint securityId) => _lastTick.TryGetValue(securityId, out var tick) ? tick : null;

    /// <summary>Tests only: makes <paramref name="tick"/> the latest one for its instrument.</summary>
    internal void SetLastTickForTesting(SpotTick tick) => _lastTick[tick.SecurityId] = tick;

    /// <summary>Whether this token is in the subscribed set right now.</summary>
    public bool IsSubscribed(uint securityId) => _tokenSegments.ContainsKey(securityId);

    /// <summary>Re-sends a subscribe message for exactly the given, already-tracked tokens -
    /// unlike SubscribeAsync (a no-op for a token already in the set, by design - see its own doc
    /// comment), this bypasses that check and asks Dhan again regardless. For a caller
    /// (SpotFeedHostedService) that suspects Dhan silently dropped just ITS OWN handful of tokens
    /// while the connection as a whole keeps delivering other instruments perfectly normally: the
    /// shared stall watchdog (FeedStallDetector) only judges the connection as a whole - ANY
    /// message, from ANY instrument, counts as "alive" (see its own doc comment) - so it never
    /// notices one specific instrument having gone silent on its own. Silently does nothing for a
    /// token this client isn't actually tracking (never subscribed, or already unsubscribed).</summary>
    public async Task ResendSubscriptionsForAsync(IEnumerable<uint> securityIds, CancellationToken cancellationToken)
    {
        if (_socket is not { State: WebSocketState.Open }) return;

        var tokens = new List<KeyValuePair<uint, (string Segment, int SubscribeCode)>>();
        foreach (var id in securityIds)
            if (_tokenSegments.TryGetValue(id, out var entry))
                tokens.Add(new(id, entry));

        if (tokens.Count > 0) await ResendSubscriptionsAsync(tokens, cancellationToken);
    }

    /// <summary>How many instruments are subscribed in total, across every underlying and
    /// expiry.</summary>
    public int SubscribedCount => _tokenSegments.Count;

    /// <summary>Adds tokens to the subscribed set (each mapped to its Dhan WS segment string, e.g.
    /// "IDX_I" or "NSE_FNO") and, if already connected, sends a live subscribe message for the new
    /// ones immediately. Safe to call before the connection exists - RunAsync subscribes the whole
    /// set on every (re)connect regardless.
    ///
    /// The set is FLAT across every underlying and every tracked expiry: a contract's token is
    /// unique per (strike, side, expiry), so several expiries' ATM+-8 windows coexist here without
    /// colliding, and one expiry's window rolling never unsubscribes another's. Everything in here
    /// is re-sent on every reconnect and by the stall watchdog's re-subscribe, so a subscribe that
    /// failed mid-flight repairs itself rather than leaving that expiry permanently silent.</summary>
    /// <summary><paramref name="full"/> selects Full mode (best bid/ask depth included - see
    /// DhanTickPacketParser) instead of the default Quote mode. Pass true only for instruments with
    /// a real order book (option strikes - see CdvHostedService, the only caller that does); the
    /// spot/index token must stay on the default Quote, per this class's own doc comment.</summary>
    public async Task SubscribeAsync(IReadOnlyDictionary<uint, string> tokens, CancellationToken cancellationToken, bool full = false)
    {
        var subscribeCode = full ? RequestCodeFull : RequestCodeQuote;

        var added = new List<KeyValuePair<uint, string>>();
        foreach (var kv in tokens)
        {
            if (_tokenSegments.TryAdd(kv.Key, (kv.Value, subscribeCode))) added.Add(kv);
        }

        if (added.Count == 0) return;

        _logger.LogInformation("Subscribing {Count} instrument(s) in {Mode} mode ({Total} subscribed in total): {Instruments}.",
            added.Count, full ? "Full" : "Quote", _tokenSegments.Count, string.Join(", ", added.Select(kv => $"{kv.Key}({kv.Value})")));

        if (_tokenSegments.Count > MaxInstrumentsPerConnection)
        {
            _logger.LogError(
                "Dhan market feed now has {Count} instruments subscribed, past the {Limit} this connection allows. " +
                "Dhan will reject the surplus (error 804) and those instruments will never tick - reduce the tracked expiries or the strike window.",
                _tokenSegments.Count, MaxInstrumentsPerConnection);
        }

        if (_socket is not { State: WebSocketState.Open }) return;
        await SendSubscriptionAsync(added.Select(kv => (kv.Key, kv.Value)), subscribeCode, cancellationToken);
    }

    /// <summary>Removes tokens from the subscribed set and, if connected, sends a live unsubscribe
    /// message - used when the ATM window rolls and strikes fall out of range. Grouped by however
    /// each token was originally subscribed (Quote vs Full - see SubscribeAsync) since Dhan's
    /// unsubscribe request code has to match the subscribe mode it is undoing.</summary>
    public async Task UnsubscribeAsync(IEnumerable<uint> tokens, CancellationToken cancellationToken)
    {
        var removed = new List<(uint Token, string Segment, int SubscribeCode)>();
        foreach (var token in tokens)
        {
            if (_tokenSegments.TryRemove(token, out var entry)) removed.Add((token, entry.Segment, entry.SubscribeCode));
            _lastTick.TryRemove(token, out _);
        }

        if (removed.Count == 0 || _socket is not { State: WebSocketState.Open }) return;

        foreach (var group in removed.GroupBy(r => r.SubscribeCode))
        {
            var unsubscribeCode = group.Key == RequestCodeFull ? RequestCodeUnsubscribeFull : RequestCodeUnsubscribeQuote;
            await SendSubscriptionAsync(group.Select(r => (r.Token, r.Segment)), unsubscribeCode, cancellationToken);
        }
    }

    /// <summary>Runs until cancelled, connecting/reconnecting as needed and (re)subscribing
    /// whatever is currently in the subscribed set on every connect.</summary>
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        var backoff = TimeSpan.FromSeconds(1);
        var loggedAwaitingSession = false;

        while (!cancellationToken.IsCancellationRequested)
        {
            if (!_session.IsAuthenticated)
            {
                if (!loggedAwaitingSession)
                {
                    _logger.LogInformation("Dhan market feed is waiting for Dhan credentials before connecting.");
                    loggedAwaitingSession = true;
                }
                if (!await DelayAsync(TimeSpan.FromSeconds(3), cancellationToken)) break;
                continue;
            }
            loggedAwaitingSession = false;

            try
            {
                await ConnectAndSubscribeAsync(cancellationToken);
                var connectedAt = DateTimeOffset.UtcNow;

                using var stallCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                var watchdog = WatchForStallAsync(_socket!, stallCts.Token);
                string endedReason;
                try
                {
                    endedReason = await ReceiveLoopAsync(cancellationToken);
                }
                finally
                {
                    stallCts.Cancel();
                    await SafeAwaitAsync(watchdog);
                }

                var uptime = DateTimeOffset.UtcNow - connectedAt;
                var cooldown = CooldownFor(_lastDisconnectCode);
                _lastDisconnectCode = 0;
                // Reset to the floor only for a connection that actually HELD - see
                // FeedStallDetector.StableConnectionThreshold for why "it connected" is not enough.
                backoff = cooldown ?? (uptime >= FeedStallDetector.StableConnectionThreshold
                    ? TimeSpan.FromSeconds(1)
                    : TimeSpan.FromSeconds(Math.Min(backoff.TotalSeconds * 2, 30)));

                _logger.LogWarning("Dhan market feed disconnected after {Uptime:F0}s - {Reason}. Reconnecting in {Seconds}s.", uptime.TotalSeconds, endedReason, backoff.TotalSeconds);
                if (!await DelayAsync(backoff, cancellationToken)) break;
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Dhan market feed connection lost, retrying in {Seconds}s", backoff.TotalSeconds);
                if (!await DelayAsync(backoff, cancellationToken)) break;
                backoff = TimeSpan.FromSeconds(Math.Min(backoff.TotalSeconds * 2, 30));
            }
        }
    }

    private static TimeSpan? CooldownFor(int disconnectCode) => disconnectCode switch
    {
        805 => TimeSpan.FromMinutes(2),
        804 => TimeSpan.FromMinutes(1),
        _ => null,
    };

    /// <summary>Watches a live connection and applies FeedStallDetector's verdict. The important
    /// change from what this did before: a silent connection is RE-SUBSCRIBED, not aborted. Only a
    /// connection that had been delivering and stayed silent through a re-subscribe is torn down.
    /// Aborting a quiet socket opens a fresh one every time, and Dhan drops the oldest with 805
    /// once five are open - so the old watchdog turned "the market is quiet" into "the feed keeps
    /// getting disconnected".</summary>
    private async Task WatchForStallAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            if (!await DelayAsync(FeedStallDetector.CheckInterval, cancellationToken)) return;
            if (socket.State != WebSocketState.Open) return;

            var tokens = _tokenSegments.ToArray();
            switch (_stall.Decide(DateTimeOffset.UtcNow, tokens.Length > 0))
            {
                case FeedRecoveryAction.None:
                    break;

                case FeedRecoveryAction.Resubscribe:
                    _logger.LogWarning(
                        "Dhan market feed has sent nothing with {Count} instrument(s) subscribed - re-sending the subscriptions on the same connection.",
                        tokens.Length);
                    try
                    {
                        await ResendSubscriptionsAsync(tokens, cancellationToken);
                    }
                    catch (Exception ex)
                    {
                        // A send failure here IS the diagnosis - the socket is gone. Let the receive
                        // loop notice rather than tearing things down from this task.
                        _logger.LogWarning(ex, "Dhan market feed re-subscribe failed - the connection is no longer usable.");
                        try { socket.Abort(); } catch { /* the receive loop's exception is what matters */ }
                        return;
                    }
                    break;

                case FeedRecoveryAction.Reconnect:
                    _logger.LogWarning(
                        "Dhan market feed still silent after a re-subscribe, having previously been live - treating it as a silently dropped connection and reconnecting.");
                    try { socket.Abort(); } catch { /* the receive loop's exception is what matters */ }
                    return;
            }
        }
    }

    private async Task ConnectAndSubscribeAsync(CancellationToken cancellationToken)
    {
        _socket?.Dispose();
        _socket = new ClientWebSocket();
        _socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
        _stall.OnConnected(DateTimeOffset.UtcNow);
        _loggedFirstTick.Clear();

        var accessToken = _session.AccessToken ?? throw new InvalidOperationException("No Dhan access token configured.");
        var clientId = _session.ClientId ?? throw new InvalidOperationException("No Dhan client id configured.");

        var uri = new Uri($"{_options.WsUrl}?version=2&token={Uri.EscapeDataString(accessToken)}&clientId={Uri.EscapeDataString(clientId)}&authType=2");
        await _socket.ConnectAsync(uri, cancellationToken);

        var tokens = _tokenSegments.ToArray();
        _logger.LogInformation("Connected to Dhan market feed ({Count} instruments).", tokens.Length);

        await ResendSubscriptionsAsync(tokens, cancellationToken);
    }

    /// <summary>Re-sends a subscribe message for every currently-tracked token, one message per
    /// distinct mode present - each token asks for exactly the mode it is already recorded under
    /// (SubscribeCode), never downgraded to Quote just because it's being grouped with others.
    /// Shared by the reconnect path (ConnectAndSubscribeAsync) and the stall-watchdog's re-subscribe
    /// (WatchForStallAsync), which both need to ask Dhan for the identical current subscribed set on
    /// the same connection - nothing about who wants which mode has changed in either case, only
    /// that Dhan needs telling again.</summary>
    private async Task ResendSubscriptionsAsync(
        IEnumerable<KeyValuePair<uint, (string Segment, int SubscribeCode)>> tokens, CancellationToken cancellationToken)
    {
        foreach (var group in tokens.GroupBy(kv => kv.Value.SubscribeCode))
            await SendSubscriptionAsync(group.Select(kv => (kv.Key, kv.Value.Segment)), group.Key, cancellationToken);
    }

    private async Task SendSubscriptionAsync(IEnumerable<(uint Token, string Segment)> entries, int requestCode, CancellationToken cancellationToken)
    {
        var isFirst = true;
        foreach (var batch in entries.Chunk(SubscriptionBatchSize))
        {
            if (batch.Length == 0) continue;
            if (!isFirst && !await DelayAsync(InterBatchDelay, cancellationToken)) return;
            isFirst = false;

            await SendAsync(new
            {
                RequestCode = requestCode,
                InstrumentCount = batch.Length,
                InstrumentList = batch.Select(e => new { ExchangeSegment = e.Segment, SecurityId = e.Token.ToString() }).ToArray(),
            }, cancellationToken);
        }
    }

    private async Task<string> ReceiveLoopAsync(CancellationToken cancellationToken)
    {
        var buffer = new byte[16 * 1024];
        using var messageStream = new MemoryStream();

        while (_socket!.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
        {
            messageStream.SetLength(0);
            WebSocketReceiveResult result;

            do
            {
                result = await _socket.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken);

                var now = DateTimeOffset.UtcNow;
                if (_stall.OnMessage(now))
                {
                    // Its ABSENCE is the most useful fact when nothing is ticking: if this line
                    // never appears, the socket is connected but Dhan is sending literally
                    // nothing back - the problem is upstream of parsing (auth, subscription
                    // acceptance, or the market simply being closed), not this client's decoding.
                    _logger.LogInformation("Dhan market feed delivered its first data {Seconds:F1}s after connecting.", _stall.TimeSinceConnected(now).TotalSeconds);
                }

                if (result.MessageType == WebSocketMessageType.Close)
                {
                    var status = result.CloseStatus?.ToString() ?? "no status";
                    var description = string.IsNullOrWhiteSpace(result.CloseStatusDescription) ? "no description" : result.CloseStatusDescription;
                    await _socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "server closed", cancellationToken);
                    return $"the server closed the connection ({status}: {description})";
                }
                messageStream.Write(buffer, 0, result.Count);
            } while (!result.EndOfMessage);

            if (result.MessageType != WebSocketMessageType.Binary) continue;

            var packets = DhanTickPacketParser.ParseMessage(messageStream.GetBuffer().AsSpan(0, (int)messageStream.Length));
            foreach (var packet in packets)
                HandlePacket(packet);
        }

        return cancellationToken.IsCancellationRequested ? "shutting down" : $"the socket stopped being open (state {_socket!.State})";
    }

    private void HandlePacket(DhanPacket packet)
    {
        if (packet.Kind == DhanPacketKind.Disconnect)
        {
            _lastDisconnectCode = packet.DisconnectCode;
            _logger.LogWarning("Dhan market feed sent a disconnect packet (code {Code}): {Reason}.", packet.DisconnectCode, DhanSymbology.DescribeFeedErrorCode(packet.DisconnectCode));

            // Codes 807-810 mean this token/client-id will never work again - clear it so
            // DhanTotpAutoRenewalHostedService mints a fresh one immediately instead of the feed
            // retrying forever against dead credentials (a no-op when TOTP auto-login isn't
            // configured).
            if (DhanSymbology.IsSessionInvalidCode(packet.DisconnectCode))
                _session.ClearAccessToken();

            return;
        }

        if (packet.Kind is DhanPacketKind.MarketStatus or DhanPacketKind.Unknown or DhanPacketKind.OpenInterest)
            return;

        // Only cache/report instruments we still want - a packet already in flight for an
        // instrument UnsubscribeAsync just dropped must not resurrect a cache entry for it (same
        // leak LiveSpreadCalculator's DhanMarketFeedClient guards against).
        if (!_tokenSegments.TryGetValue(packet.SecurityId, out var entry)) return;

        if (packet.LastPrice > 0 && _loggedFirstTick.TryAdd(packet.SecurityId, 0))
            _logger.LogInformation("First tick for security {SecurityId} ({Segment}): price={Price}.", packet.SecurityId, entry.Segment, packet.LastPrice);

        var previous = _lastTick.TryGetValue(packet.SecurityId, out var existing) ? existing : null;
        var tick = new SpotTick(
            SecurityId: packet.SecurityId,
            LastPrice: packet.LastPrice > 0 ? packet.LastPrice : previous?.LastPrice ?? 0,
            Open: packet.Open > 0 ? packet.Open : previous?.Open ?? 0,
            High: packet.High > 0 ? packet.High : previous?.High ?? 0,
            Low: packet.Low > 0 ? packet.Low : previous?.Low ?? 0,
            Close: packet.Close > 0 ? packet.Close : previous?.Close ?? 0,
            Volume: packet.Volume > 0 ? packet.Volume : previous?.Volume ?? 0,
            // Only Full-mode packets (option strikes) ever carry these - a Quote-mode instrument
            // (the spot/index token) keeps them at 0 forever, which callers must treat as "no live
            // depth" rather than a real zero price.
            BestBidPrice: packet.BestBidPrice > 0 ? packet.BestBidPrice : previous?.BestBidPrice ?? 0,
            BestAskPrice: packet.BestAskPrice > 0 ? packet.BestAskPrice : previous?.BestAskPrice ?? 0,
            // Also only ever populated by a Full-mode packet - see BestBidPrice/BestAskPrice's own
            // comment just above, same reasoning.
            OpenInterest: packet.OpenInterest > 0 ? packet.OpenInterest : previous?.OpenInterest ?? 0,
            ExchangeTimestamp: packet.ExchangeTimestamp)
        {
            LastTradedQty = packet.LastTradedQty,
            TotalBuyQty = packet.TotalBuyQty > 0 ? packet.TotalBuyQty : previous?.TotalBuyQty ?? 0,
            TotalSellQty = packet.TotalSellQty > 0 ? packet.TotalSellQty : previous?.TotalSellQty ?? 0,
            Bids = packet.Bids ?? previous?.Bids,
            Asks = packet.Asks ?? previous?.Asks,
        };

        _lastTick[packet.SecurityId] = tick;
        if (tick.LastPrice <= 0) return;
        foreach (var consumer in _consumers) consumer.Enqueue(tick);
    }

    private async Task SendAsync(object message, CancellationToken cancellationToken)
    {
        if (_socket is not { State: WebSocketState.Open }) return;
        var bytes = JsonSerializer.SerializeToUtf8Bytes(message);

        await _sendLock.WaitAsync(cancellationToken);
        try
        {
            await _socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, cancellationToken);
        }
        finally
        {
            _sendLock.Release();
        }
    }

    private static async Task<bool> DelayAsync(TimeSpan delay, CancellationToken cancellationToken)
    {
        try { await Task.Delay(delay, cancellationToken); return true; }
        catch (OperationCanceledException) { return false; }
    }

    private static async Task SafeAwaitAsync(Task task)
    {
        try { await task; }
        catch (OperationCanceledException) { }
        catch { }
    }

    public async ValueTask DisposeAsync()
    {
        if (_socket is { State: WebSocketState.Open })
        {
            try
            {
                await SendAsync(new { RequestCode = RequestCodeDisconnect }, CancellationToken.None);
                await _socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "disposing", CancellationToken.None);
            }
            catch { /* best-effort close */ }
        }
        _socket?.Dispose();
        foreach (var consumer in _consumers) consumer.Dispose();
    }
}

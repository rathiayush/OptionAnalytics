using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// Owns the single live connection to Dhan's market feed (wss://api-feed.dhan.co), decodes the
/// binary packets, and raises TickReceived for each update. Reconnects with exponential backoff
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
    // Quote (17), not Full (21): Full carries 5-level market depth (best bid/ask), which this app
    // never reads - SpotTick only has LastPrice/OHLC/Volume, all of which Quote already carries.
    // More importantly, an index (IDX_I - NIFTY/BANKNIFTY's spot tokens) has no order book at all,
    // so Dhan may not stream Full-mode data for those tokens the way it does for a tradeable
    // instrument - subscribing everything in Full mode risked spot ticks simply never arriving.
    // Quote is the mode every instrument type here is expected to support.
    private const int RequestCodeQuote = 17;
    private const int RequestCodeUnsubscribeQuote = 18;
    private const int RequestCodeDisconnect = 12;
    private const int SubscriptionBatchSize = 100;

    // If the socket has been open this long with zero data, it is treated as silently dead and
    // reconnected - Dhan authorizes a connection asynchronously after the handshake, so a
    // subscription sent too early can simply be ignored with no error.
    private static readonly TimeSpan StallTimeout = TimeSpan.FromSeconds(45);
    private static readonly TimeSpan StallCheckInterval = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan InterBatchDelay = TimeSpan.FromMilliseconds(50);

    private readonly DhanOptions _options;
    private readonly DhanSession _session;
    private readonly ILogger<DhanMarketFeedClient> _logger;

    private readonly ConcurrentDictionary<uint, string> _tokenSegments = new();
    private readonly ConcurrentDictionary<uint, SpotTick> _lastTick = new();
    private readonly SemaphoreSlim _sendLock = new(1, 1);

    private ClientWebSocket? _socket;
    private DateTimeOffset _lastMessageAt = DateTimeOffset.MinValue;
    private DateTimeOffset _connectedAt = DateTimeOffset.MinValue;
    private int _lastDisconnectCode;
    private bool _loggedFirstMessage;

    // Announced once per security id per connection, so it's obvious from the console alone
    // which subscribed instruments are actually ticking and which are silent - the exact
    // question "what is ATM and what strikes are you tracking, and are they actually live" needs
    // answered together.
    private readonly ConcurrentDictionary<uint, byte> _loggedFirstTick = new();

    public event Action<SpotTick>? TickReceived;

    public DhanMarketFeedClient(IOptions<DhanOptions> options, DhanSession session, ILogger<DhanMarketFeedClient> logger)
    {
        _options = options.Value;
        _session = session;
        _logger = logger;
    }

    /// <summary>Adds tokens to the subscribed set (each mapped to its Dhan WS segment string, e.g.
    /// "IDX_I" or "NSE_FNO") and, if already connected, sends a live subscribe message for the new
    /// ones immediately. Safe to call before the connection exists - RunAsync subscribes the whole
    /// set on every (re)connect regardless.</summary>
    public async Task SubscribeAsync(IReadOnlyDictionary<uint, string> tokens, CancellationToken cancellationToken)
    {
        var added = new List<KeyValuePair<uint, string>>();
        foreach (var kv in tokens)
        {
            if (_tokenSegments.TryAdd(kv.Key, kv.Value)) added.Add(kv);
        }

        if (added.Count == 0) return;

        _logger.LogInformation("Subscribing {Count} instrument(s) in Quote mode: {Instruments}.",
            added.Count, string.Join(", ", added.Select(kv => $"{kv.Key}({kv.Value})")));

        if (_socket is not { State: WebSocketState.Open }) return;
        await SendSubscriptionAsync(added.Select(kv => (kv.Key, kv.Value)), RequestCodeQuote, cancellationToken);
    }

    /// <summary>Removes tokens from the subscribed set and, if connected, sends a live unsubscribe
    /// message - used when the ATM window rolls and strikes fall out of range.</summary>
    public async Task UnsubscribeAsync(IEnumerable<uint> tokens, CancellationToken cancellationToken)
    {
        var removed = new List<(uint Token, string Segment)>();
        foreach (var token in tokens)
        {
            if (_tokenSegments.TryRemove(token, out var segment)) removed.Add((token, segment));
            _lastTick.TryRemove(token, out _);
        }

        if (removed.Count == 0 || _socket is not { State: WebSocketState.Open }) return;
        await SendSubscriptionAsync(removed.Select(r => (r.Token, r.Segment)), RequestCodeUnsubscribeQuote, cancellationToken);
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
                backoff = cooldown ?? (uptime >= TimeSpan.FromSeconds(30) ? TimeSpan.FromSeconds(1) : TimeSpan.FromSeconds(Math.Min(backoff.TotalSeconds * 2, 30)));

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

    private async Task WatchForStallAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            if (!await DelayAsync(StallCheckInterval, cancellationToken)) return;
            if (socket.State != WebSocketState.Open) return;

            if (_lastMessageAt != DateTimeOffset.MinValue && DateTimeOffset.UtcNow - _lastMessageAt > StallTimeout)
            {
                _logger.LogWarning("Dhan market feed has sent nothing for over {Seconds}s - reconnecting.", StallTimeout.TotalSeconds);
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
        _lastMessageAt = DateTimeOffset.MinValue;
        _connectedAt = DateTimeOffset.UtcNow;
        _loggedFirstMessage = false;
        _loggedFirstTick.Clear();

        var accessToken = _session.AccessToken ?? throw new InvalidOperationException("No Dhan access token configured.");
        var clientId = _session.ClientId ?? throw new InvalidOperationException("No Dhan client id configured.");

        var uri = new Uri($"{_options.WsUrl}?version=2&token={Uri.EscapeDataString(accessToken)}&clientId={Uri.EscapeDataString(clientId)}&authType=2");
        await _socket.ConnectAsync(uri, cancellationToken);

        var tokens = _tokenSegments.ToArray();
        _logger.LogInformation("Connected to Dhan market feed ({Count} instruments).", tokens.Length);

        if (tokens.Length > 0)
            await SendSubscriptionAsync(tokens.Select(kv => (kv.Key, kv.Value)), RequestCodeQuote, cancellationToken);
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
                _lastMessageAt = DateTimeOffset.UtcNow;

                if (!_loggedFirstMessage)
                {
                    _loggedFirstMessage = true;
                    // Its ABSENCE is the most useful fact when nothing is ticking: if this line
                    // never appears, the socket is connected but Dhan is sending literally
                    // nothing back - the problem is upstream of parsing (auth, subscription
                    // acceptance, or the market simply being closed), not this client's decoding.
                    _logger.LogInformation("Dhan market feed delivered its first data {Seconds:F1}s after connecting.", (_lastMessageAt - _connectedAt).TotalSeconds);
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
        if (!_tokenSegments.TryGetValue(packet.SecurityId, out var segment)) return;

        if (packet.LastPrice > 0 && _loggedFirstTick.TryAdd(packet.SecurityId, 0))
            _logger.LogInformation("First tick for security {SecurityId} ({Segment}): price={Price}.", packet.SecurityId, segment, packet.LastPrice);

        var previous = _lastTick.TryGetValue(packet.SecurityId, out var existing) ? existing : null;
        var tick = new SpotTick(
            SecurityId: packet.SecurityId,
            LastPrice: packet.LastPrice > 0 ? packet.LastPrice : previous?.LastPrice ?? 0,
            Open: packet.Open > 0 ? packet.Open : previous?.Open ?? 0,
            High: packet.High > 0 ? packet.High : previous?.High ?? 0,
            Low: packet.Low > 0 ? packet.Low : previous?.Low ?? 0,
            Close: packet.Close > 0 ? packet.Close : previous?.Close ?? 0,
            Volume: packet.Volume > 0 ? packet.Volume : previous?.Volume ?? 0,
            ExchangeTimestamp: packet.ExchangeTimestamp);

        _lastTick[packet.SecurityId] = tick;
        if (tick.LastPrice > 0) TickReceived?.Invoke(tick);
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
    }
}

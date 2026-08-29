using System.Net.WebSockets;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// Owns the live connection to Dhan's market feed (wss://api-feed.dhan.co) for a small, fixed set
/// of spot instruments, decodes the binary packets, and raises TickReceived for each update.
/// Reconnects with exponential backoff and re-subscribes on every reconnect.
///
/// A much smaller cousin of LiveSpreadCalculator's DhanMarketFeedClient: this app only ever
/// subscribes NIFTY's and BANKNIFTY's two index tokens (known up front, passed into RunAsync), so
/// there is no instrument-master-driven segment lookup, no order-update socket, and no
/// 100-instrument batching - just connect, subscribe two tokens, and stream. See that file for the
/// full protocol writeup this is ported from.
/// </summary>
public sealed class DhanMarketFeedClient : IAsyncDisposable
{
    private const int RequestCodeFull = 21;
    private const int RequestCodeDisconnect = 12;

    // If the socket has been open this long with zero data, it is treated as silently dead and
    // reconnected - Dhan authorizes a connection asynchronously after the handshake, so a
    // subscription sent too early can simply be ignored with no error.
    private static readonly TimeSpan StallTimeout = TimeSpan.FromSeconds(45);
    private static readonly TimeSpan StallCheckInterval = TimeSpan.FromSeconds(10);

    private readonly DhanOptions _options;
    private readonly DhanSession _session;
    private readonly ILogger<DhanMarketFeedClient> _logger;

    private ClientWebSocket? _socket;
    private IReadOnlyDictionary<uint, string> _tokenSegments = new Dictionary<uint, string>();
    private DateTimeOffset _lastMessageAt = DateTimeOffset.MinValue;
    private int _lastDisconnectCode;

    public event Action<SpotTick>? TickReceived;

    public DhanMarketFeedClient(IOptions<DhanOptions> options, DhanSession session, ILogger<DhanMarketFeedClient> logger)
    {
        _options = options.Value;
        _session = session;
        _logger = logger;
    }

    /// <summary>Runs until cancelled, connecting/reconnecting as needed. <paramref name="tokenSegments"/>
    /// maps each security id to subscribe to its Dhan WS segment string (e.g. "IDX_I").</summary>
    public async Task RunAsync(IReadOnlyDictionary<uint, string> tokenSegments, CancellationToken cancellationToken)
    {
        _tokenSegments = tokenSegments;
        var backoff = TimeSpan.FromSeconds(1);
        var loggedAwaitingSession = false;

        while (!cancellationToken.IsCancellationRequested)
        {
            if (!_session.IsAuthenticated)
            {
                if (!loggedAwaitingSession)
                {
                    _logger.LogInformation("Dhan market feed is waiting for Dhan:ClientId/Dhan:AccessToken to be configured before connecting.");
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

        var accessToken = _session.AccessToken ?? throw new InvalidOperationException("No Dhan access token configured.");
        var clientId = _session.ClientId ?? throw new InvalidOperationException("No Dhan client id configured.");

        var uri = new Uri($"{_options.WsUrl}?version=2&token={Uri.EscapeDataString(accessToken)}&clientId={Uri.EscapeDataString(clientId)}&authType=2");
        await _socket.ConnectAsync(uri, cancellationToken);

        _logger.LogInformation("Connected to Dhan market feed ({Count} instruments).", _tokenSegments.Count);

        if (_tokenSegments.Count > 0)
        {
            await SendAsync(new
            {
                RequestCode = RequestCodeFull,
                InstrumentCount = _tokenSegments.Count,
                InstrumentList = _tokenSegments.Select(kv => new { ExchangeSegment = kv.Value, SecurityId = kv.Key.ToString() }).ToArray(),
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

    private readonly Dictionary<uint, SpotTick> _lastTick = new();

    private void HandlePacket(DhanPacket packet)
    {
        if (packet.Kind == DhanPacketKind.Disconnect)
        {
            _lastDisconnectCode = packet.DisconnectCode;
            _logger.LogWarning("Dhan market feed sent a disconnect packet (code {Code}): {Reason}.", packet.DisconnectCode, DhanSymbology.DescribeFeedErrorCode(packet.DisconnectCode));
            return;
        }

        if (packet.Kind is DhanPacketKind.MarketStatus or DhanPacketKind.Unknown or DhanPacketKind.OpenInterest)
            return;

        var previous = _lastTick.TryGetValue(packet.SecurityId, out var existing) ? existing : null;
        var tick = new SpotTick(
            SecurityId: packet.SecurityId,
            LastPrice: packet.LastPrice > 0 ? packet.LastPrice : previous?.LastPrice ?? 0,
            Open: packet.Open > 0 ? packet.Open : previous?.Open ?? 0,
            High: packet.High > 0 ? packet.High : previous?.High ?? 0,
            Low: packet.Low > 0 ? packet.Low : previous?.Low ?? 0,
            Close: packet.Close > 0 ? packet.Close : previous?.Close ?? 0,
            ExchangeTimestamp: packet.ExchangeTimestamp);

        _lastTick[packet.SecurityId] = tick;
        if (tick.LastPrice > 0) TickReceived?.Invoke(tick);
    }

    private async Task SendAsync(object message, CancellationToken cancellationToken)
    {
        if (_socket is not { State: WebSocketState.Open }) return;
        var bytes = JsonSerializer.SerializeToUtf8Bytes(message);
        await _socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, cancellationToken);
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

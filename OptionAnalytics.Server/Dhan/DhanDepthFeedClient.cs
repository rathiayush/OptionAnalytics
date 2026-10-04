using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// Dhan's 20-level market depth WebSocket (wss://depth-api-feed.dhan.co/twentydepth) - a separate
/// connection from the main market feed, carrying the top 20 bid and ask levels (vs the 5 levels a
/// Full packet has) for up to 50 instruments. Dhan offers it for NSE equity and derivatives only, so a
/// BSE contract (SENSEX futures) is refused here and its consumers stay on the Full packet's 5 levels.
///
/// Callers Subscribe what they need; the client connects once there is something to stream, logs in
/// through the URL (token, clientId, authType=2), (re)subscribes everything on every connect, and
/// reconnects with backoff. DepthUpdated runs on this socket's receive loop - handlers must be quick.
/// OrderFlow:Depth20Enabled = false turns it off.
/// </summary>
public sealed class DhanDepthFeedClient : BackgroundService
{
    private const int RequestCodeSubscribe = 23;
    private const int MaxInstruments = 50;

    private readonly DhanOptions _options;
    private readonly DhanSession _session;
    private readonly ILogger<DhanDepthFeedClient> _logger;
    private readonly bool _enabled;
    private readonly ConcurrentDictionary<uint, string> _subscriptions = new();
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private readonly SemaphoreSlim _wake = new(0, 1);
    private ClientWebSocket? _socket;

    public DhanDepthFeedClient(IOptions<DhanOptions> options, DhanSession session, ILogger<DhanDepthFeedClient> logger, IConfiguration? configuration = null)
    {
        _options = options.Value;
        _session = session;
        _logger = logger;
        _enabled = configuration?.GetValue("OrderFlow:Depth20Enabled", true) ?? true;
    }

    public event Action<DepthSidePacket>? DepthUpdated;

    public bool IsConnected => _socket is { State: WebSocketState.Open };
    public DateTimeOffset? LastMessageUtc { get; private set; }

    /// <summary>Whether this feed can carry <paramref name="exchangeSegment"/> at all (NSE only).</summary>
    public bool Supports(string exchangeSegment) => _enabled && exchangeSegment.StartsWith("NSE_", StringComparison.OrdinalIgnoreCase);

    /// <summary>Starts streaming this instrument's 20-level book. False when the feed is off, the
    /// segment is not supported, or the 50-instrument limit is reached.</summary>
    public async Task<bool> SubscribeAsync(uint securityId, string exchangeSegment, CancellationToken cancellationToken)
    {
        if (!Supports(exchangeSegment)) return false;
        if (_subscriptions.ContainsKey(securityId)) return true;
        if (_subscriptions.Count >= MaxInstruments) return false;
        _subscriptions[securityId] = exchangeSegment;
        if (IsConnected) await SendSubscribeAsync(new[] { (securityId, exchangeSegment) }, cancellationToken);
        else Wake();
        return true;
    }

    private void Wake()
    {
        if (_wake.CurrentCount == 0) { try { _wake.Release(); } catch (SemaphoreFullException) { } }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_enabled)
        {
            _logger.LogInformation("Dhan 20-level depth feed is off (OrderFlow:Depth20Enabled = false) - order flow uses the 5-level book.");
            return;
        }

        var backoff = TimeSpan.FromSeconds(2);
        while (!stoppingToken.IsCancellationRequested)
        {
            if (_subscriptions.IsEmpty || !_session.IsAuthenticated)
            {
                try { await _wake.WaitAsync(TimeSpan.FromSeconds(5), stoppingToken); } catch (OperationCanceledException) { break; }
                continue;
            }

            try
            {
                await RunConnectionAsync(stoppingToken);
                backoff = TimeSpan.FromSeconds(2);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Dhan 20-level depth feed disconnected - retrying in {Seconds}s.", backoff.TotalSeconds);
            }

            try { await Task.Delay(backoff, stoppingToken); } catch (OperationCanceledException) { break; }
            backoff = TimeSpan.FromSeconds(Math.Min(backoff.TotalSeconds * 2, 60));
        }
    }

    private async Task RunConnectionAsync(CancellationToken cancellationToken)
    {
        using var socket = new ClientWebSocket();
        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
        var url = $"{_options.DepthWsUrl}?token={Uri.EscapeDataString(_session.AccessToken!)}&clientId={Uri.EscapeDataString(_session.ClientId!)}&authType=2";
        await socket.ConnectAsync(new Uri(url), cancellationToken);
        _socket = socket;
        try
        {
            _logger.LogInformation("Connected to the Dhan 20-level depth feed; subscribing {Count} instrument(s).", _subscriptions.Count);
            await SendSubscribeAsync(_subscriptions.Select(kv => (kv.Key, kv.Value)).ToList(), cancellationToken);

            var buffer = new byte[16 * 1024];
            using var message = new MemoryStream();
            while (socket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
            {
                message.SetLength(0);
                WebSocketReceiveResult result;
                do
                {
                    result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        _logger.LogWarning("Dhan 20-level depth feed closed by the server ({Status}: {Description}).", result.CloseStatus, result.CloseStatusDescription);
                        return;
                    }
                    message.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);

                if (result.MessageType != WebSocketMessageType.Binary) continue;
                LastMessageUtc = DateTimeOffset.UtcNow;
                var packets = DhanDepthPacketParser.Parse(message.GetBuffer().AsSpan(0, (int)message.Length), out var disconnect);
                if (disconnect is not null)
                {
                    _logger.LogWarning("Dhan 20-level depth feed sent a disconnect (code {Code}): {Reason}.", disconnect, DhanSymbology.DescribeFeedErrorCode(disconnect.Value));
                    return;
                }
                foreach (var packet in packets)
                {
                    try { DepthUpdated?.Invoke(packet); }
                    catch (Exception ex) { _logger.LogDebug(ex, "A depth handler failed for {SecurityId}.", packet.SecurityId); }
                }
            }
        }
        finally
        {
            _socket = null;
        }
    }

    private async Task SendSubscribeAsync(IReadOnlyList<(uint SecurityId, string Segment)> instruments, CancellationToken cancellationToken)
    {
        var socket = _socket;
        if (socket is not { State: WebSocketState.Open } || instruments.Count == 0) return;
        var payload = JsonSerializer.SerializeToUtf8Bytes(new
        {
            RequestCode = RequestCodeSubscribe,
            InstrumentCount = instruments.Count,
            InstrumentList = instruments.Select(i => new { ExchangeSegment = i.Segment, SecurityId = i.SecurityId.ToString() }).ToArray(),
        });
        await _sendLock.WaitAsync(cancellationToken);
        try { await socket.SendAsync(new ArraySegment<byte>(payload), WebSocketMessageType.Text, true, cancellationToken); }
        finally { _sendLock.Release(); }
    }
}

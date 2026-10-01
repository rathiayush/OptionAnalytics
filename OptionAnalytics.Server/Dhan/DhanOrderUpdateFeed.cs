using System.Net.WebSockets;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace OptionAnalytics.Server.Dhan;

/// <summary>Dhan's order-update socket (wss://api-order-update.dhan.co): a JSON login frame, then one
/// JSON message per order state change on the account - placed, traded, a super order's target or
/// stop-loss leg firing, cancelled, rejected. Only the fact that SOMETHING changed is surfaced
/// (OrderChanged); LiveTradingService then refreshes positions and orders once, coalescing a burst.
/// That is what keeps live positions current without polling Dhan's REST API.
///
/// Ported from LiveSpreadCalculator's DhanMarketFeedClient order-update loop. Failures are logged
/// and retried with backoff, never thrown - LiveTradingService also refreshes on a slow safety timer.</summary>
public sealed class DhanOrderUpdateFeed : BackgroundService
{
    private readonly DhanOptions _options;
    private readonly DhanSession _session;
    private readonly ILogger<DhanOrderUpdateFeed> _logger;

    public DhanOrderUpdateFeed(IOptions<DhanOptions> options, DhanSession session, ILogger<DhanOrderUpdateFeed> logger)
    {
        _options = options.Value;
        _session = session;
        _logger = logger;
    }

    public event Action? OrderChanged;

    /// <summary>Whether the socket is connected and logged in right now - shown with live positions so
    /// a stale view is never mistaken for a live one.</summary>
    public bool IsConnected { get; private set; }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var backoff = TimeSpan.FromSeconds(2);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await ReceiveAsync(stoppingToken);
                backoff = TimeSpan.FromSeconds(2);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Dhan order-update socket disconnected, retrying in {Seconds}s.", backoff.TotalSeconds);
                if (!await DelayAsync(backoff, stoppingToken)) break;
                backoff = TimeSpan.FromSeconds(Math.Min(backoff.TotalSeconds * 2, 60));
            }
            finally
            {
                IsConnected = false;
            }
        }
    }

    private async Task ReceiveAsync(CancellationToken cancellationToken)
    {
        var accessToken = _session.AccessToken;
        var clientId = _session.ClientId;
        if (string.IsNullOrEmpty(accessToken) || string.IsNullOrEmpty(clientId))
        {
            // Not logged in to Dhan yet - wait rather than hammer a connection that cannot authenticate.
            await DelayAsync(TimeSpan.FromSeconds(5), cancellationToken);
            return;
        }

        using var socket = new ClientWebSocket();
        // Keep-alive only: this socket is legitimately silent whenever no order activity happens.
        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
        await socket.ConnectAsync(new Uri(_options.OrderUpdateWsUrl), cancellationToken);

        var login = JsonSerializer.SerializeToUtf8Bytes(new
        {
            LoginReq = new { MsgCode = 42, ClientId = clientId, Token = accessToken },
            UserType = "SELF",
        });
        await socket.SendAsync(new ArraySegment<byte>(login), WebSocketMessageType.Text, true, cancellationToken);
        IsConnected = true;
        _logger.LogInformation("Connected to the Dhan order-update socket.");
        // Anything that changed while disconnected is picked up by one refresh now.
        OrderChanged?.Invoke();

        var buffer = new byte[8192];
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
                    await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "server closed", cancellationToken);
                    return;
                }
                message.Write(buffer, 0, result.Count);
            } while (!result.EndOfMessage);

            if (result.MessageType == WebSocketMessageType.Text && IsOrderAlert(message.GetBuffer().AsSpan(0, (int)message.Length)))
                OrderChanged?.Invoke();
        }
    }

    internal static bool IsOrderAlert(ReadOnlySpan<byte> json)
    {
        try
        {
            var reader = new Utf8JsonReader(json);
            using var document = JsonDocument.ParseValue(ref reader);
            return document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty("Type", out var type)
                && string.Equals(type.GetString(), "order_alert", StringComparison.OrdinalIgnoreCase);
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static async Task<bool> DelayAsync(TimeSpan delay, CancellationToken cancellationToken)
    {
        try { await Task.Delay(delay, cancellationToken); return true; }
        catch (OperationCanceledException) { return false; }
    }
}

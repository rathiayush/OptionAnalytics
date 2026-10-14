using System.Net.WebSockets;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace OptionAnalytics.Server.Dhan;

/// <summary>Dhan's order-update socket (wss://api-order-update.dhan.co): a JSON login frame, then one
/// JSON message per order state change on the account - placed, traded, a super order's target or
/// stop-loss leg firing, cancelled, rejected (https://dhanhq.co/docs/v2/order-update/). Each message is
/// parsed into a DhanOrderUpdate (OrderUpdated) - status, traded quantity, average traded price, leg -
/// which LiveTradingService applies straight to its in-memory orders and positions. Connected fires
/// after every (re)login: whatever changed while the socket was down is read once from REST then.
/// That is what keeps live positions current without polling Dhan's REST API.
///
/// Ported from LiveSpreadCalculator's DhanMarketFeedClient order-update loop. Failures are logged
/// and retried with backoff, never thrown.</summary>
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

    /// <summary>One order's new state, as the socket reported it.</summary>
    public event Action<DhanOrderUpdate>? OrderUpdated;

    /// <summary>The socket (re)connected and logged in - anything missed while it was down needs one read.</summary>
    public event Action? Connected;

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
        Connected?.Invoke();

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

            if (result.MessageType != WebSocketMessageType.Text) continue;
            var update = Parse(message.GetBuffer().AsSpan(0, (int)message.Length));
            if (update is null) continue;
            try { OrderUpdated?.Invoke(update); }
            catch (Exception ex) { _logger.LogWarning(ex, "Applying order update {OrderNo} failed.", update.OrderNo); }
        }
    }

    internal static bool IsOrderAlert(ReadOnlySpan<byte> json) => Parse(json, requireData: false) is not null;

    /// <summary>An "order_alert" message's Data, or null for anything else. Dhan sends some numbers as
    /// strings and statuses in mixed case ("Traded"); both are normalised here.</summary>
    internal static DhanOrderUpdate? Parse(ReadOnlySpan<byte> json, bool requireData = true)
    {
        try
        {
            var reader = new Utf8JsonReader(json);
            using var document = JsonDocument.ParseValue(ref reader);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("Type", out var type) || type.ValueKind != JsonValueKind.String
                || !string.Equals(type.GetString(), "order_alert", StringComparison.OrdinalIgnoreCase)) return null;
            if (!root.TryGetProperty("Data", out var d) || d.ValueKind != JsonValueKind.Object)
                return requireData ? null : DhanOrderUpdate.Empty;
            var orderNo = Text(d, "OrderNo");
            if (string.IsNullOrEmpty(orderNo)) return requireData ? null : DhanOrderUpdate.Empty;

            var quantity = Integer(d, "Quantity");
            var traded = Integer(d, "TradedQty");
            var status = (Text(d, "Status") ?? "").Trim().ToUpperInvariant().Replace(' ', '_');
            // A partly filled order is still "Pending" on the socket; the REST books call it PART_TRADED.
            if (status == "PENDING" && traded > 0 && traded < quantity) status = "PART_TRADED";
            var remarks = Text(d, "Remarks");
            return new DhanOrderUpdate(
                orderNo,
                Text(d, "SecurityId") ?? "",
                SegmentName(Text(d, "Exchange"), Text(d, "Segment")),
                ProductName(Text(d, "Product")),
                Text(d, "TxnType") is "S" or "SELL" ? "SELL" : "BUY",
                OrderTypeName(Text(d, "OrderType")),
                quantity, traded, Integer(d, "RemainingQuantity"),
                Number(d, "Price"), Number(d, "TriggerPrice"), Number(d, "TradedPrice"), Number(d, "AvgTradedPrice"),
                status, NullIfBlank(Text(d, "CorrelationId")), Integer(d, "LegNo"),
                remarks?.Contains("Super Order", StringComparison.OrdinalIgnoreCase) == true,
                NullIfBlank(Text(d, "DisplayName")) ?? NullIfBlank(Text(d, "Symbol")),
                NullIfBlank(Text(d, "ReasonDescription")));
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or FormatException)
        {
            return null;
        }
    }

    internal static string SegmentName(string? exchange, string? segment) => (exchange?.ToUpperInvariant(), segment?.ToUpperInvariant()) switch
    {
        ("NSE", "E") => "NSE_EQ",
        ("NSE", "D") => "NSE_FNO",
        ("NSE", "C") => "NSE_CURRENCY",
        ("BSE", "E") => "BSE_EQ",
        ("BSE", "D") => "BSE_FNO",
        ("BSE", "C") => "BSE_CURRENCY",
        ("MCX", _) => "MCX_COMM",
        _ => $"{exchange}_{segment}",
    };

    private static string ProductName(string? code) => code switch
    {
        "I" => "INTRADAY", "M" => "MARGIN", "C" => "CNC", "F" => "MTF", "V" => "CO", "B" => "BO",
        _ => code ?? "",
    };

    private static string OrderTypeName(string? code) => code switch
    {
        "LMT" => "LIMIT", "MKT" => "MARKET", "SL" => "STOP_LOSS", "SLM" => "STOP_LOSS_MARKET",
        _ => code ?? "LIMIT",
    };

    private static string? NullIfBlank(string? s) => string.IsNullOrWhiteSpace(s) || s == "NA" ? null : s.Trim();

    private static string? Text(JsonElement e, string name) =>
        !e.TryGetProperty(name, out var v) ? null
        : v.ValueKind == JsonValueKind.String ? v.GetString()
        : v.ValueKind == JsonValueKind.Number ? v.GetRawText()
        : null;

    private static decimal Number(JsonElement e, string name) =>
        !e.TryGetProperty(name, out var v) ? 0
        : v.ValueKind == JsonValueKind.Number ? v.GetDecimal()
        : v.ValueKind == JsonValueKind.String && decimal.TryParse(v.GetString(), System.Globalization.NumberStyles.Number, System.Globalization.CultureInfo.InvariantCulture, out var n) ? n
        : 0;

    private static int Integer(JsonElement e, string name) => (int)Math.Round(Number(e, name));

    private static async Task<bool> DelayAsync(TimeSpan delay, CancellationToken cancellationToken)
    {
        try { await Task.Delay(delay, cancellationToken); return true; }
        catch (OperationCanceledException) { return false; }
    }
}

/// <summary>One order's state from Dhan's order-update socket, with Dhan's codes spelled out the way the
/// REST books spell them (NSE/D -> NSE_FNO, I -> INTRADAY, B -> BUY, LMT -> LIMIT, Traded -> TRADED).
/// LegNo: 1 entry, 2 stop-loss, 3 target (super orders); IsSuperOrder when Remarks says "Super Order".</summary>
public sealed record DhanOrderUpdate(
    string OrderNo, string SecurityId, string ExchangeSegment, string ProductType, string TransactionType, string OrderType,
    int Quantity, int TradedQty, int RemainingQuantity, decimal Price, decimal TriggerPrice, decimal TradedPrice, decimal AvgTradedPrice,
    string Status, string? CorrelationId, int LegNo, bool IsSuperOrder, string? Symbol, string? Reason)
{
    internal static readonly DhanOrderUpdate Empty = new("", "", "", "", "BUY", "LIMIT", 0, 0, 0, 0, 0, 0, 0, "", null, 0, false, null, null);
}

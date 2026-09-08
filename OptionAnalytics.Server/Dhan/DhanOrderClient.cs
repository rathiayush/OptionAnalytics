using System.Text.Json;

namespace OptionAnalytics.Server.Dhan;

/// <summary>One plain order from GET /orders, as Dhan reports it - not a Super Order, which has
/// its own richer shape (DhanSuperOrderClient.SuperOrderSummary) with attached target/stop-loss
/// legs. FilledQty is the authoritative fill count (mirrors DhanSuperOrderClient's own
/// TriggeredQuantity per leg).</summary>
public sealed record PlainOrderSummary(
    string OrderId,
    string OrderStatus,
    string SecurityId,
    string TransactionType,
    int Quantity,
    int FilledQty,
    decimal Price,
    string? CorrelationId,
    string? OmsErrorDescription);

public sealed record PlainOrderResult(string OrderId, string OrderStatus);

/// <summary>
/// Dhan's plain Order API (https://dhanhq.co/docs/v2/orders/) - a single LIMIT/MARKET order with
/// no attached target/stop-loss legs, unlike DhanSuperOrderClient's bracket orders. Every entry
/// this app places is a Super Order (it wants the bracket); this client exists only for the one
/// case a bracket can't do - closing an EXISTING position early, at a configured square-off time,
/// independent of wherever its own target/stop-loss happen to sit. See
/// StrategyTriggerHostedService.SquareOffIfDueAsync.
///
/// Same auth/error-shape plumbing as DhanSuperOrderClient - both go through the shared
/// DhanApiClient.
/// </summary>
public sealed class DhanOrderClient
{
    private readonly DhanApiClient _api;
    private readonly ILogger<DhanOrderClient> _logger;

    public DhanOrderClient(DhanApiClient api, ILogger<DhanOrderClient> logger)
    {
        _api = api;
        _logger = logger;
    }

    /// <summary>Places a plain order. <paramref name="correlationId"/> mirrors
    /// DhanSuperOrderClient.PlaceAsync's own (max 30 chars, ties the order back to whatever
    /// triggered it for a later GET /orders lookup or a support ticket).</summary>
    public async Task<(PlainOrderResult? Result, string? Error)> PlaceAsync(
        string transactionType, string exchangeSegment, string productType, string orderType, string validity,
        string securityId, int quantity, decimal price, string correlationId, CancellationToken cancellationToken)
    {
        var payload = new
        {
            correlationId = Truncate(correlationId, 30),
            transactionType,
            exchangeSegment,
            productType,
            orderType,
            validity,
            securityId,
            quantity,
            price,
        };

        using var response = await _api.SendAsync(HttpMethod.Post, "/orders", payload,
            $"placing order ({transactionType} {securityId} x{quantity})", cancellationToken);

        if (!response.Success)
        {
            _logger.LogWarning("Order placement failed for {Security} ({Transaction} x{Qty}): {Error}",
                securityId, transactionType, quantity, response.ErrorMessage);
            return (null, response.ErrorMessage);
        }

        return (ParseResult(response.Root), null);
    }

    /// <summary>Re-prices (and/or re-sizes) an existing unfilled/partially-filled order - the
    /// square-off retry loop's counterpart to DhanSuperOrderClient.ModifyAsync's ENTRY_LEG case.
    /// Pass null for anything not being changed.</summary>
    public async Task<(PlainOrderResult? Result, string? Error)> ModifyAsync(
        string orderId, string orderType, string validity, int? quantity, decimal? price, CancellationToken cancellationToken)
    {
        var payload = new Dictionary<string, object?>
        {
            ["orderId"] = orderId,
            ["orderType"] = orderType,
            ["validity"] = validity,
        };
        if (quantity is not null) payload["quantity"] = quantity;
        if (price is not null) payload["price"] = price;

        using var response = await _api.SendAsync(HttpMethod.Put, $"/orders/{orderId}", payload,
            $"modifying order {orderId}", cancellationToken);

        if (!response.Success)
        {
            _logger.LogWarning("Order modify failed for {OrderId}: {Error}", orderId, response.ErrorMessage);
            return (null, response.ErrorMessage);
        }

        return (ParseResult(response.Root), null);
    }

    public async Task<(PlainOrderResult? Result, string? Error)> CancelAsync(string orderId, CancellationToken cancellationToken)
    {
        using var response = await _api.SendAsync(HttpMethod.Delete, $"/orders/{orderId}", null,
            $"cancelling order {orderId}", cancellationToken);

        if (!response.Success)
        {
            _logger.LogWarning("Order cancel failed for {OrderId}: {Error}", orderId, response.ErrorMessage);
            return (null, response.ErrorMessage);
        }

        return (ParseResult(response.Root), null);
    }

    /// <summary>Every plain order on the account today - the read this client's own retry loop
    /// polls to check fill progress, same shape of use as DhanSuperOrderClient.ListAsync.</summary>
    public async Task<IReadOnlyList<PlainOrderSummary>> ListAsync(CancellationToken cancellationToken)
    {
        using var response = await _api.SendAsync(HttpMethod.Get, "/orders", null, "listing orders", cancellationToken);

        if (!response.Success)
        {
            _logger.LogWarning("Order list failed: {Error}", response.ErrorMessage);
            return Array.Empty<PlainOrderSummary>();
        }

        if (response.Root.ValueKind != JsonValueKind.Array) return Array.Empty<PlainOrderSummary>();

        var result = new List<PlainOrderSummary>(response.Root.GetArrayLength());
        foreach (var element in response.Root.EnumerateArray())
        {
            result.Add(new PlainOrderSummary(
                GetString(element, "orderId") ?? "",
                GetString(element, "orderStatus") ?? "",
                GetString(element, "securityId") ?? "",
                GetString(element, "transactionType") ?? "",
                GetInt(element, "quantity") ?? 0,
                GetInt(element, "filledQty") ?? 0,
                GetDecimal(element, "price") ?? 0,
                GetString(element, "correlationId"),
                GetString(element, "omsErrorDescription")));
        }

        return result;
    }

    private static PlainOrderResult ParseResult(JsonElement root) =>
        new(GetString(root, "orderId") ?? "", GetString(root, "orderStatus") ?? "");

    private static string Truncate(string value, int maxLength) => value.Length <= maxLength ? value : value[..maxLength];

    private static string? GetString(JsonElement element, string property) =>
        element.TryGetProperty(property, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static decimal? GetDecimal(JsonElement element, string property) =>
        element.TryGetProperty(property, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDecimal() : null;

    private static int? GetInt(JsonElement element, string property) =>
        element.TryGetProperty(property, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : null;
}

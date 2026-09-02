using System.Text.Json;

namespace OptionAnalytics.Server.Dhan;

/// <summary>One leg of a placed Super Order, as Dhan's GET /super/orders reports it.</summary>
public sealed record SuperOrderLeg(
    string LegName,
    string OrderStatus,
    string TransactionType,
    decimal? Price,
    decimal? TrailingJump,
    int? TriggeredQuantity);

/// <summary>One Super Order (its entry leg plus whatever target/stop-loss legs Dhan has attached),
/// as returned by GET /super/orders.</summary>
public sealed record SuperOrderSummary(
    string OrderId,
    string OrderStatus,
    string TransactionType,
    string ExchangeSegment,
    string SecurityId,
    int Quantity,
    decimal Price,
    decimal? TargetPrice,
    decimal? StopLossPrice,
    IReadOnlyList<SuperOrderLeg> LegDetails);

/// <summary>Result of a place/modify/cancel call - just what Dhan's own response bodies carry for
/// those three (an order id and its current status), never a full SuperOrderSummary.</summary>
public sealed record SuperOrderResult(string OrderId, string OrderStatus);

/// <summary>
/// Dhan's Super Order API (https://dhanhq.co/docs/v2/super-order/) - a bracket order where a
/// single entry order carries its own target and stop-loss as attached legs Dhan manages after
/// entry fills, rather than this app having to watch price and fire separate exit orders itself.
/// Every call goes through the shared DhanApiClient (same access-token/client-id auth, same
/// {errorType,errorCode,errorMessage} parsing, same dhanClientId-injection-into-body) everything
/// else in this app's Dhan integration already uses - this class only knows the Super Order
/// endpoints' own shapes.
///
/// Dhan requires STATIC IP WHITELISTING on the account for these write endpoints (place/modify/
/// cancel) - GET /super/orders is read-only and unaffected. Without whitelisting, every write call
/// here fails with a Dhan-side authorization error, not anything this client can detect or work
/// around in advance.
///
/// This class is a pure, unopinionated wrapper - it does not decide WHEN to place an order, what
/// quantity or product type to use, or how a strategy's points-based SL/TP become the absolute
/// prices this API wants. That's the caller's job (the eventual Strategy Trigger integration);
/// this class just knows how to talk to Dhan once those numbers are decided.
/// </summary>
public sealed class DhanSuperOrderClient
{
    private readonly DhanApiClient _api;
    private readonly ILogger<DhanSuperOrderClient> _logger;

    public DhanSuperOrderClient(DhanApiClient api, ILogger<DhanSuperOrderClient> logger)
    {
        _api = api;
        _logger = logger;
    }

    /// <summary>Places a new Super Order. <paramref name="correlationId"/> is Dhan's own
    /// idempotency/tracking tag (max 30 chars) - pass something that ties back to the strategy
    /// trigger and signal that caused this order, so a later GET /super/orders listing (or a
    /// support ticket) can be matched back to it. <paramref name="trailingJump"/> defaults to 0
    /// (no trailing stop) - pass a positive value to have Dhan trail the stop-loss as the position
    /// moves favorably.
    ///
    /// Returns null (after logging) on any failure - a rejected or errored order is never worth
    /// throwing for, since the caller needs to keep evaluating other triggers regardless.</summary>
    public async Task<SuperOrderResult?> PlaceAsync(
        string transactionType, string exchangeSegment, string productType, string orderType,
        string securityId, int quantity, decimal price, decimal targetPrice, decimal stopLossPrice,
        string correlationId, decimal trailingJump, CancellationToken cancellationToken)
    {
        var payload = new
        {
            correlationId = Truncate(correlationId, 30),
            transactionType,
            exchangeSegment,
            productType,
            orderType,
            securityId,
            quantity,
            price,
            targetPrice,
            stopLossPrice,
            trailingJump,
        };

        using var response = await _api.SendAsync(HttpMethod.Post, "/super/orders", payload,
            $"placing super order ({transactionType} {securityId} x{quantity})", cancellationToken);

        if (!response.Success)
        {
            _logger.LogWarning("Super order placement failed for {Security} ({Transaction} x{Qty}): {Error}",
                securityId, transactionType, quantity, response.ErrorMessage);
            return null;
        }

        return ParseResult(response.Root);
    }

    /// <summary>Modifies one leg of an existing Super Order. Which fields are meaningful depends
    /// on <paramref name="legName"/> - see the class's own linked docs: ENTRY_LEG accepts
    /// orderType/quantity/price/targetPrice/stopLossPrice/trailingJump (and only while the entry
    /// is still PENDING or PART_TRADED); TARGET_LEG accepts targetPrice only; STOP_LOSS_LEG
    /// accepts stopLossPrice/trailingJump only. Pass null for anything not being changed on this
    /// call - this method sends only the fields given a value.</summary>
    public async Task<SuperOrderResult?> ModifyAsync(
        string orderId, string legName, string? orderType, int? quantity, decimal? price,
        decimal? targetPrice, decimal? stopLossPrice, decimal? trailingJump, CancellationToken cancellationToken)
    {
        var payload = new Dictionary<string, object?>
        {
            ["orderId"] = orderId,
            ["legName"] = legName,
        };
        if (orderType is not null) payload["orderType"] = orderType;
        if (quantity is not null) payload["quantity"] = quantity;
        if (price is not null) payload["price"] = price;
        if (targetPrice is not null) payload["targetPrice"] = targetPrice;
        if (stopLossPrice is not null) payload["stopLossPrice"] = stopLossPrice;
        if (trailingJump is not null) payload["trailingJump"] = trailingJump;

        using var response = await _api.SendAsync(HttpMethod.Put, $"/super/orders/{orderId}", payload,
            $"modifying super order {orderId} ({legName})", cancellationToken);

        if (!response.Success)
        {
            _logger.LogWarning("Super order modify failed for {OrderId} ({Leg}): {Error}", orderId, legName, response.ErrorMessage);
            return null;
        }

        return ParseResult(response.Root);
    }

    /// <summary>Cancels one leg. Cancelling ENTRY_LEG cancels the whole order (all its legs);
    /// cancelling TARGET_LEG or STOP_LOSS_LEG specifically removes just that exit and - per Dhan's
    /// own docs - it cannot be re-added afterward, only a fresh order placed.</summary>
    public async Task<SuperOrderResult?> CancelAsync(string orderId, string legName, CancellationToken cancellationToken)
    {
        using var response = await _api.SendAsync(HttpMethod.Delete, $"/super/orders/{orderId}/{legName}", null,
            $"cancelling super order {orderId} ({legName})", cancellationToken);

        if (!response.Success)
        {
            _logger.LogWarning("Super order cancel failed for {OrderId} ({Leg}): {Error}", orderId, legName, response.ErrorMessage);
            return null;
        }

        return ParseResult(response.Root);
    }

    /// <summary>Every Super Order on the account today, entry legs and their attached target/stop-
    /// loss legs together - the only read this client offers, and the one call NOT subject to the
    /// static-IP-whitelisting requirement the three write calls above have.</summary>
    public async Task<IReadOnlyList<SuperOrderSummary>> ListAsync(CancellationToken cancellationToken)
    {
        using var response = await _api.SendAsync(HttpMethod.Get, "/super/orders", null, "listing super orders", cancellationToken);

        if (!response.Success)
        {
            _logger.LogWarning("Super order list failed: {Error}", response.ErrorMessage);
            return Array.Empty<SuperOrderSummary>();
        }

        if (response.Root.ValueKind != JsonValueKind.Array) return Array.Empty<SuperOrderSummary>();

        var result = new List<SuperOrderSummary>(response.Root.GetArrayLength());
        foreach (var element in response.Root.EnumerateArray())
        {
            var legs = new List<SuperOrderLeg>();
            if (element.TryGetProperty("legDetails", out var legDetails) && legDetails.ValueKind == JsonValueKind.Array)
            {
                foreach (var leg in legDetails.EnumerateArray())
                {
                    legs.Add(new SuperOrderLeg(
                        GetString(leg, "legName") ?? "",
                        GetString(leg, "orderStatus") ?? "",
                        GetString(leg, "transactionType") ?? "",
                        GetDecimal(leg, "price"),
                        GetDecimal(leg, "trailingJump"),
                        GetInt(leg, "triggeredQuantity")));
                }
            }

            result.Add(new SuperOrderSummary(
                GetString(element, "orderId") ?? "",
                GetString(element, "orderStatus") ?? "",
                GetString(element, "transactionType") ?? "",
                GetString(element, "exchangeSegment") ?? "",
                GetString(element, "securityId") ?? "",
                GetInt(element, "quantity") ?? 0,
                GetDecimal(element, "price") ?? 0,
                GetDecimal(element, "targetPrice"),
                GetDecimal(element, "stopLossPrice"),
                legs));
        }

        return result;
    }

    private static SuperOrderResult ParseResult(JsonElement root) =>
        new(GetString(root, "orderId") ?? "", GetString(root, "orderStatus") ?? "");

    private static string Truncate(string value, int maxLength) => value.Length <= maxLength ? value : value[..maxLength];

    private static string? GetString(JsonElement element, string property) =>
        element.TryGetProperty(property, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static decimal? GetDecimal(JsonElement element, string property) =>
        element.TryGetProperty(property, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDecimal() : null;

    private static int? GetInt(JsonElement element, string property) =>
        element.TryGetProperty(property, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : null;
}

using System.Text.Json;

namespace OptionAnalytics.Server.Dhan;

/// <summary>One entry from GET /positions - Dhan's own record of what the account currently
/// holds, not this app's inference about it. NetQty (BuyQty - SellQty) and PositionType
/// (LONG/SHORT/CLOSED) are Dhan's own two ways of saying the same thing - a closed position nets
/// to 0 and PositionType flips to CLOSED the instant that happens, whether the exit was this
/// app's own target/stop-loss leg, a manual square-off, or anything else. That makes this the one
/// ground truth for "is there still an open position in this contract" - see IsOpen below.</summary>
public sealed record DhanPosition(
    string SecurityId,
    string TradingSymbol,
    string ExchangeSegment,
    string ProductType,
    string PositionType,
    int NetQty)
{
    /// <summary>Average prices and today's booked P&L as Dhan reports them - what live P&L is
    /// computed from (see LiveTradingService). Optional so existing callers need not set them.</summary>
    public decimal BuyAvg { get; init; }
    public decimal SellAvg { get; init; }
    public int BuyQty { get; init; }
    public int SellQty { get; init; }
    public decimal RealizedProfit { get; init; }

    public bool IsOpen => PositionType != "CLOSED" && NetQty != 0;

    /// <summary>Which side closes this position - a LONG position was bought, so it closes by
    /// selling; anything else (SHORT; CLOSED is moot since IsOpen would already be false) was
    /// sold, so it closes by buying back. Used to square off an open position early
    /// (StrategyTriggerHostedService.SquareOffIfDueAsync) without a fresh signal's own
    /// Side/Direction to read the transaction type off of.</summary>
    public bool ClosesBySelling => PositionType != "SHORT";
}

/// <summary>Thin wrapper for Dhan's GET /positions (https://dhanhq.co/docs/v2/portfolio/) - the
/// account's actual current holdings, as opposed to DhanSuperOrderClient's view of the order
/// book. Read-only, so - like DhanSuperOrderClient.ListAsync - not subject to the static-IP-
/// whitelisting requirement Dhan's write endpoints have.</summary>
public sealed class DhanPositionsClient
{
    private readonly DhanApiClient _api;
    private readonly ILogger<DhanPositionsClient> _logger;

    public DhanPositionsClient(DhanApiClient api, ILogger<DhanPositionsClient> logger)
    {
        _api = api;
        _logger = logger;
    }

    /// <summary>Every position Dhan reports for today, open and closed alike - callers filter
    /// with DhanPosition.IsOpen for whatever they actually need. Empty (not thrown) on any
    /// failure, same as DhanSuperOrderClient.ListAsync - already logged here, and a caller using
    /// this as a safety gate would rather fail open (place the order, same as before this check
    /// existed) than fail the whole evaluation over a transient read error.</summary>
    /// <summary>Dhan's own DELETE /positions: "Exit all active positions and cancel all open orders for
    /// the current trading day" - EVERYTHING on the account, every product, including positions and
    /// orders this app's strategy triggers own. The emergency switch only; returns Dhan's error text on
    /// failure, null on success.</summary>
    public async Task<string?> ExitAllAccountAsync(CancellationToken cancellationToken)
    {
        using var response = await _api.SendAsync(HttpMethod.Delete, "/positions", null, "exiting all positions (account-wide)", cancellationToken);
        if (response.Success) return null;
        _logger.LogWarning("Exit-all-positions failed: {Error}", response.ErrorMessage);
        return response.ErrorMessage ?? "Dhan did not confirm the exit";
    }

    public async Task<IReadOnlyList<DhanPosition>> ListAsync(CancellationToken cancellationToken)
    {
        using var response = await _api.SendAsync(HttpMethod.Get, "/positions", null, "listing positions", cancellationToken);

        if (!response.Success)
        {
            _logger.LogWarning("Position list failed: {Error}", response.ErrorMessage);
            return Array.Empty<DhanPosition>();
        }

        if (response.Root.ValueKind != JsonValueKind.Array) return Array.Empty<DhanPosition>();

        var result = new List<DhanPosition>(response.Root.GetArrayLength());
        foreach (var element in response.Root.EnumerateArray())
        {
            result.Add(new DhanPosition(
                GetString(element, "securityId") ?? "",
                GetString(element, "tradingSymbol") ?? "",
                GetString(element, "exchangeSegment") ?? "",
                GetString(element, "productType") ?? "",
                GetString(element, "positionType") ?? "",
                GetInt(element, "netQty") ?? 0)
            {
                BuyAvg = GetDecimal(element, "buyAvg") ?? 0,
                SellAvg = GetDecimal(element, "sellAvg") ?? 0,
                BuyQty = GetInt(element, "buyQty") ?? 0,
                SellQty = GetInt(element, "sellQty") ?? 0,
                RealizedProfit = GetDecimal(element, "realizedProfit") ?? 0,
            });
        }

        return result;
    }

    private static string? GetString(JsonElement element, string property) =>
        element.TryGetProperty(property, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static decimal? GetDecimal(JsonElement element, string property) =>
        element.TryGetProperty(property, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDecimal() : null;

    private static int? GetInt(JsonElement element, string property) =>
        element.TryGetProperty(property, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : null;
}

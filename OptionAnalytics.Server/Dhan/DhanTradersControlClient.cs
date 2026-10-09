using System.Globalization;
using System.Text.Json;

namespace OptionAnalytics.Server.Dhan;

/// <summary>Dhan's "Trader's Control" endpoints (https://dhanhq.co/docs/v2/traders-control/):
/// the kill switch (no more trading on the account for the rest of the day) and the P&L based exit
/// (Dhan itself exits every position - and, with enableKillSwitch, turns the kill switch on - once
/// the day's P&L reaches a loss or profit; it holds for the day and resets after the session).
/// Used by KillSwitchService for the daily loss limit.</summary>
public class DhanTradersControlClient
{
    private readonly DhanApiClient _api;
    private readonly ILogger<DhanTradersControlClient> _logger;

    public DhanTradersControlClient(DhanApiClient api, ILogger<DhanTradersControlClient> logger)
    {
        _api = api;
        _logger = logger;
    }

    /// <summary>POST /killswitch?killSwitchStatus=ACTIVATE - Dhan only accepts it once every position is
    /// closed and no order is pending. Null on success, else Dhan's error.</summary>
    public virtual async Task<string?> ActivateKillSwitchAsync(CancellationToken cancellationToken)
    {
        using var response = await _api.SendAsync(HttpMethod.Post, "/killswitch?killSwitchStatus=ACTIVATE", null, "activating the kill switch", cancellationToken);
        if (response.Success) return null;
        _logger.LogWarning("Kill switch activation failed: {Error}", response.ErrorMessage);
        return response.ErrorMessage ?? "Dhan did not confirm the kill switch";
    }

    /// <summary>GET /killswitch - true when the kill switch is on for today, null when it could not be read.</summary>
    public virtual async Task<bool?> KillSwitchActiveAsync(CancellationToken cancellationToken)
    {
        using var response = await _api.SendAsync(HttpMethod.Get, "/killswitch", null, "reading the kill switch", cancellationToken);
        if (!response.Success || response.Root.ValueKind != JsonValueKind.Object) return null;
        var status = response.Root.TryGetProperty("killSwitchStatus", out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        return status is null ? null : status.Contains("ACTIVATE", StringComparison.OrdinalIgnoreCase) && !status.Contains("DEACTIVATE", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>POST /pnlExit - Dhan exits every intraday position (and turns the kill switch on) once the
    /// day's P&L is down <paramref name="lossValue"/> or up <paramref name="profitValue"/>. Already beyond
    /// either, it exits at once. Null on success, else Dhan's error.</summary>
    public virtual async Task<string?> SetPnlExitAsync(decimal lossValue, decimal profitValue, CancellationToken cancellationToken)
    {
        var payload = new
        {
            profitValue = profitValue.ToString("0.00", CultureInfo.InvariantCulture),
            lossValue = lossValue.ToString("0.00", CultureInfo.InvariantCulture),
            productType = new[] { "INTRADAY" },
            enableKillSwitch = true,
        };
        using var response = await _api.SendAsync(HttpMethod.Post, "/pnlExit", payload, "setting the P&L based exit", cancellationToken);
        if (response.Success) return null;
        _logger.LogWarning("P&L based exit could not be set: {Error}", response.ErrorMessage);
        return response.ErrorMessage ?? "Dhan did not confirm the P&L based exit";
    }

    /// <summary>DELETE /pnlExit - stops today's P&L based exit. Null on success, else Dhan's error.</summary>
    public virtual async Task<string?> StopPnlExitAsync(CancellationToken cancellationToken)
    {
        using var response = await _api.SendAsync(HttpMethod.Delete, "/pnlExit", null, "stopping the P&L based exit", cancellationToken);
        if (response.Success) return null;
        _logger.LogWarning("P&L based exit could not be stopped: {Error}", response.ErrorMessage);
        return response.ErrorMessage ?? "Dhan did not confirm stopping the P&L based exit";
    }

    /// <summary>GET /pnlExit - the loss Dhan's P&L based exit is set to today, or null when none is active
    /// (or it could not be read).</summary>
    public virtual async Task<decimal?> PnlExitLossAsync(CancellationToken cancellationToken)
    {
        using var response = await _api.SendAsync(HttpMethod.Get, "/pnlExit", null, "reading the P&L based exit", cancellationToken);
        if (!response.Success || response.Root.ValueKind != JsonValueKind.Object) return null;
        var root = response.Root;
        var status = root.TryGetProperty("pnlExitStatus", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() : null;
        if (!string.Equals(status, "ACTIVE", StringComparison.OrdinalIgnoreCase)) return null;
        if (!root.TryGetProperty("loss", out var loss)) return null;
        return loss.ValueKind switch
        {
            JsonValueKind.Number => loss.GetDecimal(),
            JsonValueKind.String when decimal.TryParse(loss.GetString(), NumberStyles.Any, CultureInfo.InvariantCulture, out var d) => d,
            _ => null,
        };
    }
}

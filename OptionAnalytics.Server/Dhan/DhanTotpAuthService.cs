using System.Text.Json;
using Microsoft.Extensions.Options;

namespace OptionAnalytics.Server.Dhan;

public readonly record struct DhanTotpLoginResult(bool Success, DateTimeOffset? ExpiresUtc, string? Error, bool RateLimited = false);

/// <summary>
/// Mints a fresh Dhan access token with no browser and no human involved: computes the current
/// TOTP code from DhanOptions.TotpSecret (RFC 6238 - see TotpGenerator) and calls
/// POST {auth}/app/generateAccessToken with dhanClientId + pin + totp as query parameters, per
/// https://dhanhq.co/docs/v2/authentication/. Ported from LiveSpreadCalculator's DhanAuthService,
/// trimmed to just this one flow - this app has no login UI to drive Dhan's browser-based Consent
/// flow, so TOTP (fully automatic) and a manually pasted static AccessToken (DhanOptions.AccessToken)
/// are the only two paths here.
///
/// On success, writes the token straight to DhanSession, so DhanApiClient and
/// DhanMarketFeedClient both pick it up on their very next attempt. Only
/// DhanTotpAutoRenewalHostedService calls this.
/// </summary>
public sealed class DhanTotpAuthService
{
    private static readonly TimeSpan TokenValidity = TimeSpan.FromHours(24);

    private readonly HttpClient _httpClient;
    private readonly DhanOptions _options;
    private readonly DhanSession _session;
    private readonly ILogger<DhanTotpAuthService> _logger;

    public DhanTotpAuthService(HttpClient httpClient, IOptions<DhanOptions> options, DhanSession session, ILogger<DhanTotpAuthService> logger)
    {
        _httpClient = httpClient;
        _options = options.Value;
        _session = session;
        _logger = logger;
    }

    /// <summary>Wraps AttemptAsync so EVERY outcome - including the early "not configured" and
    /// malformed-secret returns - lands in DhanSession.LastAuthAttempt for DiagnosticsController to
    /// report. See that property's own doc comment for why that matters.</summary>
    public async Task<DhanTotpLoginResult> GenerateAccessTokenAsync(CancellationToken cancellationToken)
    {
        var result = await AttemptAsync(cancellationToken);
        _session.RecordAuthAttempt(result.Success, result.Error, result.RateLimited);
        return result;
    }

    private async Task<DhanTotpLoginResult> AttemptAsync(CancellationToken cancellationToken)
    {
        if (!_options.HasTotpCredentials)
            return new DhanTotpLoginResult(false, null, "Dhan:ClientId / Dhan:Pin / Dhan:TotpSecret are not fully configured for TOTP auto-login.");

        string totp;
        try
        {
            totp = TotpGenerator.GenerateCode(_options.TotpSecret!);
        }
        catch (FormatException ex)
        {
            return new DhanTotpLoginResult(false, null, $"Dhan:TotpSecret is not a valid base32 TOTP secret: {ex.Message}");
        }

        var url = $"{_options.AuthBaseUrl}/app/generateAccessToken" +
                  $"?dhanClientId={Uri.EscapeDataString(_options.ClientId)}" +
                  $"&pin={Uri.EscapeDataString(_options.Pin!)}" +
                  $"&totp={Uri.EscapeDataString(totp)}";

        try
        {
            using var response = await _httpClient.PostAsync(url, content: null, cancellationToken);
            var body = await response.Content.ReadAsStringAsync(cancellationToken);

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning("Dhan TOTP login failed (HTTP {Status}): {Body}", (int)response.StatusCode, Truncate(body));
                // Dhan's own body text is the only thing that distinguishes a wrong PIN from a wrong
                // TOTP from an account without API access, so it is carried into the result (and
                // therefore DiagnosticsController) rather than flattened to the status code alone -
                // redacted first, since the request URL carried the pin/totp as query parameters and
                // an error body that echoes the request back would otherwise leak them.
                return new DhanTotpLoginResult(false, null,
                    $"Dhan rejected the TOTP login (HTTP {(int)response.StatusCode}): {Redact(Truncate(body), _options.Pin, totp)}");
            }

            using var document = JsonDocument.Parse(body);
            var root = document.RootElement;

            var accessToken = root.TryGetProperty("accessToken", out var at) ? at.GetString() : null;
            if (string.IsNullOrWhiteSpace(accessToken))
            {
                // Dhan answers a too-frequent generateAccessToken call with HTTP 200 and
                // {"status":"error","message":"Token can be generated once every 2 minutes."} -
                // no accessToken, but also no non-2xx status to distinguish it from a genuine
                // credential failure. Detected by message text so the caller (see
                // DhanTotpAutoRenewalHostedService) can wait out Dhan's own cooldown instead of
                // retrying every few seconds and re-triggering the same limit forever.
                var message = root.TryGetProperty("message", out var m) ? m.GetString() : null;
                var rateLimited = message?.Contains("every", StringComparison.OrdinalIgnoreCase) == true
                    && message.Contains("minute", StringComparison.OrdinalIgnoreCase);

                return new DhanTotpLoginResult(false, null, message ?? "Dhan's TOTP login response contained no accessToken.", rateLimited);
            }

            var clientId = root.TryGetProperty("dhanClientId", out var cid) ? cid.GetString() : null;
            if (string.IsNullOrWhiteSpace(clientId)) clientId = _options.ClientId;

            _session.AccessToken = accessToken;
            _session.ClientId = clientId;

            var expiresUtc = ReadExpiry(root) ?? DateTimeOffset.UtcNow.Add(TokenValidity);
            return new DhanTotpLoginResult(true, expiresUtc, null);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Dhan TOTP login failed (network error or unexpected response).");
            return new DhanTotpLoginResult(false, null, ex.Message);
        }
    }

    private static DateTimeOffset? ReadExpiry(JsonElement root)
    {
        if (!root.TryGetProperty("expiryTime", out var expiry)) return null;
        var raw = expiry.ValueKind == JsonValueKind.String ? expiry.GetString() : null;
        if (string.IsNullOrWhiteSpace(raw)) return null;

        return DateTimeOffset.TryParse(raw, System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal, out var parsed)
            ? parsed
            : null;
    }

    private static string Truncate(string value) => value.Length <= 300 ? value : value[..300] + "...";

    /// <summary>Blanks the PIN and the just-computed TOTP code out of text that is about to travel
    /// somewhere less private than a log line (see the caller) - Dhan sends both as query
    /// parameters, so any error body that echoes the request would otherwise carry them.</summary>
    private static string Redact(string value, params string?[] secrets)
    {
        foreach (var secret in secrets)
        {
            if (!string.IsNullOrWhiteSpace(secret)) value = value.Replace(secret, "***", StringComparison.Ordinal);
        }
        return value;
    }
}

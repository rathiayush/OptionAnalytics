using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace OptionAnalytics.Server.Dhan;

/// <summary>One parsed response from a Dhan REST call. Owns the underlying JsonDocument, so
/// callers must dispose it.</summary>
public sealed class DhanApiResponse : IDisposable
{
    private readonly JsonDocument? _document;

    internal DhanApiResponse(bool success, HttpStatusCode statusCode, JsonDocument? document, string? errorMessage)
    {
        Success = success;
        StatusCode = statusCode;
        _document = document;
        ErrorMessage = errorMessage;
    }

    public bool Success { get; }
    public HttpStatusCode StatusCode { get; }
    public string? ErrorMessage { get; }

    public JsonElement Root => _document?.RootElement
        ?? throw new InvalidOperationException("This Dhan response has no body to read - check Success first.");

    public void Dispose() => _document?.Dispose();
}

/// <summary>
/// The single place every Dhan REST call goes through - auth headers (access-token/client-id,
/// not a bearer Authorization header), dhanClientId injected into the JSON body, and Dhan's
/// {errorType,errorCode,errorMessage} error shape parsed uniformly. Ported from
/// LiveSpreadCalculator's SpreadTrader.DhanIntegration.DhanApiClient, trimmed to drop the
/// auth-failure-handler indirection this app doesn't need (see DhanSession's doc comment).
/// </summary>
public sealed class DhanApiClient
{
    /// <summary>Extra attempts (beyond the first) SendAsync retries ONLY when the failure itself
    /// looks like an auth problem (see LooksLikeAuthFailure) - a token that just went stale mid-
    /// session can recover within seconds of DhanTotpAutoRenewalHostedService's own reactive
    /// renewal (see DhanSession.SessionInvalidated), so a request that hit the STALE token is
    /// worth retrying rather than failing outright and making every caller re-click "Run".</summary>
    private const int MaxAuthRetryAttempts = 2;

    /// <summary>How long to wait before each auth retry - long enough for a normal (non-rate-
    /// limited) TOTP renewal to complete, short enough that a genuinely broken token (TOTP not
    /// configured, or Dhan itself down) still fails within a few seconds rather than hanging every
    /// caller for the full ~130s rate-limit cooldown DhanTotpAutoRenewalHostedService's OWN retry
    /// loop uses for that separate, slower case.</summary>
    private static readonly TimeSpan AuthRetryDelay = TimeSpan.FromSeconds(3);

    private readonly HttpClient _httpClient;
    private readonly DhanOptions _options;
    private readonly DhanSession _session;
    private readonly ILogger<DhanApiClient> _logger;

    public DhanApiClient(HttpClient httpClient, IOptions<DhanOptions> options, DhanSession session, ILogger<DhanApiClient> logger)
    {
        _httpClient = httpClient;
        _options = options.Value;
        _session = session;
        _logger = logger;
    }

    public bool HasSession => _session.IsAuthenticated;

    /// <summary>Retries automatically when the failure itself looks like a stale/invalid token -
    /// see MaxAuthRetryAttempts' own doc comment for why. Every other kind of failure (a real
    /// rejection, a network error, an unrelated HTTP error) is returned on the first attempt
    /// exactly as before - retrying those would just repeat the same failure while making the
    /// caller wait longer for no benefit.</summary>
    public async Task<DhanApiResponse> SendAsync(HttpMethod method, string path, object? payload, string context, CancellationToken cancellationToken)
    {
        for (var attempt = 1; ; attempt++)
        {
            var response = await SendOnceAsync(method, path, payload, context, cancellationToken);
            if (response.Success || attempt > MaxAuthRetryAttempts || !LooksLikeAuthFailure(response.StatusCode, response.ErrorMessage))
                return response;

            _logger.LogInformation(
                "Dhan call ({Context}) hit a stale/invalid token - retrying in {Seconds}s to give a fresh one a chance to arrive (attempt {Attempt}/{Max}).",
                context, AuthRetryDelay.TotalSeconds, attempt, MaxAuthRetryAttempts);
            await Task.Delay(AuthRetryDelay, cancellationToken);
        }
    }

    private async Task<DhanApiResponse> SendOnceAsync(HttpMethod method, string path, object? payload, string context, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(method, $"{_options.RestBaseUrl}{path}");
        request.Headers.TryAddWithoutValidation("access-token", _session.AccessToken ?? "");
        request.Headers.TryAddWithoutValidation("client-id", _session.ClientId ?? "");
        request.Headers.TryAddWithoutValidation("Accept", "application/json");

        if (payload is not null)
            request.Content = new StringContent(SerializeWithClientId(payload), Encoding.UTF8, "application/json");

        try
        {
            using var response = await _httpClient.SendAsync(request, cancellationToken);
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            return Parse(response.StatusCode, body, context);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Dhan request failed while {Context} ({Method} {Path})", context, method, path);
            return new DhanApiResponse(false, HttpStatusCode.ServiceUnavailable, null, ex.Message);
        }
    }

    private string SerializeWithClientId(object payload)
    {
        var json = JsonSerializer.Serialize(payload);
        var clientId = _session.ClientId;
        if (string.IsNullOrEmpty(clientId)) return json;

        using var document = JsonDocument.Parse(json);
        if (document.RootElement.ValueKind != JsonValueKind.Object) return json;

        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("dhanClientId", clientId);
            foreach (var property in document.RootElement.EnumerateObject())
            {
                if (property.NameEquals("dhanClientId")) continue;
                property.WriteTo(writer);
            }
            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    private DhanApiResponse Parse(HttpStatusCode statusCode, string body, string context)
    {
        JsonDocument? document = null;
        if (!string.IsNullOrWhiteSpace(body))
        {
            try { document = JsonDocument.Parse(body); }
            catch (JsonException) { document = null; }
        }

        var isSuccess = (int)statusCode is >= 200 and <= 299;
        if (isSuccess && document is not null)
            return new DhanApiResponse(true, statusCode, document, null);

        var message = ReadError(document, body);
        document?.Dispose();

        if (LooksLikeAuthFailure(statusCode, message))
        {
            _logger.LogWarning("Dhan authentication failed while {Context}: {Message}. The access token may have expired.", context, message);
            // Wakes DhanTotpAutoRenewalHostedService immediately instead of waiting for its next
            // scheduled renewal - a no-op when TOTP auto-login isn't configured.
            _session.ClearAccessToken();
        }

        return new DhanApiResponse(false, statusCode, null, message ?? (isSuccess ? "Dhan returned an empty or unparseable body." : $"Dhan returned HTTP {(int)statusCode}."));
    }

    /// <summary>A real run confirmed Dhan does not always signal an invalid/expired token with an
    /// actual 401/403 - "Order_Error: Invalid Token" reached a caller as this endpoint's own error
    /// BODY, on some other status entirely, so relying on the HTTP status code alone missed it.
    /// Matched by MESSAGE TEXT too (case-insensitive "invalid token") as a second, independent
    /// signal alongside the status check, so either shape of the same underlying problem triggers
    /// the same recovery (clear the session, retry - see SendAsync/ClearAccessToken).</summary>
    internal static bool LooksLikeAuthFailure(HttpStatusCode statusCode, string? message) =>
        statusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden ||
        (message is not null && message.Contains("invalid token", StringComparison.OrdinalIgnoreCase));

    private static string? ReadError(JsonDocument? document, string rawBody)
    {
        if (document is null)
            return string.IsNullOrWhiteSpace(rawBody) ? null : Truncate(rawBody);

        var root = document.RootElement;
        if (root.ValueKind == JsonValueKind.Array && root.GetArrayLength() > 0)
            root = root[0];

        if (root.ValueKind != JsonValueKind.Object) return Truncate(rawBody);

        var message = root.TryGetProperty("errorMessage", out var m) ? m.GetString() : null;
        var type = root.TryGetProperty("errorType", out var t) ? t.GetString() : null;
        message ??= root.TryGetProperty("omsErrorDescription", out var oms) ? oms.GetString() : null;

        return (type, message) switch
        {
            (not null, not null) => $"{type}: {message}",
            (not null, null) => type,
            (null, not null) => message,
            _ => Truncate(rawBody),
        };
    }

    private static string Truncate(string value) => value.Length <= 500 ? value : value[..500] + "...";
}

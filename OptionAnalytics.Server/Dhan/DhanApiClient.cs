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

    public async Task<DhanApiResponse> SendAsync(HttpMethod method, string path, object? payload, string context, CancellationToken cancellationToken)
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

        if (statusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            _logger.LogWarning("Dhan authentication failed while {Context}: {Message}. The access token may have expired.", context, message);
            // Wakes DhanTotpAutoRenewalHostedService immediately instead of waiting for its next
            // scheduled renewal - a no-op when TOTP auto-login isn't configured.
            _session.ClearAccessToken();
        }

        return new DhanApiResponse(false, statusCode, null, message ?? (isSuccess ? "Dhan returned an empty or unparseable body." : $"Dhan returned HTTP {(int)statusCode}."));
    }

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

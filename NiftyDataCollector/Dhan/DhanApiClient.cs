using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace NiftyDataCollector.Dhan;

/// <summary>One parsed Dhan REST response - owns the JsonDocument, so callers must dispose it.</summary>
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
/// The one place every Dhan REST call goes through - trimmed from OptionAnalytics.Server's own
/// DhanApiClient down to what a static-token-only collector needs: no auth-retry/TOTP-recovery
/// loop, since there is no session to recover here (see DhanOptions' own doc comment for why this
/// collector never logs in on its own). A stale/expired token simply fails every call until a
/// human pastes a fresh one into config and restarts - which is the correct behavior for a process
/// that must never trigger its own re-login against a shared account.
/// </summary>
public sealed class DhanApiClient
{
    private readonly HttpClient _httpClient;
    private readonly DhanOptions _options;
    private readonly ILogger<DhanApiClient> _logger;

    public DhanApiClient(HttpClient httpClient, IOptions<DhanOptions> options, ILogger<DhanApiClient> logger)
    {
        _httpClient = httpClient;
        _options = options.Value;
        _logger = logger;
    }

    public bool HasSession => _options.HasSession;

    public async Task<DhanApiResponse> SendAsync(HttpMethod method, string path, object? payload, string context, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(method, $"{_options.RestBaseUrl}{path}");
        request.Headers.TryAddWithoutValidation("access-token", _options.AccessToken);
        request.Headers.TryAddWithoutValidation("client-id", _options.ClientId);
        request.Headers.TryAddWithoutValidation("Accept", "application/json");

        if (payload is not null)
            request.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");

        try
        {
            using var response = await _httpClient.SendAsync(request, cancellationToken);
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            return Parse(response.StatusCode, body);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "Dhan request failed while {Context} ({Method} {Path})", context, method, path);
            return new DhanApiResponse(false, HttpStatusCode.ServiceUnavailable, null, ex.Message);
        }
    }

    private DhanApiResponse Parse(HttpStatusCode statusCode, string body)
    {
        JsonDocument? document = null;
        if (!string.IsNullOrWhiteSpace(body))
        {
            try { document = JsonDocument.Parse(body); }
            catch (JsonException) { document = null; }
        }

        var isSuccess = (int)statusCode is >= 200 and <= 299;
        if (isSuccess && document is not null) return new DhanApiResponse(true, statusCode, document, null);

        var message = ReadError(document, body);
        document?.Dispose();

        if (statusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden
            || (message?.Contains("invalid token", StringComparison.OrdinalIgnoreCase) ?? false))
        {
            _logger.LogError("Dhan authentication failed: {Message}. This collector never re-logs in on its own (see DhanOptions) - paste a fresh access token into config and restart.", message);
        }

        return new DhanApiResponse(false, statusCode, null, message ?? $"Dhan returned HTTP {(int)statusCode}.");
    }

    private static string? ReadError(JsonDocument? document, string rawBody)
    {
        if (document is null) return string.IsNullOrWhiteSpace(rawBody) ? null : Truncate(rawBody);

        var root = document.RootElement;
        if (root.ValueKind == JsonValueKind.Array && root.GetArrayLength() > 0) root = root[0];
        if (root.ValueKind != JsonValueKind.Object) return Truncate(rawBody);

        var message = root.TryGetProperty("errorMessage", out var m) ? m.GetString() : null;
        var type = root.TryGetProperty("errorType", out var t) ? t.GetString() : null;
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

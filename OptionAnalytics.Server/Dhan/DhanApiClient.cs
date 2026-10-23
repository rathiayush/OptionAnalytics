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
    internal TimeSpan AuthRetryDelay { get; init; } = TimeSpan.FromSeconds(3);

    private readonly HttpClient _httpClient;
    private readonly DhanOptions _options;
    private readonly DhanSession _session;
    private readonly ILogger<DhanApiClient> _logger;
    // Dhan's account-wide Data API limit (5 calls a second) - the ONE limiter every data call waits on. The callers take
    // the first attempt's slot themselves (in their own interactive / background lane); a data call sent again here, after
    // a stale token, takes another - so no call reaches Dhan's data endpoints without one.
    private readonly DhanDataApiRateLimiter? _dataApiLimiter;
    internal DhanDataApiRateLimiter? DataApiLimiter => _dataApiLimiter;

    public DhanApiClient(HttpClient httpClient, IOptions<DhanOptions> options, DhanSession session, ILogger<DhanApiClient> logger, DhanDataApiRateLimiter? dataApiLimiter = null)
    {
        _httpClient = httpClient;
        _options = options.Value;
        _session = session;
        _logger = logger;
        _dataApiLimiter = dataApiLimiter;
    }

    public bool HasSession => _session.IsAuthenticated;

    /// <summary>Dhan's Data APIs (charts, option chain, market quote): their documented bodies carry no dhanClientId - the
    /// account is the client-id header - unlike the trading APIs (orders, super orders), whose bodies do.</summary>
    internal static bool IsDataApi(string path) =>
        path.StartsWith("/charts/", StringComparison.OrdinalIgnoreCase)
        || path.StartsWith("/optionchain", StringComparison.OrdinalIgnoreCase)
        || path.StartsWith("/marketfeed", StringComparison.OrdinalIgnoreCase);

    /// <summary>What Dhan's GET /v2/profile says about the account (the parts that explain a refused Data API call): the
    /// Data API plan ("Active" / "Deactive") and until when, and until when the access token is valid.</summary>
    public sealed record DhanProfile(string? DataPlan, string? DataValidity, string? TokenValidity, string? ActiveSegment, DateTimeOffset ReadAtUtc)
    {
        public bool DataPlanActive => string.Equals(DataPlan, "Active", StringComparison.OrdinalIgnoreCase);
    }

    private static readonly TimeSpan ProfileMaxAge = TimeSpan.FromMinutes(10);
    private readonly SemaphoreSlim _profileLock = new(1, 1);
    private DhanProfile? _profile;

    /// <summary>The account's profile (GET /v2/profile), read at most once every 10 minutes - null when Dhan does not
    /// answer it.</summary>
    public async Task<DhanProfile?> GetProfileAsync(CancellationToken cancellationToken)
    {
        if (_profile is { } held && DateTimeOffset.UtcNow - held.ReadAtUtc < ProfileMaxAge) return held;
        await _profileLock.WaitAsync(cancellationToken);
        try
        {
            if (_profile is { } again && DateTimeOffset.UtcNow - again.ReadAtUtc < ProfileMaxAge) return again;
            using var response = await SendOnceAsync(HttpMethod.Get, "/profile", null, "reading the Dhan profile", cancellationToken);
            if (response.Success) _profile = ParseProfile(response.Root, DateTimeOffset.UtcNow);
            return _profile;
        }
        finally
        {
            _profileLock.Release();
        }
    }

    internal static DhanProfile ParseProfile(JsonElement root, DateTimeOffset readAtUtc)
    {
        string? Read(string name) => root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out var v) && v.ValueKind != JsonValueKind.Null ? v.ToString() : null;
        return new DhanProfile(Read("dataPlan"), Read("dataValidity"), Read("tokenValidity"), Read("activeSegment"), readAtUtc);
    }

    /// <summary>Added to a refused Data API call's error: what the account's profile says - the usual reasons every chart
    /// call is refused at once are a Data API plan that lapsed and a token past its validity.</summary>
    internal static string ProfileHint(DhanProfile profile) =>
        profile.DataPlanActive
            ? $" (Dhan profile: Data API plan Active{(profile.DataValidity is { } until ? $" until {until}" : "")}; token valid until {profile.TokenValidity ?? "?"})"
            : $" (Dhan profile: Data API plan is {profile.DataPlan ?? "not reported"}{(profile.DataValidity is { } validTo ? $" - valid until {validTo}" : "")} - Dhan's charts need an active Data API subscription; renew it in Dhan web -> DhanHQ APIs)";

    // A refused call worth explaining with the profile: an input / account / auth refusal - not a rate limit, a timeout or
    // a dropped connection, which say nothing about the account.
    private static bool WorthProfileHint(DhanApiResponse response) =>
        !response.Success && response.StatusCode is not HttpStatusCode.TooManyRequests and not HttpStatusCode.ServiceUnavailable and not HttpStatusCode.GatewayTimeout
        && response.ErrorMessage is { } message && !message.Contains("Rate_Limit", StringComparison.OrdinalIgnoreCase) && !message.Contains("Too many", StringComparison.OrdinalIgnoreCase);

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
            {
                if (!IsDataApi(path) || !WorthProfileHint(response)) return response;
                var profile = await GetProfileAsync(cancellationToken);
                if (profile is null) return response;
                var explained = new DhanApiResponse(false, response.StatusCode, null, response.ErrorMessage + ProfileHint(profile));
                response.Dispose();
                return explained;
            }

            _logger.LogInformation(
                "Dhan call ({Context}) hit a stale/invalid token - retrying in {Seconds}s to give a fresh one a chance to arrive (attempt {Attempt}/{Max}).",
                context, AuthRetryDelay.TotalSeconds, attempt, MaxAuthRetryAttempts);
            await Task.Delay(AuthRetryDelay, cancellationToken);
            // The retry is another call on Dhan's Data API limit: it waits for its own slot like every other.
            if (IsDataApi(path) && _dataApiLimiter is not null) await _dataApiLimiter.WaitForPermitAsync(interactive: true, cancellationToken);
        }
    }

    private async Task<DhanApiResponse> SendOnceAsync(HttpMethod method, string path, object? payload, string context, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(method, $"{_options.RestBaseUrl}{path}");
        request.Headers.TryAddWithoutValidation("access-token", _session.AccessToken ?? "");
        request.Headers.TryAddWithoutValidation("client-id", _session.ClientId ?? "");
        request.Headers.TryAddWithoutValidation("Accept", "application/json");

        if (payload is not null)
            request.Content = new StringContent(BodyFor(path, payload, _session.ClientId), Encoding.UTF8, "application/json");

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

    /// <summary>The request body: the payload as JSON, with dhanClientId first for a trading API (its documented bodies
    /// carry it) - never for a Data API, whose documented bodies do not (IsDataApi): Dhan answers a body it does not
    /// expect with Input_Exception (DH-905, "missing required fields, bad values for parameters").</summary>
    internal static string BodyFor(string path, object payload, string? clientId)
    {
        var json = JsonSerializer.Serialize(payload);
        if (string.IsNullOrEmpty(clientId) || IsDataApi(path)) return json;

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

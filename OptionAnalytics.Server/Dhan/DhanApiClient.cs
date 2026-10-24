using System.Net;
using System.Text;
using System.Text.Json;
using System.Threading.RateLimiting;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Services;
using Polly;
using Polly.RateLimiting;
using Polly.Retry;
using Polly.Timeout;

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

    /// <summary>How long a Data API call may wait for Dhan's answer once it is SENT - its wait for a slot on the rate
    /// limit is not counted (a long queue of chart downloads must not time out calls never sent). Much shorter than
    /// HttpClient's ~100 s default, which this client's HttpClient keeps for live orders: a slow / unresponsive Dhan
    /// once let one chart call hang ~100 s, and a day load of 44 of them past eight minutes.</summary>
    internal TimeSpan DataCallTimeout { get; init; } = TimeSpan.FromSeconds(20);

    /// <summary>Times a chart download Dhan answered "too many requests" is sent again - after 0.5 / 1 / 2 s.</summary>
    private const int MaxChartRateLimitRetries = 3;

    // What each step of the pipeline reads about the call (Polly's ResilienceContext properties).
    private static readonly ResiliencePropertyKey<DhanApiCategory> CategoryKey = new("dhan.category");
    private static readonly ResiliencePropertyKey<bool> InteractiveKey = new("dhan.interactive");
    private static readonly ResiliencePropertyKey<string> PathKey = new("dhan.path");
    private static readonly ResiliencePropertyKey<string> ContextKey = new("dhan.context");
    private static readonly ResiliencePropertyKey<bool> AuthRetryKey = new("dhan.authRetry");
    private static readonly ResiliencePropertyKey<string> RefusedKey = new("dhan.refused");
    private ResiliencePipeline<DhanApiResponse>? _pipeline;

    private readonly HttpClient _httpClient;

    /// <summary>The clock the market-hours check reads (the tests set it).</summary>
    internal Func<DateTimeOffset> Clock { get; init; } = () => DateTimeOffset.UtcNow;
    private readonly DhanOptions _options;
    private readonly DhanSession _session;
    private readonly ILogger<DhanApiClient> _logger;
    // Dhan's account-wide rate limits: every request - each attempt, retries included - takes its category's slot here
    // (DhanRestRateLimiter: orders, data, quotes, the rest; the pipeline's rate-limiter step), so no caller reaches Dhan
    // around it.
    private readonly DhanRestRateLimiter _rateLimiter;
    internal DhanRestRateLimiter RateLimiter => _rateLimiter;

    /// <summary><paramref name="rateLimiter"/>: the app's one shared limiter (a singleton - Dhan counts per account); a
    /// client built without it (tests, tools) gets a limiter of its own.</summary>
    public DhanApiClient(HttpClient httpClient, IOptions<DhanOptions> options, DhanSession session, ILogger<DhanApiClient> logger, DhanRestRateLimiter? rateLimiter = null)
    {
        _httpClient = httpClient;
        _options = options.Value;
        _session = session;
        _logger = logger;
        _rateLimiter = rateLimiter ?? DhanRestRateLimiter.Standalone(options);
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
    private DateTimeOffset? _profileAskedAt;

    /// <summary>The account's profile (GET /v2/profile), read at most once every 10 minutes - null when Dhan does not
    /// answer it.</summary>
    public async Task<DhanProfile?> GetProfileAsync(CancellationToken cancellationToken)
    {
        if (_profile is { } held && DateTimeOffset.UtcNow - held.ReadAtUtc < ProfileMaxAge) return held;
        await _profileLock.WaitAsync(cancellationToken);
        try
        {
            if (_profile is { } again && DateTimeOffset.UtcNow - again.ReadAtUtc < ProfileMaxAge) return again;
            // Asked at most once every ProfileMaxAge whatever the answer - every failed data call wants the profile, and a
            // run of them must not read it each time (the last good one is used meanwhile).
            if (_profileAskedAt is { } askedAt && DateTimeOffset.UtcNow - askedAt < ProfileMaxAge) return _profile;
            _profileAskedAt = DateTimeOffset.UtcNow;
            using var response = await SendThroughPipelineAsync(HttpMethod.Get, "/profile", null, "reading the Dhan profile", true, cancellationToken, authRetry: false);
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

    /// <summary>Sends one Dhan REST call through the pipeline (see Pipeline). A failed answer comes back as a failed
    /// response, never an exception: a call the rate limit refuses (Not sent: ...), a data call Dhan did not answer in
    /// DataCallTimeout, a refused data call explained with the account's profile. Only the caller's own cancellation throws.
    /// <paramref name="interactive"/>: a Data API call made for a waiting user (a page load) - false for a hosted service's
    /// background work, which goes after page loads (DhanDataApiRateLimiter).</summary>
    public async Task<DhanApiResponse> SendAsync(HttpMethod method, string path, object? payload, string context, CancellationToken cancellationToken, bool interactive = true)
    {
        var response = await SendThroughPipelineAsync(method, path, payload, context, interactive, cancellationToken);
        if (!IsDataApi(path) || !WorthProfileHint(response)) return response;
        var profile = await GetProfileAsync(cancellationToken);
        if (profile is null) return response;
        var explained = new DhanApiResponse(false, response.StatusCode, null, response.ErrorMessage + ProfileHint(profile));
        response.Dispose();
        return explained;
    }

    /// <summary>
    /// Every Dhan REST call's way out - a Polly pipeline, outermost first:
    ///  1. a stale / invalid token: sent again after AuthRetryDelay, up to MaxAuthRetryAttempts times (DhanTotpAutoRenewal
    ///     renews the token meanwhile) - every other failure comes back at once, retrying it would only repeat it;
    ///  2. a chart download (/charts/...) Dhan answered "too many requests": sent again after 0.5 / 1 / 2 s - never an
    ///     order (sending one twice could place it twice), nor the option chain (its own one call per 3 s);
    ///  3. the rate limit: the attempt takes its category's slot on the ONE shared DhanRestRateLimiter - or is refused;
    ///  4. a data call gets DataCallTimeout from when it is sent.
    /// Retries go round 3 and 4 again, so each attempt takes its own slot.
    /// </summary>
    private ResiliencePipeline<DhanApiResponse> Pipeline => _pipeline ??= new ResiliencePipelineBuilder<DhanApiResponse>()
        .AddRetry(new RetryStrategyOptions<DhanApiResponse>
        {
            ShouldHandle = args => ValueTask.FromResult(args.Context.Properties.GetValue(AuthRetryKey, true)
                && args.Outcome.Result is { Success: false } r && LooksLikeAuthFailure(r.StatusCode, r.ErrorMessage)),
            MaxRetryAttempts = MaxAuthRetryAttempts,
            Delay = AuthRetryDelay,
            BackoffType = DelayBackoffType.Constant,
            UseJitter = false,
            OnRetry = args =>
            {
                _logger.LogInformation(
                    "Dhan call ({Context}) hit a stale/invalid token - retrying in {Seconds}s to give a fresh one a chance to arrive (attempt {Attempt}/{Max}).",
                    args.Context.Properties.GetValue(ContextKey, ""), args.RetryDelay.TotalSeconds, args.AttemptNumber + 1, MaxAuthRetryAttempts);
                return default;
            },
        })
        .AddRetry(new RetryStrategyOptions<DhanApiResponse>
        {
            ShouldHandle = args => ValueTask.FromResult(args.Context.Properties.GetValue(PathKey, "").StartsWith("/charts/", StringComparison.OrdinalIgnoreCase)
                && args.Outcome.Result is { Success: false } r && DhanDataApiRateLimiter.IsRateLimited(r.StatusCode, r.ErrorMessage)),
            MaxRetryAttempts = MaxChartRateLimitRetries,
            Delay = TimeSpan.FromMilliseconds(500),
            BackoffType = DelayBackoffType.Exponential,
            UseJitter = false,
            OnRetry = args =>
            {
                var context = args.Context.Properties.GetValue(ContextKey, "");
                LoadProgress.RateLimited();
                LoadProgress.Retry();
                LoadProgress.Warn($"⚠ Dhan rate limit on {context} - {args.Outcome.Result?.ErrorMessage} - retry {args.AttemptNumber + 1}/{MaxChartRateLimitRetries} in {args.RetryDelay.TotalSeconds:0.0} s");
                _logger.LogInformation("Rate-limited on {Context} (attempt {Attempt}/{Max}) - retrying in {Delay}.", context, args.AttemptNumber + 1, MaxChartRateLimitRetries, args.RetryDelay);
                return default;
            },
        })
        .AddRateLimiter(new RateLimiterStrategyOptions
        {
            RateLimiter = args => _rateLimiter.AcquireAsync(args.Context.Properties.GetValue(CategoryKey, DhanApiCategory.NonTrading),
                args.Context.Properties.GetValue(InteractiveKey, true), args.Context.CancellationToken),
            OnRejected = args =>
            {
                if (args.Lease.TryGetMetadata(MetadataName.ReasonPhrase, out var reason) && reason is not null) args.Context.Properties.Set(RefusedKey, reason);
                return default;
            },
        })
        .AddTimeout(new TimeoutStrategyOptions
        {
            TimeoutGenerator = args => ValueTask.FromResult(args.Context.Properties.GetValue(CategoryKey, DhanApiCategory.NonTrading) == DhanApiCategory.Data
                ? DataCallTimeout : Timeout.InfiniteTimeSpan),
        })
        .Build();

    private async Task<DhanApiResponse> SendThroughPipelineAsync(HttpMethod method, string path, object? payload, string context, bool interactive,
        CancellationToken cancellationToken, bool authRetry = true)
    {
        // Background work (a hosted service's loop, the server scanner) outside market hours: not sent at all - no
        // positions, orders, chain or candles polled after the close (Services.MarketHours). A page's own request goes.
        if (Services.MarketHours.BlockReason(Clock()) is { } closed)
            return new DhanApiResponse(false, HttpStatusCode.ServiceUnavailable, null, closed);
        var category = DhanRestRateLimiter.CategoryOf(method, path);
        var resilience = ResilienceContextPool.Shared.Get(cancellationToken);
        try
        {
            resilience.Properties.Set(CategoryKey, category);
            resilience.Properties.Set(InteractiveKey, interactive);
            resilience.Properties.Set(PathKey, path);
            resilience.Properties.Set(ContextKey, context);
            resilience.Properties.Set(AuthRetryKey, authRetry);
            return await Pipeline.ExecuteAsync(
                static async (attempt, call) =>
                {
                    var answer = await call.Client.SendNowAsync(call.Method, call.Path, call.Payload, call.Context, attempt.CancellationToken);
                    call.Client._rateLimiter.Log(new DhanRestRateLimiter.DhanCall(DateTimeOffset.UtcNow, call.Category, call.Method.Method, call.Path, call.Context, answer.Success, answer.ErrorMessage));
                    // Dhan said "too many requests": that category's next calls are held back (the shared limiter).
                    if (!answer.Success && DhanDataApiRateLimiter.IsRateLimited(answer.StatusCode, answer.ErrorMessage)) call.Client._rateLimiter.NoteRateLimited(call.Category);
                    return answer;
                },
                resilience, (Client: this, Method: method, Path: path, Payload: payload, Context: context, Category: category));
        }
        catch (RateLimiterRejectedException)
        {
            var reason = resilience.Properties.GetValue(RefusedKey, "Not sent: over Dhan's rate limit.");
            _logger.LogWarning("Dhan call not sent ({Context}): {Reason}", context, reason);
            return new DhanApiResponse(false, HttpStatusCode.TooManyRequests, null, reason);
        }
        catch (TimeoutRejectedException)
        {
            _logger.LogWarning("Dhan call timed out after {Seconds}s with no response ({Context}).", DataCallTimeout.TotalSeconds, context);
            return new DhanApiResponse(false, HttpStatusCode.GatewayTimeout, null, $"Dhan did not respond within {DataCallTimeout.TotalSeconds:0}s - it may be slow or unreachable right now.");
        }
        finally
        {
            ResilienceContextPool.Shared.Return(resilience);
        }
    }

    private async Task<DhanApiResponse> SendNowAsync(HttpMethod method, string path, object? payload, string context, CancellationToken cancellationToken)
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

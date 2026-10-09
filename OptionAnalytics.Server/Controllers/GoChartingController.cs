using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Controllers;

/// <summary>GoCharting's order flow per bar (GoChartingStore): the webhook its alert posts to, the bars for the
/// Order Flow page's "GoCharting" view, and the setup (webhook URL + Lipi script) for an admin.</summary>
[ApiController]
[Route("api/gocharting")]
public sealed class GoChartingController : ControllerBase
{
    private readonly GoChartingStore _store;
    private readonly ILogger<GoChartingController> _logger;

    public GoChartingController(GoChartingStore store, ILogger<GoChartingController> logger)
    {
        _store = store;
        _logger = logger;
    }

    /// <summary>POST /api/gocharting/webhook/{token} - GoCharting's alert webhook (plain-text body, no login:
    /// the token in the URL is the secret). One finished bar per message.</summary>
    [HttpPost("webhook/{token}")]
    [AllowAnonymous]
    [RequestSizeLimit(8_192)]
    public async Task<IActionResult> Webhook(string token)
    {
        if (!_store.TokenMatches(token)) return NotFound();
        var body = await ReadBodyAsync();
        var (bar, error) = _store.Receive(body, DateTimeOffset.UtcNow);
        if (error is not null)
        {
            _logger.LogWarning("GoCharting webhook: message not understood ({Error}): {Body}", error, body.Length > 200 ? body[..200] : body);
            return BadRequest(new { error });
        }
        return Ok(new { stored = bar!.Underlying, time = bar.Time });
    }

    // The message whatever content type GoCharting sends it with: plain text / JSON as is; a form-encoded body
    // (which ASP.NET would otherwise parse as a form) re-joined into its text.
    private async Task<string> ReadBodyAsync()
    {
        if (Request.HasFormContentType)
        {
            var form = await Request.ReadFormAsync();
            return string.Join(' ', form.Select(kv => string.IsNullOrEmpty(kv.Value) ? kv.Key : $"{kv.Key}={kv.Value}"));
        }
        using var reader = new StreamReader(Request.Body);
        return await reader.ReadToEndAsync();
    }

    /// <summary>GET /api/gocharting/{underlying}/day/{date} - the bars GoCharting sent for that IST day.</summary>
    [HttpGet("{underlying}/day/{date}")]
    public IActionResult Day(string underlying, DateOnly date) =>
        Ok(new { underlying = underlying.ToUpperInvariant(), date, bars = _store.Day(underlying, date), lastReceivedUtc = _store.LastReceivedUtc });

    /// <summary>GET /api/gocharting/sdk - GoCharting's chart SDK for the Order Flow page's GoCharting footprint:
    /// its license key and script URL, or configured=false.</summary>
    [HttpGet("sdk")]
    public IActionResult Sdk()
    {
        var key = _store.SdkLicenseKey;
        return Ok(key is null
            ? new { configured = false, licenseKey = (string?)null, scriptUrl = (string?)null, fromConfig = false }
            : new { configured = true, licenseKey = (string?)key, scriptUrl = (string?)GoChartingStore.SdkScriptUrl(key), fromConfig = _store.SdkLicenseKeyFromConfig });
    }

    public sealed record SdkKeyRequest(string? LicenseKey);

    /// <summary>PUT /api/gocharting/sdk - an admin saves (or clears) the SDK license key GoCharting issued.</summary>
    [HttpPut("sdk")]
    [Authorize(Roles = AuthRoles.Admin)]
    public IActionResult SaveSdk([FromBody] SdkKeyRequest request)
    {
        if (_store.SdkLicenseKeyFromConfig) return Conflict(new { error = "The key is set in the server configuration (GoCharting:SdkLicenseKey) - change it there." });
        var error = _store.SaveSdkLicenseKey(request?.LicenseKey);
        return error is null ? Sdk() : BadRequest(new { error });
    }

    /// <summary>GET /api/gocharting/setup - what to paste into GoCharting: the webhook URL and the Lipi script.</summary>
    [HttpGet("setup")]
    [Authorize(Roles = AuthRoles.Admin)]
    public IActionResult Setup([FromQuery] string underlying = "NIFTY")
    {
        var u = GoChartingStore.Underlyings.Contains(underlying.ToUpperInvariant()) ? underlying.ToUpperInvariant() : "NIFTY";
        return Ok(new
        {
            webhookPath = $"/api/gocharting/webhook/{_store.Token}",
            script = GoChartingStore.LipiScript(u),
            lastReceivedUtc = _store.LastReceivedUtc,
            lastMessage = _store.LastMessage,
            lastError = _store.LastError,
        });
    }
}

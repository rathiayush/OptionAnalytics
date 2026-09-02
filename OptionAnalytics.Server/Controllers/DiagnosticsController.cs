using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Controllers;

/// <summary>
/// "Why isn't this working?" over HTTP. This app routinely runs somewhere its container logs are
/// not conveniently reachable (a Dokploy box behind a self-signed panel, say), and an
/// unauthenticated deployment looks identical from every other endpoint - spot price 0, no expiry,
/// no CDV - with nothing to say WHICH of the half-dozen possible causes it is. This reports the
/// cause directly.
///
/// It deliberately reports only whether each credential is PRESENT and well-formed, never its
/// value; the client id is masked to its first two and last two digits, which is enough to confirm
/// WHICH account the running container actually picked up (the single most useful fact when the
/// environment variables and the intended values have drifted apart) without disclosing it.
/// </summary>
[ApiController]
[Route("api/diagnostics")]
public sealed class DiagnosticsController : ControllerBase
{
    private readonly DhanOptions _options;
    private readonly DhanSession _session;

    public DiagnosticsController(IOptions<DhanOptions> options, DhanSession session)
    {
        _options = options.Value;
        _session = session;
    }

    [HttpGet("dhan")]
    public IActionResult GetDhanStatus()
    {
        var attempt = _session.LastAuthAttempt;

        return Ok(new
        {
            isAuthenticated = _session.IsAuthenticated,

            config = new
            {
                clientIdConfigured = !string.IsNullOrWhiteSpace(_options.ClientId),
                clientIdMasked = Mask(_options.ClientId),
                clientIdLength = _options.ClientId?.Length ?? 0,
                pinConfigured = !string.IsNullOrWhiteSpace(_options.Pin),
                pinLength = _options.Pin?.Length ?? 0,
                totpSecretConfigured = !string.IsNullOrWhiteSpace(_options.TotpSecret),
                totpSecretLength = _options.TotpSecret?.Length ?? 0,
                // A secret that is present but not valid base32 can never produce a working code -
                // worth separating from "present and usable", since the two look identical in a
                // config dump but fail very differently.
                totpSecretIsValidBase32 = IsUsableTotpSecret(_options.TotpSecret),
                staticAccessTokenConfigured = !string.IsNullOrWhiteSpace(_options.AccessToken),
                hasTotpCredentials = _options.HasTotpCredentials,
                authBaseUrl = _options.AuthBaseUrl,
            },

            lastAuthAttempt = attempt is null ? null : new
            {
                atUtc = attempt.AtUtc,
                secondsAgo = (int)(DateTimeOffset.UtcNow - attempt.AtUtc).TotalSeconds,
                success = attempt.Success,
                rateLimited = attempt.RateLimited,
                consecutiveFailures = attempt.ConsecutiveFailures,
                error = attempt.Error,
            },
        });
    }

    /// <summary>First two and last two characters only - enough to tell one account id from
    /// another at a glance, not enough to be one.</summary>
    private static string? Mask(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        if (value.Length <= 4) return new string('*', value.Length);
        return $"{value[..2]}{new string('*', value.Length - 4)}{value[^2..]}";
    }

    private static bool IsUsableTotpSecret(string? secret)
    {
        if (string.IsNullOrWhiteSpace(secret)) return false;
        try
        {
            TotpGenerator.GenerateCode(secret);
            return true;
        }
        catch (FormatException)
        {
            return false;
        }
    }
}

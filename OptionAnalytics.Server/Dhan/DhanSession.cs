using Microsoft.Extensions.Options;

namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// In-memory holder for the live Dhan access token, seeded from DhanOptions at construction.
/// Kept as its own class (rather than reading DhanOptions directly everywhere) so a future token
/// refresh path has one place to update.
/// </summary>
public sealed class DhanSession
{
    public DhanSession(IOptions<DhanOptions> options)
    {
        var o = options.Value;
        AccessToken = string.IsNullOrWhiteSpace(o.AccessToken) ? null : o.AccessToken;
        ClientId = string.IsNullOrWhiteSpace(o.ClientId) ? null : o.ClientId;
    }

    public string? AccessToken { get; set; }
    public string? ClientId { get; set; }

    public bool IsAuthenticated => !string.IsNullOrEmpty(AccessToken) && !string.IsNullOrEmpty(ClientId);
}

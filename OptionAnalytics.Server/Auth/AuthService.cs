using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;

namespace OptionAnalytics.Server.Auth;

/// <summary>Checks a submitted email/password against the two configured accounts (AuthOptions)
/// and reports which role matched, if any - the only thing AuthController needs to decide whether
/// to sign someone in.
///
/// Password comparison is constant-time (CryptographicOperations.FixedTimeEquals) rather than a
/// plain ==, which would let a timing attack narrow down a correct password one byte at a time;
/// email itself isn't secret, so it's matched with an ordinary case-insensitive comparison.</summary>
public sealed class AuthService
{
    private readonly AuthOptions _options;

    public AuthService(IOptions<AuthOptions> options)
    {
        _options = options.Value;
    }

    /// <summary>AuthRoles.Admin/User on a match, null otherwise - callers never learn WHICH part
    /// (email vs password) was wrong, only that the pair as a whole did not match anything.</summary>
    public string? TryAuthenticate(string? email, string? password)
    {
        if (string.IsNullOrEmpty(email) || string.IsNullOrEmpty(password)) return null;

        if (MatchesEmail(email, _options.AdminEmail) && MatchesPassword(password, _options.AdminPassword))
            return AuthRoles.Admin;

        if (MatchesEmail(email, _options.UserEmail) && MatchesPassword(password, _options.UserPassword))
            return AuthRoles.User;

        if (MatchesEmail(email, _options.ExternalEmail)
            && (string.IsNullOrEmpty(_options.ExternalPassword)
                ? MatchesPasswordHash(password, _options.ExternalPasswordHash)
                : MatchesPassword(password, _options.ExternalPassword)))
            return AuthRoles.External;

        return null;
    }

    private static bool MatchesEmail(string submitted, string configured) =>
        string.Equals(submitted.Trim(), configured.Trim(), StringComparison.OrdinalIgnoreCase);

    // A blank configured password (AuthOptions' own default, before Auth__AdminPassword/
    // Auth__UserPassword are actually set) never matches anything, submitted blank included - a
    // fresh deploy fails closed rather than silently accepting an empty password as valid.
    private static bool MatchesPassword(string submitted, string configured)
    {
        if (string.IsNullOrEmpty(configured)) return false;
        var submittedBytes = Encoding.UTF8.GetBytes(submitted);
        var configuredBytes = Encoding.UTF8.GetBytes(configured);
        return submittedBytes.Length == configuredBytes.Length && CryptographicOperations.FixedTimeEquals(submittedBytes, configuredBytes);
    }

    /// <summary>"pbkdf2-sha256$iterations$salt$hash" (salt and hash base64): the submitted password's PBKDF2-SHA256 equals
    /// the hash, compared in constant time. Blank or malformed never matches.</summary>
    internal static bool MatchesPasswordHash(string submitted, string configured)
    {
        var parts = (configured ?? "").Split('$');
        if (parts.Length != 4 || parts[0] != "pbkdf2-sha256" || !int.TryParse(parts[1], out var iterations) || iterations < 100_000) return false;
        try
        {
            var salt = Convert.FromBase64String(parts[2]);
            var expected = Convert.FromBase64String(parts[3]);
            if (salt.Length < 16 || expected.Length < 32) return false;
            var actual = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(submitted), salt, iterations, HashAlgorithmName.SHA256, expected.Length);
            return CryptographicOperations.FixedTimeEquals(actual, expected);
        }
        catch (FormatException) { return false; }
    }

    /// <summary>A hash for ExternalPasswordHash (the tests; to set a new password).</summary>
    internal static string HashPassword(string password, int iterations = 210_000)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var hash = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(password), salt, iterations, HashAlgorithmName.SHA256, 32);
        return $"pbkdf2-sha256${iterations}${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
    }
}

using System.Globalization;
using System.Security.Cryptography;

namespace NiftyDataCollector.Dhan;

/// <summary>
/// RFC 6238 TOTP code generation - the same algorithm Google Authenticator, Authy and Dhan's own
/// mobile app use, computed here instead of read off a phone screen so
/// DhanTotpAutoRenewalHostedService can log in with no human involved at all. Copied verbatim from
/// OptionAnalytics.Server's own TotpGenerator (itself verified against the official RFC 6238
/// Appendix B test vector) rather than shared - see this project's README for why this collector
/// duplicates Dhan code instead of referencing OptionAnalytics.Server.
///
/// The secret is whatever Dhan Web shows when you enable TOTP for API access (Profile -> DhanHQ
/// Trading APIs -> Setup TOTP) - treat it as a login credential, not a token: paired with the PIN
/// it lets whoever holds both mint a valid login code at will, indefinitely.
/// </summary>
public static class TotpGenerator
{
    private const int Digits = 6;
    private static readonly TimeSpan Step = TimeSpan.FromSeconds(30);
    private const string Base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    /// <summary>The current 6-digit TOTP code for <paramref name="base32Secret"/>, as of
    /// <paramref name="at"/> (defaults to now). Accepts the secret with or without spaces - Dhan
    /// Web displays it in 4-character groups for readability.</summary>
    public static string GenerateCode(string base32Secret, DateTimeOffset? at = null)
    {
        var key = Base32Decode(base32Secret);
        var counter = (long)((at ?? DateTimeOffset.UtcNow).ToUnixTimeSeconds() / Step.TotalSeconds);

        var counterBytes = BitConverter.GetBytes(counter);
        if (BitConverter.IsLittleEndian) Array.Reverse(counterBytes);

        using var hmac = new HMACSHA1(key);
        var hash = hmac.ComputeHash(counterBytes);

        var offset = hash[^1] & 0x0F;
        var binary =
            ((hash[offset] & 0x7F) << 24) |
            ((hash[offset + 1] & 0xFF) << 16) |
            ((hash[offset + 2] & 0xFF) << 8) |
            (hash[offset + 3] & 0xFF);

        var code = binary % (int)Math.Pow(10, Digits);
        return code.ToString(CultureInfo.InvariantCulture).PadLeft(Digits, '0');
    }

    private static byte[] Base32Decode(string input)
    {
        var cleaned = input.Replace(" ", "").Replace("-", "").TrimEnd('=').ToUpperInvariant();
        if (cleaned.Length == 0)
            throw new FormatException("TOTP secret is empty.");

        var bytes = new List<byte>(cleaned.Length * 5 / 8 + 1);
        var buffer = 0;
        var bitsInBuffer = 0;

        foreach (var c in cleaned)
        {
            var value = Base32Alphabet.IndexOf(c);
            if (value < 0)
                throw new FormatException($"'{c}' is not a valid base32 character in the TOTP secret.");

            buffer = (buffer << 5) | value;
            bitsInBuffer += 5;

            if (bitsInBuffer >= 8)
            {
                bitsInBuffer -= 8;
                bytes.Add((byte)((buffer >> bitsInBuffer) & 0xFF));
            }
        }

        return bytes.ToArray();
    }
}

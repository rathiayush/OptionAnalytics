using System.Net;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace OptionAnalytics.Server.Auth;

/// <summary>
/// How the server-side strategy scanner (scanner-runner, a Node process this server starts itself -
/// see ScannerRunnerHostedService) signs in: a random key made fresh at every start and handed only to
/// that child process, sent as the X-Runner-Key header, and accepted only from this machine (loopback).
/// It gets the "Runner" role - enough to read the market data, post the scanner log and send Telegram,
/// NOT Admin: it cannot reach the live-trading endpoints, so it can never place a real order.
/// </summary>
public sealed class ScannerRunnerKey
{
    public const string Header = "X-Runner-Key";
    public const string Scheme = "ScannerRunner";
    public const string Role = "Runner";

    public string Value { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));

    public bool Matches(string? presented) =>
        presented is { Length: > 0 } && CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(presented), Encoding.UTF8.GetBytes(Value));
}

public sealed class ScannerRunnerAuthenticationHandler : AuthenticationHandler<AuthenticationSchemeOptions>
{
    private readonly ScannerRunnerKey _key;

    public ScannerRunnerAuthenticationHandler(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder, ScannerRunnerKey key)
        : base(options, logger, encoder) => _key = key;

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (!Request.Headers.TryGetValue(ScannerRunnerKey.Header, out var presented)) return Task.FromResult(AuthenticateResult.NoResult());
        var remote = Context.Connection.RemoteIpAddress;
        if (remote is null || !IPAddress.IsLoopback(remote)) return Task.FromResult(AuthenticateResult.Fail("The scanner runner key is only accepted from this machine."));
        if (!_key.Matches(presented.ToString())) return Task.FromResult(AuthenticateResult.Fail("Wrong scanner runner key."));
        var identity = new ClaimsIdentity(new[] { new Claim(ClaimTypes.Name, "scanner-runner"), new Claim(ClaimTypes.Role, ScannerRunnerKey.Role) }, ScannerRunnerKey.Scheme);
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), ScannerRunnerKey.Scheme)));
    }
}

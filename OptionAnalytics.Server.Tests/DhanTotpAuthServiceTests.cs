using System.Net;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Tests;

/// <summary>Regression coverage for a real production issue: Dhan's account-level "too many
/// attempts" lockout (seen in the wild as "[RS-0060] Too many requests, please try again after some
/// time" - almost always caused by the calling server's own clock being out of sync, per Dhan's user
/// community, since TOTP codes are only valid for a ~30-second window) was previously NOT recognized
/// as anything other than a generic failure, so DhanTotpAutoRenewalHostedService retried it every
/// ~30 seconds - which, if the clock genuinely was skewed, just kept re-triggering the same lockout
/// forever. These tests cover the message-classification DhanTotpAuthService.GenerateAccessTokenAsync
/// now does, which the hosted service's own longer cooldown (see its own doc comment) depends on.</summary>
public sealed class DhanTotpAuthServiceTests
{
    private sealed class StubHandler : HttpMessageHandler
    {
        private readonly HttpStatusCode _status;
        private readonly string _body;

        public StubHandler(HttpStatusCode status, string body)
        {
            _status = status;
            _body = body;
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(_status) { Content = new StringContent(_body, Encoding.UTF8, "application/json") });
    }

    private static DhanTotpAuthService CreateService(HttpStatusCode status, string body)
    {
        var options = Options.Create(new DhanOptions
        {
            ClientId = "1000000001",
            Pin = "1234",
            TotpSecret = "JBSWY3DPEHPK3PXP", // a standard base32 test vector - any valid one works here
        });
        var httpClient = new HttpClient(new StubHandler(status, body));
        return new DhanTotpAuthService(httpClient, options, new DhanSession(options), NullLogger<DhanTotpAuthService>.Instance);
    }

    [Fact]
    public async Task GenerateAccessTokenAsync_ClassifiesTheDocumentedTwoMinuteThrottle_AsRateLimited_NotTooManyAttempts()
    {
        var service = CreateService(HttpStatusCode.OK, """{"status":"error","message":"Token can be generated once every 2 minutes."}""");

        var result = await service.GenerateAccessTokenAsync(CancellationToken.None);

        Assert.False(result.Success);
        Assert.True(result.RateLimited);
        Assert.False(result.TooManyAttempts);
    }

    [Fact]
    public async Task GenerateAccessTokenAsync_ClassifiesATooManyAttemptsLockout_Separately_OnA200Response()
    {
        var service = CreateService(HttpStatusCode.OK, """{"status":"error","message":"[RS-0060] Too many requests, please try again after some time"}""");

        var result = await service.GenerateAccessTokenAsync(CancellationToken.None);

        Assert.False(result.Success);
        Assert.False(result.RateLimited);
        Assert.True(result.TooManyAttempts);
    }

    [Fact]
    public async Task GenerateAccessTokenAsync_ClassifiesATooManyAttemptsLockout_AlsoOnANonSuccessHttpStatus()
    {
        // Dhan does not consistently answer this particular lockout with HTTP 200 - the
        // classification has to work whichever status code carries the message.
        var service = CreateService(HttpStatusCode.TooManyRequests, """{"status":"error","message":"Too many requests, please try again after some time"}""");

        var result = await service.GenerateAccessTokenAsync(CancellationToken.None);

        Assert.False(result.Success);
        Assert.True(result.TooManyAttempts);
    }

    [Fact]
    public async Task GenerateAccessTokenAsync_DoesNotMisclassifyAnUnrelatedFailure()
    {
        var service = CreateService(HttpStatusCode.OK, """{"status":"error","message":"Invalid PIN or TOTP."}""");

        var result = await service.GenerateAccessTokenAsync(CancellationToken.None);

        Assert.False(result.Success);
        Assert.False(result.RateLimited);
        Assert.False(result.TooManyAttempts);
    }

    [Fact]
    public async Task GenerateAccessTokenAsync_Succeeds_OnAWellFormedResponse()
    {
        var service = CreateService(HttpStatusCode.OK, """{"accessToken":"tok123","dhanClientId":"1000000001","expiryTime":"2026-01-01T00:00:00Z"}""");

        var result = await service.GenerateAccessTokenAsync(CancellationToken.None);

        Assert.True(result.Success);
        Assert.False(result.RateLimited);
        Assert.False(result.TooManyAttempts);
    }
}

using System.Net;
using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Tests;

/// <summary>Covers DhanApiClient.LooksLikeAuthFailure - the check that decides whether a failed
/// Dhan call gets SendAsync's own auto-retry (see its own doc comment) rather than being returned
/// to the caller on the first attempt. A real run confirmed Dhan does not always signal an invalid/
/// expired token with an actual 401/403 status - "Order_Error: Invalid Token" reached a caller as
/// this endpoint's own error body text instead, which is why this checks the message too, not just
/// the status code.</summary>
public sealed class DhanApiClientTests
{
    [Fact]
    public void UnauthorizedStatus_IsAnAuthFailure()
    {
        Assert.True(DhanApiClient.LooksLikeAuthFailure(HttpStatusCode.Unauthorized, "anything"));
    }

    [Fact]
    public void ForbiddenStatus_IsAnAuthFailure()
    {
        Assert.True(DhanApiClient.LooksLikeAuthFailure(HttpStatusCode.Forbidden, null));
    }

    [Fact]
    public void InvalidTokenMessage_IsAnAuthFailure_RegardlessOfStatusCode()
    {
        // The real case this exists for: a real run got "Order_Error: Invalid Token" back on some
        // OTHER status entirely, not 401/403.
        Assert.True(DhanApiClient.LooksLikeAuthFailure(HttpStatusCode.BadRequest, "Order_Error: Invalid Token"));
    }

    [Fact]
    public void InvalidTokenMessage_MatchesCaseInsensitively()
    {
        Assert.True(DhanApiClient.LooksLikeAuthFailure(HttpStatusCode.OK, "invalid TOKEN supplied"));
    }

    [Fact]
    public void UnrelatedErrorOnAnOrdinaryStatus_IsNotAnAuthFailure()
    {
        Assert.False(DhanApiClient.LooksLikeAuthFailure(HttpStatusCode.BadRequest, "Input_Exception: expiryCode is required"));
    }

    [Fact]
    public void NullMessageOnAnOrdinaryStatus_IsNotAnAuthFailure()
    {
        Assert.False(DhanApiClient.LooksLikeAuthFailure(HttpStatusCode.InternalServerError, null));
    }
}

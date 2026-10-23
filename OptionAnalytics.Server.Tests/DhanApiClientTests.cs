using System.Net;
using System.Text.Json;
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

    // ---- what is sent: a Data API body never carries dhanClientId (Dhan's documented bodies do not) ----

    [Fact]
    public void A_data_API_body_has_no_client_id_and_a_trading_body_does()
    {
        var chart = new { securityId = "13", exchangeSegment = "IDX_I", instrument = "INDEX", interval = "1", fromDate = "2026-10-23 09:15:00", toDate = "2026-10-23 11:04:00" };
        Assert.DoesNotContain("dhanClientId", DhanApiClient.BodyFor("/charts/intraday", chart, "1100000000"));
        Assert.DoesNotContain("dhanClientId", DhanApiClient.BodyFor("/charts/rollingoption", chart, "1100000000"));
        Assert.DoesNotContain("dhanClientId", DhanApiClient.BodyFor("/optionchain", new { UnderlyingScrip = 13 }, "1100000000"));
        Assert.Equal(JsonSerializer.Serialize(chart), DhanApiClient.BodyFor("/charts/intraday", chart, "1100000000"));

        var order = DhanApiClient.BodyFor("/orders", new { transactionType = "BUY", quantity = 75 }, "1100000000");
        Assert.StartsWith("{\"dhanClientId\":\"1100000000\"", order);
        Assert.Contains("\"quantity\":75", order);
        Assert.Contains("dhanClientId", DhanApiClient.BodyFor("/super/orders", new { quantity = 75 }, "1100000000"));
    }

    [Fact]
    public void Data_APIs_are_the_charts_option_chain_and_market_quote()
    {
        Assert.True(DhanApiClient.IsDataApi("/charts/intraday"));
        Assert.True(DhanApiClient.IsDataApi("/charts/historical"));
        Assert.True(DhanApiClient.IsDataApi("/optionchain/expirylist"));
        Assert.True(DhanApiClient.IsDataApi("/marketfeed/ltp"));
        Assert.False(DhanApiClient.IsDataApi("/orders"));
        Assert.False(DhanApiClient.IsDataApi("/super/orders"));
        Assert.False(DhanApiClient.IsDataApi("/profile"));
    }

    // ---- why a Data API call was refused: the account's profile (GET /v2/profile) ----

    [Fact]
    public void A_lapsed_data_plan_is_named_in_the_error()
    {
        using var doc = JsonDocument.Parse("""{"dhanClientId":"1100000000","tokenValidity":"24/10/2026 09:02","activeSegment":"Equity, Derivative","ddpi":"Active","mtf":"Deactive","dataPlan":"Deactive","dataValidity":"2026-10-22 23:59:59.0"}""");
        var profile = DhanApiClient.ParseProfile(doc.RootElement, DateTimeOffset.UtcNow);
        Assert.False(profile.DataPlanActive);
        var hint = DhanApiClient.ProfileHint(profile);
        Assert.Contains("Data API plan is Deactive", hint);
        Assert.Contains("2026-10-22 23:59:59.0", hint);
        Assert.Contains("renew", hint);
    }

    [Fact]
    public void An_active_plan_says_so_with_the_token_validity()
    {
        using var doc = JsonDocument.Parse("""{"tokenValidity":"24/10/2026 09:02","dataPlan":"Active","dataValidity":"2026-11-30 23:59:59.0"}""");
        var hint = DhanApiClient.ProfileHint(DhanApiClient.ParseProfile(doc.RootElement, DateTimeOffset.UtcNow));
        Assert.Contains("Data API plan Active until 2026-11-30 23:59:59.0", hint);
        Assert.Contains("token valid until 24/10/2026 09:02", hint);
    }
}

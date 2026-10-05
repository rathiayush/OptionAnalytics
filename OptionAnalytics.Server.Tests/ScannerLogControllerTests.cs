using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text.Encodings.Web;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Controllers;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>The scanner log over HTTP, through the real ScannerLogController: login is required, the
/// day is posted as the browser sends it, the two CSV files and the totals per underlying come back.
/// (Routing: the literal "summary" must win over the "{kind}" download route.)</summary>
public sealed class ScannerLogControllerTests : IAsyncLifetime
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "oa-scanner-log-http-" + Guid.NewGuid().ToString("n"));
    private WebApplication _app = null!;
    private HttpClient _client = null!;

    /// <summary>Signed in when the request carries an X-Test-User header.</summary>
    private sealed class TestAuth(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
        : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
    {
        protected override Task<AuthenticateResult> HandleAuthenticateAsync() =>
            Request.Headers.TryGetValue("X-Test-User", out var user)
                ? Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(
                    new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim(ClaimTypes.Name, user.ToString()) }, "Test")), "Test")))
                : Task.FromResult(AuthenticateResult.NoResult());
    }

    public async Task InitializeAsync()
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?> { ["Storage:ScannerLogPath"] = _dir });
        builder.Services.AddSingleton<ScannerLogStore>();
        builder.Services.AddControllers().AddApplicationPart(typeof(ScannerLogController).Assembly);
        builder.Services.AddAuthentication("Test").AddScheme<AuthenticationSchemeOptions, TestAuth>("Test", _ => { });
        builder.Services.AddAuthorization();
        _app = builder.Build();
        _app.UseAuthentication();
        _app.UseAuthorization();
        _app.MapControllers();
        await _app.StartAsync();
        _client = _app.GetTestClient();
        _client.DefaultRequestHeaders.Add("X-Test-User", "trader@x.in");
    }

    public async Task DisposeAsync()
    {
        _client.Dispose();
        await _app.DisposeAsync();
        try { Directory.Delete(_dir, recursive: true); } catch { /* best effort */ }
    }

    // The body the Order Flow page posts: one closed LONG signal (+40 futures points) and its option trade.
    private const string Day = """
        {"underlying":"NIFTY","date":"2026-10-05","source":"live",
         "signals":[{"time":1791178200000,"strategyNo":15,"strategyId":"ibBreakout","strategy":"Initial balance breakout","side":"LONG","entry":22700,"stop":22680,"target":22760,
           "confidence":67,"estimated":false,"dayType":"trend-up","dayTypePrice":"trend-up","voteOi":"agrees","voteCvd":null,"adaptiveTake":true,"adaptivePriceOnly":true,
           "adaptiveReason":"with the up trend","status":"win","r":2,"exitTime":1791179400000,"exitPrice":22740,"exitReason":"Target hit"}],
         "trades":[{"key":"p1","entryTime":1791178205000,"exitTime":1791179400000,"live":false,"action":"SELL","option":"PE","strike":22650,"lots":1,"lotSize":75,
           "entryPremium":100,"exitPremium":80,"points":20,"rupees":1500,"exitReason":"Target hit","signalTime":1791178200000,"strategyNo":15,"strategyId":"ibBreakout",
           "signalSide":"LONG","dayType":"trend-up","adaptiveTake":true,"adaptiveReason":"with the up trend","stt":11.25,"brokerage":40,"otherCharges":7,"netRupees":1441.75,"netPerLot":1441.75}]}
        """;

    [Fact]
    public async Task WithoutALogin_EveryRouteIsRefused()
    {
        using var anonymous = _app.GetTestClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/scanner-log/summary")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/scanner-log/signals")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.PostAsync("/api/scanner-log/day", new StringContent(Day, System.Text.Encoding.UTF8, "application/json"))).StatusCode);
    }

    [Fact]
    public async Task ADayIsPosted_ThenTheTotalsAndBothCsvFilesComeBack()
    {
        var post = await _client.PostAsync("/api/scanner-log/day", new StringContent(Day, System.Text.Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.OK, post.StatusCode);
        var posted = await post.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal((1, 1), (posted.GetProperty("signals").GetInt32(), posted.GetProperty("trades").GetInt32()));

        // The totals per underlying - "summary" is its own route, not the {kind} download.
        var summary = await _client.GetAsync("/api/scanner-log/summary");
        Assert.Equal(HttpStatusCode.OK, summary.StatusCode);
        var totals = (await summary.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("totals");
        var nifty = Assert.Single(totals.EnumerateArray());
        Assert.Equal("NIFTY", nifty.GetProperty("underlying").GetString());
        Assert.Equal((1, 40.0, 20.0, 1441.75), (nifty.GetProperty("signals").GetInt32(), nifty.GetProperty("futuresPoints").GetDouble(),
            nifty.GetProperty("optionPoints").GetDouble(), nifty.GetProperty("netRupees").GetDouble()));

        var csv = await _client.GetAsync("/api/scanner-log/summary/csv");
        Assert.Equal("text/csv", csv.Content.Headers.ContentType?.MediaType);
        var lines = (await csv.Content.ReadAsStringAsync()).Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(string.Join(',', ScannerLogStore.SummaryColumns), lines[0]);
        Assert.StartsWith("total,NIFTY,,1,1,1,100,40,2,1,0,0,20,1500,58.25,1441.75,1441.75,1,40,1,20,1441.75,1441.75,0,0,0,0,0", lines[^1]);

        var signals = await (await _client.GetAsync("/api/scanner-log/signals")).Content.ReadAsStringAsync();
        Assert.Contains(",points,", signals.Split('\n')[0]);
        Assert.Contains("ibBreakout", signals);
        var trades = await (await _client.GetAsync("/api/scanner-log/trades")).Content.ReadAsStringAsync();
        Assert.Contains("net_rupees", trades.Split('\n')[0]);
        Assert.Contains("1441.75", trades);
    }

    [Fact]
    public async Task AnUnknownFile_IsNotFound()
    {
        Assert.Equal(HttpStatusCode.NotFound, (await _client.GetAsync("/api/scanner-log/appsettings")).StatusCode);
    }
}

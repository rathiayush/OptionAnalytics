using System.Net;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>The server-side scanner's sign-in (its per-start key, from this machine only, as the Runner role -
/// never Admin) and its config store.</summary>
public sealed class ScannerRunnerTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "oa-runner-tests-" + Guid.NewGuid().ToString("n"));

    // The same scheme wiring as Program.cs: the key header goes to the runner scheme, anything else to the cookie.
    private static async Task<(TestServer Server, ScannerRunnerKey Key)> ServerAsync()
    {
        var key = new ScannerRunnerKey();
        var host = await new HostBuilder().ConfigureWebHost(web => web
            .UseTestServer()
            .ConfigureServices(services =>
            {
                services.AddSingleton(key);
                services.AddRouting();
                services.AddAuthentication(o => { o.DefaultScheme = "AppAuth"; o.DefaultChallengeScheme = CookieAuthenticationDefaults.AuthenticationScheme; })
                    .AddPolicyScheme("AppAuth", "", o => o.ForwardDefaultSelector = c => c.Request.Headers.ContainsKey(ScannerRunnerKey.Header) ? ScannerRunnerKey.Scheme : CookieAuthenticationDefaults.AuthenticationScheme)
                    .AddScheme<AuthenticationSchemeOptions, ScannerRunnerAuthenticationHandler>(ScannerRunnerKey.Scheme, _ => { })
                    .AddCookie(o =>
                    {
                        o.Events.OnRedirectToLogin = c => { c.Response.StatusCode = 401; return Task.CompletedTask; };
                        o.Events.OnRedirectToAccessDenied = c => { c.Response.StatusCode = 403; return Task.CompletedTask; };
                    });
                services.AddAuthorization(o => o.FallbackPolicy = new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build());
            })
            .Configure(app =>
            {
                app.UseRouting();
                app.UseAuthentication();
                app.UseAuthorization();
                app.UseEndpoints(e =>
                {
                    e.MapGet("/runner", () => "ok").RequireAuthorization(new AuthorizeAttribute { Roles = ScannerRunnerKey.Role });
                    e.MapGet("/admin", () => "ok").RequireAuthorization(new AuthorizeAttribute { Roles = AuthRoles.Admin });
                    e.MapGet("/any", () => "ok");
                });
            })).StartAsync();
        return (host.GetTestServer(), key);
    }

    private static Task<HttpContext> Get(TestServer server, string path, string? key, IPAddress? from) => server.SendAsync(c =>
    {
        c.Request.Path = path;
        c.Request.Method = "GET";
        if (key is not null) c.Request.Headers[ScannerRunnerKey.Header] = key;
        c.Connection.RemoteIpAddress = from;
    });

    [Fact]
    public async Task TheRightKeyFromThisMachine_IsTheRunner_ButNeverAnAdmin()
    {
        var (server, key) = await ServerAsync();
        Assert.Equal(200, (await Get(server, "/runner", key.Value, IPAddress.Loopback)).Response.StatusCode);
        Assert.Equal(200, (await Get(server, "/any", key.Value, IPAddress.IPv6Loopback)).Response.StatusCode);
        Assert.Equal(403, (await Get(server, "/admin", key.Value, IPAddress.Loopback)).Response.StatusCode);
    }

    [Fact]
    public async Task AWrongKey_OrAnyOtherMachine_OrNoKey_IsRefused()
    {
        var (server, key) = await ServerAsync();
        Assert.Equal(401, (await Get(server, "/any", "not-the-key", IPAddress.Loopback)).Response.StatusCode);
        Assert.Equal(401, (await Get(server, "/any", key.Value, IPAddress.Parse("10.0.0.7"))).Response.StatusCode);
        Assert.Equal(401, (await Get(server, "/runner", null, IPAddress.Loopback)).Response.StatusCode);
        Assert.NotEqual(new ScannerRunnerKey().Value, key.Value);
    }

    private sealed class FakeHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "Tests";
        public string ContentRootPath { get; set; } = "";
        public IFileProvider ContentRootFileProvider { get; set; } = null!;
    }

    private ScannerRunnerStore Store() => new(new FakeHostEnvironment { ContentRootPath = _dir },
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Storage:ScannerRunnerPath"] = _dir }).Build());

    [Fact]
    public void Config_EveryIndexOnByDefault_PatchesMerge_AndItSurvivesARestart()
    {
        var store = Store();
        var config = store.Config();
        Assert.All(ScannerRunnerStore.Underlyings, u => Assert.True(config["enabled"]![u]!.GetValue<bool>()));

        store.Update(new JsonObject { ["settings"] = new JsonObject { ["pick"] = "all" }, ["enabled"] = new JsonObject { ["SENSEX"] = false, ["FOO"] = false } });
        store.Update(new JsonObject { ["levels"] = new JsonObject { ["NIFTY"] = new JsonObject { ["sl"] = 15 } } });

        var again = Store().Config();
        Assert.Equal("all", again["settings"]!["pick"]!.GetValue<string>());
        Assert.False(again["enabled"]!["SENSEX"]!.GetValue<bool>());
        Assert.True(again["enabled"]!["NIFTY"]!.GetValue<bool>());
        Assert.Null(again["enabled"]!["FOO"]);
        Assert.Equal(15, again["levels"]!["NIFTY"]!["sl"]!.GetValue<int>());
    }

    [Fact]
    public void ASettingAppliedForOneIndex_SurvivesThePageSavingItsSettings_AndARestart_AndCanBeRemoved()
    {
        var store = Store();
        store.Update(new JsonObject { ["settings"] = new JsonObject { ["filters"] = new JsonObject { ["absorption"] = new JsonObject { ["tradeSide"] = "both" } } } });
        store.SetIndexFilters("NIFTY", "absorption", new JsonObject { ["tradeSide"] = "long", ["tradeOptLeg"] = "buy" });
        store.SetIndexFilters("BANKNIFTY", "absorption", new JsonObject { ["tradeSide"] = "short" });
        // A page (even one holding an older copy of the settings) saves its settings: the applied ones are untouched.
        store.Update(new JsonObject { ["settings"] = new JsonObject { ["pick"] = "all" } });
        var config = Store().Config();
        Assert.Equal("long", config["filtersByIndex"]!["NIFTY"]!["absorption"]!["tradeSide"]!.GetValue<string>());
        Assert.Equal("buy", config["filtersByIndex"]!["NIFTY"]!["absorption"]!["tradeOptLeg"]!.GetValue<string>());
        Assert.Equal("short", config["filtersByIndex"]!["BANKNIFTY"]!["absorption"]!["tradeSide"]!.GetValue<string>());
        // Removed: back to the all-index filters on that index only.
        store.SetIndexFilters("NIFTY", "absorption", null);
        config = Store().Config();
        Assert.Null(config["filtersByIndex"]!["NIFTY"]);
        Assert.Equal("short", config["filtersByIndex"]!["BANKNIFTY"]!["absorption"]!["tradeSide"]!.GetValue<string>());
    }

    [Fact]
    public void Status_IsStaleUntilTheRunnerReports()
    {
        var store = Store();
        Assert.True(JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(store.Status()))!["stale"]!.GetValue<bool>());
        store.SetStatus(new JsonObject { ["indices"] = new JsonArray() });
        store.SetProcess("running", null, 42);
        var status = JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(store.Status()))!;
        Assert.False(status["stale"]!.GetValue<bool>());
        Assert.Equal("running", status["process"]!["state"]!.GetValue<string>());
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, true); } catch { /* best effort */ }
    }
}

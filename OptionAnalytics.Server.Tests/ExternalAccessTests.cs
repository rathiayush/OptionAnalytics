using System.Net;
using System.Reflection;
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Controllers;
using OptionAnalytics.Server.Models;
using System.Text.Encodings.Web;

namespace OptionAnalytics.Server.Tests;

/// <summary>The External account: signs in with its hashed password, and reaches its own page's API only - every other
/// API, hub and controller is 403 for it (ExternalAccess).</summary>
public sealed class ExternalAccessTests
{
    [Fact]
    public void The_external_account_signs_in_with_the_hashed_password_and_nothing_else()
    {
        var auth = new AuthService(Options.Create(new AuthOptions
        {
            AdminPassword = "a", UserPassword = "u", ExternalEmail = "External@live.com", ExternalPasswordHash = AuthService.HashPassword("Secret#1"),
        }));

        Assert.Equal(AuthRoles.External, auth.TryAuthenticate("external@LIVE.com", "Secret#1"));
        Assert.Null(auth.TryAuthenticate("External@live.com", "Secret#2"));
        Assert.Null(auth.TryAuthenticate("External@live.com", ""));
        Assert.Null(auth.TryAuthenticate("admin@backtest.com", "Secret#1"));
    }

    [Fact]
    public void A_blank_or_malformed_hash_never_matches()
    {
        Assert.False(AuthService.MatchesPasswordHash("x", ""));
        Assert.False(AuthService.MatchesPasswordHash("x", "pbkdf2-sha256$10$AAAA$AAAA"));
        Assert.False(AuthService.MatchesPasswordHash("x", "plain"));
        Assert.False(AuthService.MatchesPasswordHash("x", "pbkdf2-sha256$210000$not base64$!!"));
    }

    [Fact]
    public void The_configured_hash_is_the_external_password()
    {
        var settings = System.Text.Json.JsonDocument.Parse(File.ReadAllText(Path.Combine(RepoRoot(), "OptionAnalytics.Server", "appsettings.json")));
        var authSection = settings.RootElement.GetProperty("Auth");
        Assert.Equal("External@live.com", authSection.GetProperty("ExternalEmail").GetString());
        Assert.False(authSection.TryGetProperty("ExternalPassword", out _)); // never in plain text
        Assert.True(AuthService.MatchesPasswordHash("External@111", authSection.GetProperty("ExternalPasswordHash").GetString()!));
    }

    [Theory]
    [InlineData("/api/external/NIFTY/heatmap", true)]
    [InlineData("/API/External/banknifty/oi-net", true)]
    [InlineData("/api/external/NIFTY/days", true)]
    [InlineData("/api/auth/me", true)]
    [InlineData("/api/auth/logout", true)]
    [InlineData("/api/version", true)]
    [InlineData("/", true)]
    [InlineData("/external", true)]
    [InlineData("/assets/index-abc.js", true)]
    [InlineData("/api/live-trading/orders", false)]
    [InlineData("/api/oi-replay/NIFTY/run", false)]
    [InlineData("/api/order-flow/NIFTY", false)]
    [InlineData("/api/system/dhan-calls", false)]
    [InlineData("/api", false)]
    [InlineData("/api/", false)]
    [InlineData("//api//trades", false)]
    [InlineData("/api%2Ftrades", false)]
    [InlineData("/apix", false)]
    [InlineData("/api/external/../trades", false)]
    [InlineData("/api/externalx/NIFTY", false)]
    [InlineData("/hubs/spot", true)]
    [InlineData("/hubs/spot/negotiate", true)]
    [InlineData("/hubs/spotx", false)]
    [InlineData("/hubs/other", false)]
    [InlineData("/swagger/index.html", false)]
    public void Only_its_own_api_and_the_page_shell_are_open(string path, bool allowed) =>
        Assert.Equal(allowed, ExternalAccess.Allows(new PathString(path)));

    [Fact]
    public void Every_other_controller_in_the_server_is_closed_to_it()
    {
        var routes = typeof(ExternalController).Assembly.GetTypes()
            .Where(t => typeof(ControllerBase).IsAssignableFrom(t) && !t.IsAbstract)
            .Select(t => (Type: t, Route: t.GetCustomAttribute<RouteAttribute>()?.Template))
            .Where(r => r.Route is not null)
            .ToList();
        Assert.NotEmpty(routes);
        foreach (var (type, route) in routes)
        {
            var open = ExternalAccess.Allows(new PathString("/" + route!.Replace("{", "x").Replace("}", "x") + "/x"));
            var expected = type == typeof(ExternalController) || type == typeof(AuthController);
            Assert.True(open == expected, $"{type.Name} ({route}) is {(open ? "open" : "closed")} to the External account");
        }
    }

    [Theory]
    [InlineData("External", "/api/trades", HttpStatusCode.Forbidden)]
    [InlineData("External", "/api/admin-only", HttpStatusCode.Forbidden)]
    [InlineData("External", "/hubs/other/negotiate", HttpStatusCode.Forbidden)]
    [InlineData("External", "/api/external/ok", HttpStatusCode.OK)]
    [InlineData("User", "/api/trades", HttpStatusCode.OK)]
    [InlineData("User", "/api/external/ok", HttpStatusCode.Forbidden)]
    [InlineData("Admin", "/api/external/ok", HttpStatusCode.OK)]
    public async Task The_fence_runs_before_the_endpoints(string role, string path, HttpStatusCode expected)
    {
        using var host = await new HostBuilder().ConfigureWebHost(web => web.UseTestServer()
            .ConfigureServices(services =>
            {
                services.AddRouting();
                services.AddAuthentication("Test").AddScheme<AuthenticationSchemeOptions, RoleHeaderHandler>("Test", _ => { });
                services.AddAuthorization();
            })
            .Configure(app =>
            {
                app.UseRouting();
                app.UseAuthentication();
                app.UseExternalAccessFence();
                app.UseAuthorization();
                app.UseEndpoints(e =>
                {
                    // An endpoint open to ANY signed-in account (a bare [Authorize]) - the fence still closes it to External.
                    e.MapGet("/api/trades", () => "trades").RequireAuthorization();
                    e.MapGet("/api/admin-only", () => "admin").RequireAuthorization(p => p.RequireRole(AuthRoles.Admin));
                    e.MapGet("/hubs/other/negotiate", () => "hub").RequireAuthorization();
                    e.MapGet("/api/external/ok", () => "ok").RequireAuthorization(p => p.RequireRole(AuthRoles.External, AuthRoles.Admin));
                });
            })).StartAsync();
        var client = host.GetTestClient();
        var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.Add("X-Test-Role", role);

        var response = await client.SendAsync(request);

        Assert.Equal(expected, response.StatusCode);
    }

    [Theory]
    [InlineData("of:NIFTY", true)]
    [InlineData("of:BANKNIFTY:2026-10-28", true)]
    [InlineData("c:NIFTY:N1", true)]
    [InlineData("c:BANKNIFTY:N1", true)]
    [InlineData("of:SENSEX", false)]
    [InlineData("c:NIFTY:N2", false)]
    [InlineData("of:NIFTY:tomorrow", false)]
    [InlineData("u:NIFTY", true)]
    [InlineData("u:BANKNIFTY", true)]
    [InlineData("u:SENSEX", false)]
    [InlineData("dom:NIFTY", false)]
    [InlineData("positions", false)]
    [InlineData("staff", false)]
    [InlineData("t:NIFTY", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void On_the_hub_it_may_join_only_its_pages_feeds(string? group, bool allowed) =>
        Assert.Equal(allowed, ExternalAccess.MayJoin(group));

    [Fact]
    public void Nothing_is_broadcast_to_every_connection()
    {
        // What used to go to Clients.All goes to SpotHub.StaffGroup, which the External account never joins.
        var server = Path.Combine(RepoRoot(), "OptionAnalytics.Server");
        var offenders = Directory.EnumerateFiles(server, "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}") && !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}"))
            .SelectMany(f => File.ReadLines(f).Select(line => (f, line)))
            .Where(x => !x.line.TrimStart().StartsWith("//") && (x.line.Contains("Clients.All") || x.line.Contains("Clients.AllExcept") || x.line.Contains("Clients.Others")))
            .Select(x => $"{Path.GetFileName(x.f)}: {x.line.Trim()}")
            .ToList();
        Assert.Empty(offenders);
    }

    [Fact]
    public void Its_oi_answer_is_only_time_strike_and_oi()
    {
        var t = new DateTimeOffset(2026, 10, 23, 9, 15, 0, IstClock.Offset);
        var cut = ExternalController.Cut(new[] { new OiReplayPoint(t, 25000, 1234, 12.5m, 101.5m, 100, 102, 99, 500) });

        Assert.Equal(new ExternalController.OiPoint(t, 25000, 1234), Assert.Single(cut));
        Assert.Equal(new[] { "Time", "Strike", "OpenInterest" }, typeof(ExternalController.OiPoint).GetProperties().Select(p => p.Name));
    }

    // ---- Which day the External page's OI shows --------------------------------------------------------------------

    private static OiReplayResult Run(DateOnly day, bool hasOi, bool success = true)
    {
        if (!success) return OiReplayResult.Failed("NIFTY", day, 1, "Dhan said no");
        var points = hasOi ? new[] { new OiReplayPoint(new DateTimeOffset(day.ToDateTime(new TimeOnly(9, 15)), IstClock.Offset), 25000, 100, null, 1) } : Array.Empty<OiReplayPoint>();
        return new OiReplayResult(true, null, "NIFTY", day, 1, 50, "WEEK", 1, Array.Empty<Candle>(), Array.Empty<Candle>(), points, points,
            Array.Empty<FuturesBar>(), null, false, null);
    }

    [Fact]
    public async Task On_a_weekday_with_OI_it_shows_today_live()
    {
        var friday = new DateOnly(2026, 10, 23);
        var asked = new List<(DateOnly, bool)>();
        var picked = await ExternalController.PickDayAsync(friday, (d, live) => { asked.Add((d, live)); return Task.FromResult(Run(d, true)); });
        Assert.Equal(friday, picked?.Day);
        Assert.Equal(new[] { (friday, true) }, asked);
    }

    [Theory]
    [InlineData(24)]   // Saturday
    [InlineData(25)]   // Sunday
    public async Task On_a_weekend_it_shows_the_last_trading_day_without_asking_for_today(int date)
    {
        var asked = new List<(DateOnly, bool)>();
        var picked = await ExternalController.PickDayAsync(new DateOnly(2026, 10, date), (d, live) => { asked.Add((d, live)); return Task.FromResult(Run(d, true)); });
        Assert.Equal(new DateOnly(2026, 10, 23), picked?.Day);   // Friday
        Assert.Equal(new[] { (new DateOnly(2026, 10, 23), false) }, asked);
    }

    [Fact]
    public async Task Before_the_open_or_on_a_holiday_it_steps_back_to_the_last_day_with_OI()
    {
        // Monday 26 Oct empty (before the open), Friday 23 Oct a holiday (empty) -> Thursday 22 Oct.
        var picked = await ExternalController.PickDayAsync(new DateOnly(2026, 10, 26), (d, _) => Task.FromResult(Run(d, d == new DateOnly(2026, 10, 22))));
        Assert.Equal(new DateOnly(2026, 10, 22), picked?.Day);
    }

    [Fact]
    public async Task A_failed_past_day_stops_the_walk()
    {
        var asked = new List<DateOnly>();
        var picked = await ExternalController.PickDayAsync(new DateOnly(2026, 10, 24), (d, _) => { asked.Add(d); return Task.FromResult(Run(d, true, success: false)); });
        Assert.Null(picked);
        Assert.Equal(new[] { new DateOnly(2026, 10, 23) }, asked);
    }

    [Fact]
    public void It_may_pick_today_or_the_last_five_trading_days_only()
    {
        // Saturday 24 Oct: Fri 23, Thu 22, Wed 21, Tue 20, Mon 19 - weekends skipped.
        Assert.Equal(new[] { 23, 22, 21, 20, 19 }.Select(d => new DateOnly(2026, 10, d)), ExternalController.AllowedPastDays(new DateOnly(2026, 10, 24)));
        // Tuesday 27 Oct: Mon 26, Fri 23, Thu 22, Wed 21, Tue 20.
        Assert.Equal(new[] { 26, 23, 22, 21, 20 }.Select(d => new DateOnly(2026, 10, d)), ExternalController.AllowedPastDays(new DateOnly(2026, 10, 27)));
    }

    [Fact]
    public void A_past_day_is_never_live_and_carries_only_time_strike_and_oi()
    {
        var day = new DateOnly(2026, 10, 22);
        var answer = ExternalController.PastAnswer("NIFTY", day, Run(day, true));
        Assert.False(answer.Live);
        Assert.Equal(day, answer.Date);
        Assert.Single(answer.CePoints);
        Assert.Empty(ExternalController.PastAnswer("NIFTY", day, Run(day, false)).CePoints);   // a holiday: no OI
    }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "OptionAnalytics.Server"))) dir = dir.Parent;
        return dir?.FullName ?? throw new DirectoryNotFoundException("repo root");
    }

    private sealed class RoleHeaderHandler(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
        : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
    {
        protected override Task<AuthenticateResult> HandleAuthenticateAsync()
        {
            if (!Request.Headers.TryGetValue("X-Test-Role", out var role)) return Task.FromResult(AuthenticateResult.NoResult());
            var identity = new ClaimsIdentity(new[] { new Claim(ClaimTypes.Name, "t"), new Claim(ClaimTypes.Role, role.ToString()) }, "Test");
            return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), "Test")));
        }
    }
}

using System.Net;
using System.Reflection;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Controllers;
using OptionAnalytics.Server.Services.Visitors;

namespace OptionAnalytics.Server.Tests;

/// <summary>The admin Visitors page's log: every account and visitors with no account, the place from the connection
/// - and never an address.</summary>
public sealed class VisitorLogTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "visitor-log-" + Guid.NewGuid().ToString("N"));
    private DateTimeOffset _now = new(2026, 10, 23, 11, 0, 0, IstClock.Offset);

    public void Dispose()
    {
        try { Directory.Delete(_dir, true); } catch (IOException) { }
    }

    private VisitorLog Log() => new(Path.Combine(_dir, "log"), NullLogger<VisitorLog>.Instance, () => _now);

    private static VisitEntry Page(string page, string? account = null, string? visitor = "visitor-1") =>
        new(default, "page", account, account is null ? null : "Admin", page, visitor, "Mumbai", "Maharashtra", "India", "Chrome · Windows");

    [Fact]
    public void Visits_are_kept_newest_first_with_their_place_and_device()
    {
        var log = Log();
        Assert.True(log.Record(Page("/oi-replay", "admin@x")));
        _now = _now.AddMinutes(1);
        Assert.True(log.Record(Page("/", account: null, visitor: "anon-123456")));
        var read = log.Read(1);
        Assert.Equal(2, read.Count);
        Assert.Null(read[0].Account);                     // a visitor with no account
        Assert.Equal("anon-123456", read[0].Visitor);
        Assert.Equal("admin@x", read[1].Account);
        Assert.Equal(("Mumbai", "Maharashtra", "India"), (read[1].City, read[1].Region, read[1].Country));
        Assert.Equal(_now.AddMinutes(-1), read[1].Time);
    }

    [Fact]
    public void The_same_page_again_within_a_minute_is_one_visit()
    {
        var log = Log();
        Assert.True(log.Record(Page("/oi-replay", "admin@x")));
        _now = _now.AddSeconds(30);
        Assert.False(log.Record(Page("/oi-replay", "admin@x")));
        Assert.True(log.Record(Page("/order-flow", "admin@x")));
        _now = _now.AddSeconds(31);
        Assert.True(log.Record(Page("/oi-replay", "admin@x")));
        Assert.Equal(3, log.Read(1).Count);
    }

    [Fact]
    public void Days_older_than_90_are_removed()
    {
        var log = Log();
        log.Record(Page("/"));
        _now = _now.AddDays(VisitorLog.KeepDays);
        log.Record(Page("/x"));
        Assert.Single(Directory.GetFiles(Path.Combine(_dir, "log")));
        Assert.Equal("/x", Assert.Single(log.Read(VisitorLog.KeepDays)).Page);
    }

    [Theory]
    [InlineData("/oi-replay", "/oi-replay")]
    [InlineData("/order-flow?tab=x#y", "/order-flow")]
    [InlineData("/", "/")]
    [InlineData("oi-replay", null)]
    [InlineData("/<script>", null)]
    [InlineData("https://evil/x", null)]
    [InlineData("", null)]
    public void Only_a_plain_page_path_is_taken(string page, string? expected) => Assert.Equal(expected, VisitorLog.CleanPage(page));

    [Theory]
    [InlineData("v-1a2b3c4d", "v-1a2b3c4d")]
    [InlineData("abc", null)]
    [InlineData("has space here", null)]
    public void Only_a_random_visitor_id_is_taken(string visitor, string? expected) => Assert.Equal(expected, VisitorLog.CleanVisitor(visitor));

    [Theory]
    [InlineData("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", "Chrome · Windows")]
    [InlineData("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", "Safari · iPhone")]
    [InlineData("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36", "Chrome · Android")]
    [InlineData("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0", "Edge · Windows")]
    [InlineData("curl/8.5.0", "Script / bot")]
    public void The_device_is_put_in_words(string ua, string expected) => Assert.Equal(expected, VisitRecorder.DeviceOf(ua));

    [Theory]
    [InlineData("172.18.0.5", "203.0.113.9", null, "203.0.113.9")]                 // behind the proxy: X-Real-IP
    [InlineData("172.18.0.5", null, "198.51.100.1, 203.0.113.9", "203.0.113.9")]    // the hop the proxy added, not the claimed one
    [InlineData("203.0.113.50", "1.1.1.1", "1.1.1.1", "203.0.113.50")]              // straight in: headers not trusted
    public void The_address_is_the_one_the_proxy_saw(string peer, string? realIp, string? forwarded, string expected)
    {
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Parse(peer);
        if (realIp is not null) context.Request.Headers["X-Real-IP"] = realIp;
        if (forwarded is not null) context.Request.Headers["X-Forwarded-For"] = forwarded;
        Assert.Equal(IPAddress.Parse(expected), ClientAddress.Of(context));
    }

    [Fact]
    public void No_address_is_ever_written_to_the_log()
    {
        var log = Log();
        using var geo = new GeoLocator(Path.Combine(_dir, "geo"));
        var recorder = new VisitRecorder(log, geo);
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Parse("172.18.0.5");
        context.Request.Headers["X-Real-IP"] = "203.0.113.77";
        context.Request.Headers["X-Forwarded-For"] = "203.0.113.77";
        recorder.Record(context, "page", "/", "visitor-1");

        var text = File.ReadAllText(Assert.Single(Directory.GetFiles(Path.Combine(_dir, "log"))));
        Assert.DoesNotContain("203.0.113.77", text);
        Assert.DoesNotContain("172.18.0.5", text);
        Assert.DoesNotContain(typeof(VisitEntry).GetProperties(), p => p.Name.Contains("Ip", StringComparison.OrdinalIgnoreCase) || p.Name.Contains("Address", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void A_private_address_reads_as_local_network_and_without_the_database_the_place_is_unknown()
    {
        using var geo = new GeoLocator(Path.Combine(_dir, "geo"));
        Assert.False(geo.Ready);
        Assert.Equal("Local network", geo.Locate(IPAddress.Parse("192.168.1.4"))?.Country);
        Assert.Null(geo.Locate(IPAddress.Parse("203.0.113.9")));
    }

    [Fact]
    public void Visitors_with_no_account_and_sign_ins_are_recorded()
    {
        var log = Log();
        using var geo = new GeoLocator(Path.Combine(_dir, "geo"));
        var controller = new AuthController(null!, NullLogger<AuthController>.Instance, new VisitRecorder(log, geo))
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
        };
        controller.Visit(new AuthController.VisitRequest("/", "anon-abcdef"));
        controller.Visit(new AuthController.VisitRequest("not a path", "anon-abcdef"));   // ignored
        var anon = Assert.Single(log.Read(1));
        Assert.Equal(("page", null, "anon-abcdef", "/"), (anon.Kind, anon.Account, anon.Visitor, anon.Page));

        controller.ControllerContext.HttpContext = new DefaultHttpContext
        {
            User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim(ClaimTypes.Name, "External@live.com"), new Claim(ClaimTypes.Role, AuthRoles.External) }, "test")),
        };
        _now = _now.AddMinutes(2);
        controller.Visit(new AuthController.VisitRequest("/", "anon-abcdef"));
        var signedIn = log.Read(1)[0];
        Assert.Equal(("External@live.com", AuthRoles.External), (signedIn.Account, signedIn.Role));
    }

    [Fact]
    public void Only_an_admin_reads_the_visitors()
    {
        var method = typeof(SystemController).GetMethod(nameof(SystemController.Visitors))!;
        Assert.Equal(AuthRoles.Admin, method.GetCustomAttribute<AuthorizeAttribute>()?.Roles);
        Assert.False(ExternalAccess.Allows("/api/system/visitors"));
        Assert.True(ExternalAccess.Allows("/api/auth/visit"));   // the External page reports its own visits too
    }
}

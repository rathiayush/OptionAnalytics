using System.Security.Claims;
using System.Text.Encodings.Web;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Auth;
using OptionAnalytics.Server.Hubs;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>OI Replay's sync across DEVICES (SpotHub.JoinReplaySync / ReplaySync): a message reaches the SAME account's other
/// connections only - never the sender, another account, the External account, or a connection that never joined - and
/// the group cannot be joined by name through JoinGroup.</summary>
public sealed class ReplaySyncHubTests : IAsyncLifetime
{
    private WebApplication _app = null!;
    private readonly List<HubConnection> _connections = new();

    private sealed class HeaderAuth(IOptionsMonitor<AuthenticationSchemeOptions> o, ILoggerFactory l, UrlEncoder e)
        : AuthenticationHandler<AuthenticationSchemeOptions>(o, l, e)
    {
        protected override Task<AuthenticateResult> HandleAuthenticateAsync()
        {
            var who = Request.Headers["X-Test-User"].ToString();
            if (string.IsNullOrEmpty(who)) return Task.FromResult(AuthenticateResult.NoResult());
            var parts = who.Split('|');
            var identity = new ClaimsIdentity([new Claim(ClaimTypes.Name, parts[0]), new Claim(ClaimTypes.Role, parts[1])], "Test");
            return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), "Test")));
        }
    }

    public async Task InitializeAsync()
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Services.AddAuthentication("Test").AddScheme<AuthenticationSchemeOptions, HeaderAuth>("Test", _ => { });
        builder.Services.AddSignalR();
        builder.Services.AddSingleton<LiveBroadcastBatcher>();
        _app = builder.Build();
        _app.UseAuthentication();
        _app.MapHub<SpotHub>("/hubs/spot");
        await _app.StartAsync();
    }

    public async Task DisposeAsync()
    {
        foreach (var c in _connections) await c.DisposeAsync();
        await _app.StopAsync();
        await _app.DisposeAsync();
    }

    private async Task<(HubConnection Connection, List<string> Got)> Connect(string? user)
    {
        var server = _app.GetTestServer();
        var got = new List<string>();
        var c = new HubConnectionBuilder()
            .WithUrl("http://localhost/hubs/spot", o =>
            {
                o.HttpMessageHandlerFactory = _ => server.CreateHandler();
                o.Transports = HttpTransportType.LongPolling;
                if (user is not null) o.Headers["X-Test-User"] = user;
            })
            .Build();
        c.On<JsonElement>(SpotHub.ReplaySyncEvent, m => { lock (got) got.Add(m.GetProperty("text").GetString()!); });
        await c.StartAsync();
        _connections.Add(c);
        return (c, got);
    }

    private static async Task Settle(Func<bool> done)
    {
        for (var i = 0; i < 100 && !done(); i++) await Task.Delay(30);
        await Task.Delay(150);
    }

    [Fact]
    public async Task A_message_reaches_the_accounts_other_devices_only()
    {
        var (laptop, laptopGot) = await Connect("Me@x.com|User");
        var (tablet, tabletGot) = await Connect("me@x.com|User");
        var (notJoined, notJoinedGot) = await Connect("me@x.com|User");
        var (other, otherGot) = await Connect("other@x.com|Admin");
        var (external, externalGot) = await Connect("me@x.com|External");
        var (anonymous, anonymousGot) = await Connect(null);

        Assert.True(await laptop.InvokeAsync<bool>("JoinReplaySync"));
        Assert.True(await tablet.InvokeAsync<bool>("JoinReplaySync"));
        Assert.True(await other.InvokeAsync<bool>("JoinReplaySync"));
        Assert.False(await external.InvokeAsync<bool>("JoinReplaySync"));
        Assert.False(await anonymous.InvokeAsync<bool>("JoinReplaySync"));
        // Not joinable by its name either.
        await external.InvokeAsync("JoinGroup", "rs:me@x.com");
        await anonymous.InvokeAsync("JoinGroup", "rs:me@x.com");
        await other.InvokeAsync("JoinGroup", "rs:me@x.com");

        await laptop.InvokeAsync("ReplaySync", new { type = "state", text = "from laptop" });
        await Settle(() => tabletGot.Count > 0);
        Assert.Equal(["from laptop"], tabletGot);
        Assert.Empty(laptopGot);
        Assert.Empty(notJoinedGot);
        Assert.Empty(otherGot);
        Assert.Empty(externalGot);
        Assert.Empty(anonymousGot);

        // Not an object, or far too large: dropped.
        await tablet.InvokeAsync("ReplaySync", "just text");
        await tablet.InvokeAsync("ReplaySync", new { text = new string('x', SpotHub.MaxReplaySyncChars) });
        // External sending: nothing.
        await external.InvokeAsync("ReplaySync", new { text = "from external" });
        await tablet.InvokeAsync("ReplaySync", new { text = "from tablet" });
        await Settle(() => laptopGot.Count > 0);
        Assert.Equal(["from tablet"], laptopGot);
        Assert.Equal(["from laptop"], tabletGot);

        // Left: no more.
        await tablet.InvokeAsync("LeaveReplaySync");
        await laptop.InvokeAsync("ReplaySync", new { text = "after leave" });
        await Task.Delay(300);
        Assert.Equal(["from laptop"], tabletGot);
    }
}

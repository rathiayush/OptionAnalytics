using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Hubs;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>ScannerEvents: the server scanner's trades, exits and P&amp;L reach the open pages the moment they change - the
/// runner's report when its signals / trades / P&amp;L differ (not for its clock alone) and at least every 30 s, every save of
/// the record, every live trade change (admins only) - through a real SignalR server, as the pages hear them.</summary>
public sealed class ScannerEventsTests
{
    private readonly List<(string Group, string Name, object Payload)> _sent = new();
    private DateTimeOffset _now = new(2026, 10, 13, 10, 0, 0, TimeSpan.FromHours(5.5));

    private ScannerEvents Events() => new((g, n, p) => { lock (_sent) _sent.Add((g, n, p)); return Task.CompletedTask; }, NullLogger<ScannerEvents>.Instance, () => _now);

    internal static JsonNode Report(string clock, double pnl, string? exitTime = null, int signals = 1) => JsonNode.Parse($$"""
        {"reportedUtc":"{{clock}}","indices":[{"underlying":"NIFTY","enabled":true,"ready":true,"clockUtc":"{{clock}}","pnl":{{pnl}},
          "signals":[{{string.Join(",", Enumerable.Range(0, signals).Select(i => $"{{\"id\":\"s{i}\",\"t\":{i}}}"))}}],
          "trades":[{"key":"s0-1-sell","premium":100,"current":{{100 - pnl / 75}},"rupees":{{pnl}},"exitTime":{{(exitTime is null ? "null" : $"\"{exitTime}\"")}}}]}]}
        """)!;

    [Fact]
    public void AReport_GoesToThePages_WhenItsTradesOrPnlChange_NotForTheRunnersClockAlone()
    {
        var events = Events();
        events.Status(Report("10:00:00", 150), new { n = 1 });
        events.Status(Report("10:00:02", 150), new { n = 2 });                      // only the clock moved
        Assert.Single(_sent);
        events.Status(Report("10:00:04", 225), new { n = 3 });                      // the P&L moved
        events.Status(Report("10:00:06", 225, signals: 2), new { n = 4 });          // a signal fired
        events.Status(Report("10:00:08", 300, exitTime: "10:00:08"), new { n = 5 }); // the trade exited
        Assert.Equal(new[] { 1, 3, 4, 5 }, _sent.Select(s => (int)((dynamic)s.Payload).n));
        Assert.All(_sent, s => Assert.Equal(("scanner", "scannerStatus"), (s.Group, s.Name)));

        // Nothing changed, but the page's "reported" time still moves now and then.
        _now = _now.AddSeconds(10);
        events.Status(Report("10:00:18", 300, exitTime: "10:00:08"), new { n = 6 });
        Assert.Equal(4, _sent.Count);
        _now = _now.Add(ScannerEvents.StatusHeartbeat);
        events.Status(Report("10:00:48", 300, exitTime: "10:00:08"), new { n = 7 });
        Assert.Equal(5, _sent.Count);
    }

    [Fact]
    public void ARecordSave_AndALiveChange_GoToTheirGroups()
    {
        var events = Events();
        events.Record("server", "NIFTY", "2026-10-13");
        events.Record(null, "BANKNIFTY", "2026-10-13");
        events.Live();
        Assert.Equal(("scanner", "scannerRecord"), (_sent[0].Group, _sent[0].Name));
        Assert.Equal("server", JsonSerializer.SerializeToNode(_sent[0].Payload)!["source"]!.GetValue<string>());
        Assert.Equal("page", JsonSerializer.SerializeToNode(_sent[1].Payload)!["source"]!.GetValue<string>());
        Assert.Equal(("scanner-live", "scannerLive"), (_sent[2].Group, _sent[2].Name));
    }

    [Fact]
    public void ASendThatFails_IsNeverThrown()
    {
        var events = new ScannerEvents((_, _, _) => throw new InvalidOperationException("hub down"), NullLogger<ScannerEvents>.Instance);
        events.Record("server", "NIFTY", "2026-10-13");
        var faulted = new ScannerEvents((_, _, _) => Task.FromException(new InvalidOperationException("hub down")), NullLogger<ScannerEvents>.Instance);
        faulted.Live();
    }
}

/// <summary>Tests that start a whole web app (a real SignalR server) run on their own, after the parallel ones - starting one
/// beside a timing-sensitive test (TickConsumerQueueTests) made that one fail more often.</summary>
[CollectionDefinition(nameof(OwnWebAppTests), DisableParallelization = true)]
public sealed class OwnWebAppTests;

/// <summary>Through a real SignalR server, as a page hears them: the scanner's status and record saves - and the live trades
/// only for an admin.</summary>
[Collection(nameof(OwnWebAppTests))]
public sealed class ScannerEventsHubTests
{
    private static JsonNode Report(string clock, double pnl) => ScannerEventsTests.Report(clock, pnl);

    [Fact]
    public async Task APage_HearsTheStatusAndTheRecord_ButOnlyAnAdminHearsTheLiveTrades()
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Services.AddSignalR();
        builder.Services.AddSingleton<LiveBroadcastBatcher>();
        builder.Services.AddSingleton<ScannerEvents>();
        await using var app = builder.Build();
        app.MapHub<SpotHub>("/hubs/spot");
        await app.StartAsync();
        var server = app.GetTestServer();
        await using var page = new HubConnectionBuilder()
            .WithUrl("http://localhost/hubs/spot", o => { o.HttpMessageHandlerFactory = _ => server.CreateHandler(); o.Transports = HttpTransportType.LongPolling; })
            .Build();
        var heard = new List<(string Name, JsonElement Payload)>();
        var arrived = new SemaphoreSlim(0);
        foreach (var name in new[] { "scannerStatus", "scannerRecord", "scannerLive" })
            page.On<JsonElement>(name, p => { lock (heard) heard.Add((name, p)); arrived.Release(); });
        await page.StartAsync();
        // What the page joins (scannerEvents.js) - "scanner-live" is refused to a page not signed in as an admin.
        await page.InvokeAsync("JoinGroup", ScannerEvents.Group);
        await page.InvokeAsync("JoinGroup", ScannerEvents.LiveGroup);

        var events = app.Services.GetRequiredService<ScannerEvents>();
        // In GET /status's own shape: the runner's report is a JsonNode inside it.
        events.Status(Report("10:00:00", 150), new { process = new { state = "running" }, stale = false, status = Report("10:00:00", 150) });
        events.Live();
        events.Record("server", "NIFTY", "2026-10-13");
        Assert.True(await arrived.WaitAsync(TimeSpan.FromSeconds(10)));
        Assert.True(await arrived.WaitAsync(TimeSpan.FromSeconds(10)));
        lock (heard)
        {
            Assert.Equal(new[] { "scannerStatus", "scannerRecord" }, heard.Select(h => h.Name));
            Assert.Equal(150, heard[0].Payload.GetProperty("status").GetProperty("indices")[0].GetProperty("pnl").GetInt32());
            Assert.Equal("server", heard[1].Payload.GetProperty("source").GetString());
            Assert.Equal("NIFTY", heard[1].Payload.GetProperty("underlying").GetString());
        }
        await app.StopAsync();
    }
}

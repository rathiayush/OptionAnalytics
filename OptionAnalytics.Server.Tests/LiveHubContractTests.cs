using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using OptionAnalytics.Server.Hubs;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>The live-data contract the browser pages depend on, exercised through a REAL SignalR
/// server (the real SpotHub + LiveBroadcastBatcher) and a real SignalR client making the same calls
/// the pages make: JoinGroup, ServerTime, AckLive, and the "liveBatch" event with its exact field
/// names. A server change that renames or reshapes any of these silently stops every open page from
/// updating (spot keeps ticking while options go quiet, or the reverse) - this fails first instead.</summary>
public sealed class LiveHubContractTests : IAsyncLifetime
{
    private WebApplication _app = null!;
    private HubConnection _connection = null!;
    private readonly List<JsonElement> _batches = new();
    private readonly SemaphoreSlim _batchArrived = new(0);

    private LiveBroadcastBatcher Batcher => _app.Services.GetRequiredService<LiveBroadcastBatcher>();

    public async Task InitializeAsync()
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Services.AddSignalR();
        builder.Services.AddSingleton<LiveBroadcastBatcher>();
        builder.Services.AddHostedService(sp => sp.GetRequiredService<LiveBroadcastBatcher>());
        _app = builder.Build();
        _app.MapHub<SpotHub>("/hubs/spot");
        await _app.StartAsync();

        var server = _app.GetTestServer();
        _connection = new HubConnectionBuilder()
            .WithUrl("http://localhost/hubs/spot", o =>
            {
                o.HttpMessageHandlerFactory = _ => server.CreateHandler();
                o.Transports = HttpTransportType.LongPolling;
            })
            .Build();
        _connection.On<JsonElement>("liveBatch", batch =>
        {
            lock (_batches) _batches.Add(batch);
            _batchArrived.Release();
        });
        await _connection.StartAsync();
    }

    public async Task DisposeAsync()
    {
        await _connection.DisposeAsync();
        await _app.StopAsync();
        await _app.DisposeAsync();
    }

    private static LiveOptionTick Leg(string flag, string side, decimal price, long oi) =>
        new("NIFTY", flag, 22700, side, price, price, price, price, oi, DateTimeOffset.UtcNow);

    [Fact]
    public async Task ServerTime_ReturnsTheServerClock()
    {
        var serverTime = await _connection.InvokeAsync<DateTimeOffset>("ServerTime");
        Assert.InRange((DateTimeOffset.UtcNow - serverTime).TotalSeconds, -5, 5);
    }

    [Fact]
    public async Task JoinedGroups_ReceiveSpotAndOptionTicks_WithTheFieldNamesThePagesRead()
    {
        await _connection.InvokeAsync("JoinGroup", "u:NIFTY");
        await _connection.InvokeAsync("JoinGroup", "c:NIFTY:N1");
        Batcher.SetLatest("u:NIFTY", "spotUpdate", "NIFTY", () => new { underlying = "NIFTY", lastPrice = 22700.5m });
        Batcher.Accumulate("c:NIFTY:N1", "oiReplayTicks", "22700:CE:1", Leg("N1", "CE", 101, 555000));
        Batcher.Accumulate("c:NIFTY:WEEK", "oiReplayTicks", "22700:CE:1", Leg("WEEK", "CE", 1, 1));

        Assert.True(await _batchArrived.WaitAsync(TimeSpan.FromSeconds(5)));
        var batch = _batches.Single();
        Assert.True(batch.TryGetProperty("sequence", out _));
        Assert.True(batch.TryGetProperty("sentAtUtc", out _));
        var items = batch.GetProperty("items").EnumerateArray().ToList();
        Assert.Contains(items, i => i.GetProperty("e").GetString() == "spotUpdate");
        var leg = Assert.Single(items.Single(i => i.GetProperty("e").GetString() == "oiReplayTicks").GetProperty("d").EnumerateArray());
        Assert.Equal("N1", leg.GetProperty("expiryFlag").GetString());
        Assert.Equal("CE", leg.GetProperty("side").GetString());
        Assert.Equal(22700m, leg.GetProperty("strike").GetDecimal());
        Assert.Equal(101m, leg.GetProperty("price").GetDecimal());
        Assert.Equal(555000, leg.GetProperty("openInterest").GetInt64());
        foreach (var field in new[] { "open", "high", "low", "time", "underlying" }) Assert.True(leg.TryGetProperty(field, out _), field);
    }

    [Fact]
    public async Task NextBatch_WaitsForAckLive_ThenCarriesTheNewestState()
    {
        await _connection.InvokeAsync("JoinGroup", "c:NIFTY:N1");
        Batcher.Accumulate("c:NIFTY:N1", "oiReplayTicks", "22700:CE:1", Leg("N1", "CE", 100, 1000));
        Assert.True(await _batchArrived.WaitAsync(TimeSpan.FromSeconds(5)));

        Batcher.Accumulate("c:NIFTY:N1", "oiReplayTicks", "22700:CE:1", Leg("N1", "CE", 120, 2000));
        Assert.False(await _batchArrived.WaitAsync(TimeSpan.FromSeconds(1)));

        await _connection.SendAsync("AckLive", _batches[0].GetProperty("sequence").GetInt64());
        Assert.True(await _batchArrived.WaitAsync(TimeSpan.FromSeconds(5)));
        var leg = _batches[1].GetProperty("items").EnumerateArray().Single().GetProperty("d").EnumerateArray().Single();
        Assert.Equal(2000, leg.GetProperty("openInterest").GetInt64());
        Assert.Equal(120m, leg.GetProperty("high").GetDecimal());
    }
}

using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;

namespace OptionAnalytics.Server.Tests;

/// <summary>Dhan's 200-level depth socket, against a local stand-in for wss://full-depth-api.dhan.co/twohundreddepth:
/// the login and subscribe Dhan documents, its packets parsed, and a connection that stays silent in market hours
/// (an account not entitled when it subscribed - a plan bought during the day) opened and subscribed again.</summary>
public sealed class TwoHundredDepthReconnectTests
{
    [Fact]
    public async Task A_silent_connection_subscribes_again_and_the_200_level_book_then_arrives()
    {
        var connections = 0;
        var subscribes = new ConcurrentQueue<string>();
        var queries = new ConcurrentQueue<string>();
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseKestrel().UseUrls("http://127.0.0.1:0");
        await using var app = builder.Build();
        app.UseWebSockets();
        app.Map("/twohundreddepth", async (HttpContext context) =>
        {
            using var socket = await context.WebSockets.AcceptWebSocketAsync();
            var n = Interlocked.Increment(ref connections);
            queries.Enqueue(context.Request.QueryString.Value ?? "");
            var buffer = new byte[1024];
            var request = await socket.ReceiveAsync(buffer, CancellationToken.None);
            subscribes.Enqueue(Encoding.UTF8.GetString(buffer, 0, request.Count));
            // The first connection is accepted and left silent (not entitled yet); the next one gets the book.
            if (n > 1) await socket.SendAsync(BookPacket(48704, isBid: true, rows: 200), WebSocketMessageType.Binary, true, CancellationToken.None);
            try { while (socket.State == WebSocketState.Open) await socket.ReceiveAsync(buffer, context.RequestAborted); }
            catch { /* the client went away */ }
        });
        await app.StartAsync();
        var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();

        var options = Options.Create(new DhanOptions { ClientId = "1100000000", AccessToken = "token-abc", FullDepthWsUrl = address.Replace("http", "ws") + "/twohundreddepth" });
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["OrderFlow:MaxTwoHundredDepth"] = "2" }).Build();
        var client = new DhanTwoHundredDepthClient(options, new DhanSession(options), NullLogger<DhanTwoHundredDepthClient>.Instance, config)
        {
            SilentReconnectAfter = TimeSpan.FromMilliseconds(400),
            MarketOpen = _ => true,
        };
        var book = new TaskCompletionSource<DepthSidePacket>(TaskCreationOptions.RunContinuationsAsynchronously);
        client.DepthUpdated += packet => book.TrySetResult(packet);
        await client.StartAsync(CancellationToken.None);
        try
        {
            Assert.True(client.Subscribe(48704, "NSE_FNO"));
            var packet = await book.Task.WaitAsync(TimeSpan.FromSeconds(20));

            Assert.Equal(2, connections); // the silent one, then a new subscribe
            Assert.True(packet.IsBid);
            Assert.Equal(200, packet.Depth);
            Assert.Equal(200, packet.Levels.Length);
            Assert.Equal(25600.00m, packet.Levels[0].Price);
            Assert.Equal(25580.10m, packet.Levels[^1].Price);
            Assert.True(client.IsStreaming(48704));
            // Logged in through the URL, one instrument subscribed as Dhan documents.
            Assert.All(queries, q => Assert.Equal("?token=token-abc&clientId=1100000000&authType=2", q));
            Assert.All(subscribes, s => Assert.Equal("{\"RequestCode\":23,\"ExchangeSegment\":\"NSE_FNO\",\"SecurityId\":\"48704\"}", s));
        }
        finally
        {
            await client.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public void A_book_is_expected_in_NSE_hours_only()
    {
        DateTimeOffset Ist(int day, int h, int m) => new(2026, 10, day, h, m, 0, IstClock.Offset);
        Assert.True(DhanTwoHundredDepthClient.InMarketHours(Ist(23, 9, 15)));
        Assert.True(DhanTwoHundredDepthClient.InMarketHours(Ist(23, 15, 29)));
        Assert.False(DhanTwoHundredDepthClient.InMarketHours(Ist(23, 9, 14)));
        Assert.False(DhanTwoHundredDepthClient.InMarketHours(Ist(23, 15, 30)));
        Assert.False(DhanTwoHundredDepthClient.InMarketHours(Ist(24, 11, 0))); // Saturday
    }

    // One side of a 200-level book as Dhan sends it: a 12-byte header (length, 41 bid / 51 ask, segment, security id,
    // number of rows) and 16 bytes a row (price float64, quantity uint32, orders uint32), little endian.
    private static byte[] BookPacket(uint securityId, bool isBid, int rows)
    {
        var packet = new byte[12 + rows * 16];
        BinaryPrimitives.WriteUInt16LittleEndian(packet.AsSpan(0, 2), (ushort)packet.Length);
        packet[2] = isBid ? DhanDepthPacketParser.BidCode : DhanDepthPacketParser.AskCode;
        packet[3] = 2; // NSE_FNO
        BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(4, 4), securityId);
        BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(8, 4), (uint)rows);
        for (var i = 0; i < rows; i++)
        {
            var at = 12 + i * 16;
            BinaryPrimitives.WriteDoubleLittleEndian(packet.AsSpan(at, 8), 25600 - i * 0.1);
            BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(at + 8, 4), 75u * (uint)(i + 1));
            BinaryPrimitives.WriteUInt32LittleEndian(packet.AsSpan(at + 12, 4), (uint)(i % 7 + 1));
        }
        return packet;
    }
}

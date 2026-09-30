using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Flush is the whole delivery contract with the timer and SignalR taken out. The property
/// that matters to a trader: a connection that is slow to acknowledge never accumulates a backlog -
/// it gets the NEWEST state next time, with nothing lost that a chart needs (open/high/low).</summary>
public sealed class LiveBroadcastBatcherTests
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 30, 4, 30, 0, TimeSpan.Zero);

    private static LiveBroadcastBatcher NewBatcher() => new(null, NullLogger<LiveBroadcastBatcher>.Instance);

    private static LiveOptionTick Leg(decimal price, long oi = 100) =>
        new("NIFTY", "N1", 25000, "CE", price, price, price, price, oi, T0);

    private static List<LiveOptionTick> Legs(LiveBatch batch) =>
        batch.Items.Where(i => i.E == "oiReplayTicks").SelectMany(i => ((IEnumerable<object>)i.D).Cast<LiveOptionTick>()).ToList();

    [Fact]
    public void SetLatest_SendsOnlyTheNewestPerKey_BuiltOncePerFlush()
    {
        var batcher = NewBatcher();
        batcher.Join("a", "u:NIFTY");
        var built = 0;
        for (var i = 1; i <= 50; i++)
        {
            var value = i;
            batcher.SetLatest("u:NIFTY", "spotUpdate", "NIFTY", () => { built++; return value; });
        }

        var (connection, batch) = Assert.Single(batcher.Flush(T0));

        Assert.Equal("a", connection);
        Assert.Equal(new LiveBatchItem("spotUpdate", 50), Assert.Single(batch.Items));
        Assert.Equal(1, built);
    }

    [Fact]
    public void OnlyMembersOfAGroupReceiveIt()
    {
        var batcher = NewBatcher();
        batcher.Join("dashboard", "cdv:NIFTY");
        batcher.Join("oiReplay", "u:NIFTY");
        batcher.SetLatest("cdv:NIFTY", "cdvUpdate", "selected", () => "cdv");

        var (connection, _) = Assert.Single(batcher.Flush(T0));
        Assert.Equal("dashboard", connection);
    }

    [Fact]
    public void AnUnacknowledgedConnection_GetsNothingMore_ThenOnlyTheNewestOnceItAcks()
    {
        var batcher = NewBatcher();
        batcher.Join("phone", "u:NIFTY");
        batcher.SetLatest("u:NIFTY", "spotUpdate", "NIFTY", () => 1);
        var first = Assert.Single(batcher.Flush(T0)).Batch;

        // Twenty more flushes' worth of ticks while the phone hasn't acked: nothing is sent, nothing queues.
        for (var i = 2; i <= 21; i++)
        {
            var value = i;
            batcher.SetLatest("u:NIFTY", "spotUpdate", "NIFTY", () => value);
            Assert.Empty(batcher.Flush(T0.AddMilliseconds(200 * i)));
        }

        batcher.Ack("phone", first.Sequence);
        var next = Assert.Single(batcher.Flush(T0.AddMilliseconds(4500))).Batch;

        Assert.Equal(new LiveBatchItem("spotUpdate", 21), Assert.Single(next.Items));
        Assert.True(next.Sequence > first.Sequence);
    }

    [Fact]
    public void ConflatedLegs_KeepTheFirstOpenAndWidenHighLow_AcrossSkippedFlushes()
    {
        var batcher = NewBatcher();
        batcher.Join("phone", "c:NIFTY:N1");
        batcher.Accumulate("c:NIFTY:N1", "oiReplayTicks", "25000:CE:1", Leg(100));
        var first = Assert.Single(batcher.Flush(T0)).Batch;

        batcher.Accumulate("c:NIFTY:N1", "oiReplayTicks", "25000:CE:1", Leg(104));
        Assert.Empty(batcher.Flush(T0.AddMilliseconds(300)));
        batcher.Accumulate("c:NIFTY:N1", "oiReplayTicks", "25000:CE:1", Leg(120));
        batcher.Accumulate("c:NIFTY:N1", "oiReplayTicks", "25000:CE:1", Leg(90));
        Assert.Empty(batcher.Flush(T0.AddMilliseconds(600)));
        batcher.Accumulate("c:NIFTY:N1", "oiReplayTicks", "25000:CE:1", Leg(101, oi: 777));

        batcher.Ack("phone", first.Sequence);
        var leg = Assert.Single(Legs(Assert.Single(batcher.Flush(T0.AddMilliseconds(900))).Batch));

        Assert.Equal((104m, 101m, 120m, 90m, 777L), (leg.Open, leg.Price, leg.High, leg.Low, leg.OpenInterest));
    }

    [Fact]
    public void AStaleAck_DoesNotReleaseTheConnection()
    {
        var batcher = NewBatcher();
        batcher.Join("a", "u:NIFTY");
        batcher.SetLatest("u:NIFTY", "spotUpdate", "NIFTY", () => 1);
        var first = Assert.Single(batcher.Flush(T0)).Batch;

        batcher.Ack("a", first.Sequence - 1);
        batcher.SetLatest("u:NIFTY", "spotUpdate", "NIFTY", () => 2);

        Assert.Empty(batcher.Flush(T0.AddSeconds(1)));
    }

    [Fact]
    public void ALostAck_TimesOut_SoAConnectionIsNeverStuck()
    {
        var batcher = NewBatcher();
        batcher.Join("a", "u:NIFTY");
        batcher.SetLatest("u:NIFTY", "spotUpdate", "NIFTY", () => 1);
        Assert.Single(batcher.Flush(T0));

        batcher.SetLatest("u:NIFTY", "spotUpdate", "NIFTY", () => 2);
        Assert.Empty(batcher.Flush(T0 + LiveBroadcastBatcher.AckTimeout - TimeSpan.FromMilliseconds(1)));
        Assert.Single(batcher.Flush(T0 + LiveBroadcastBatcher.AckTimeout));
    }

    [Fact]
    public void AFastConnection_IsNotHeldBackByASlowOne()
    {
        var batcher = NewBatcher();
        batcher.Join("fast", "u:NIFTY");
        batcher.Join("slow", "u:NIFTY");
        batcher.SetLatest("u:NIFTY", "spotUpdate", "NIFTY", () => 1);
        var sent = batcher.Flush(T0);
        batcher.Ack("fast", sent.Single(s => s.ConnectionId == "fast").Batch.Sequence);

        batcher.SetLatest("u:NIFTY", "spotUpdate", "NIFTY", () => 2);
        var second = batcher.Flush(T0.AddMilliseconds(300));

        Assert.Equal("fast", Assert.Single(second).ConnectionId);
    }

    [Fact]
    public void LeaveAndDisconnect_StopDelivery()
    {
        var batcher = NewBatcher();
        batcher.Join("a", "u:NIFTY");
        batcher.Join("b", "u:NIFTY");
        batcher.Leave("a", "u:NIFTY");
        batcher.Disconnected("b");
        batcher.SetLatest("u:NIFTY", "spotUpdate", "NIFTY", () => 1);

        Assert.Empty(batcher.Flush(T0));
        Assert.False(batcher.HasMembers("u:NIFTY"));
    }

    [Fact]
    public void Batch_SerializesEntriesWithTheirRealFields_OnTheWire()
    {
        var batcher = NewBatcher();
        batcher.Join("a", "c:NIFTY:N1");
        batcher.Accumulate("c:NIFTY:N1", "oiReplayTicks", "25000:CE:1", Leg(101, oi: 555));

        var batch = Assert.Single(batcher.Flush(T0)).Batch;
        // SignalR's JSON hub protocol uses the Web (camelCase) defaults.
        var json = JsonSerializer.Serialize(batch, new JsonSerializerOptions(JsonSerializerDefaults.Web));

        Assert.Contains("\"e\":\"oiReplayTicks\"", json);
        Assert.Contains("\"openInterest\":555", json);
        Assert.Contains("\"strike\":25000", json);
        Assert.Contains("\"sequence\":1", json);
    }

    [Fact]
    public void AFailingFactory_DoesNotDropTheOtherMessages()
    {
        var batcher = NewBatcher();
        batcher.Join("a", "u:NIFTY");
        batcher.SetLatest("u:NIFTY", "spotUpdate", "NIFTY", () => throw new InvalidOperationException());
        batcher.SetLatest("u:NIFTY", "futuresTicksX", "k", () => "ok");

        var batch = Assert.Single(batcher.Flush(T0)).Batch;
        Assert.Equal(new LiveBatchItem("futuresTicksX", "ok"), Assert.Single(batch.Items));
    }
}

public sealed class DhanOptionChainQuotesParseTests
{
    [Fact]
    public void Parse_ReadsImpliedVolatility_AndTreatsZeroAsMissing()
    {
        using var doc = JsonDocument.Parse("""
        {"data":{"last_price":25010.5,"oc":{
          "25000.000000":{"ce":{"last_price":120.5,"oi":150000,"implied_volatility":12.34},"pe":{"last_price":98.0,"oi":180000,"implied_volatility":0}},
          "25050.000000":{"ce":{"last_price":90.0,"oi":1000.0}}
        }}}
        """);

        var quotes = DhanOptionChainQuotes.Parse(doc.RootElement).OrderBy(q => q.Strike).ToList();

        Assert.Equal(12.34m, quotes[0].CeImpliedVolatility);
        Assert.Null(quotes[0].PeImpliedVolatility);
        Assert.Equal(150000, quotes[0].CeOpenInterest);
        Assert.Null(quotes[1].CeImpliedVolatility);
        Assert.Null(quotes[1].PeLastPrice);
    }
}

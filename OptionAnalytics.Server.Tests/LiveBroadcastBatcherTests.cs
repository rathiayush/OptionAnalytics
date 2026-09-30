using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>Drain is the whole batching contract with the timer and SignalR taken out: latest-wins
/// per key, factories evaluated only at flush, accumulated entries merged per key and sent as one
/// array per (group, event), and nothing sent twice.</summary>
public sealed class LiveBroadcastBatcherTests
{
    private static LiveBroadcastBatcher NewBatcher() => new(null!, NullLogger<LiveBroadcastBatcher>.Instance);

    private sealed record Leg(string Key, decimal Price, decimal High, decimal Low, int Ticks);

    [Fact]
    public void SetLatest_KeepsOnlyTheNewestPerKey_AndBuildsItAtFlushTime()
    {
        var batcher = NewBatcher();
        var built = 0;
        for (var i = 1; i <= 50; i++)
        {
            var value = i;
            batcher.SetLatest("u:NIFTY", "cdvUpdate", "selected", () => { built++; return value; });
        }

        var messages = batcher.Drain();

        Assert.Single(messages);
        Assert.Equal(("u:NIFTY", "cdvUpdate", (object)50), (messages[0].Group, messages[0].Event, messages[0].Payload));
        Assert.Equal(1, built);
    }

    [Fact]
    public void SetLatest_DifferentKeysAndGroups_AreSentSeparately()
    {
        var batcher = NewBatcher();
        batcher.SetLatest("u:NIFTY", "cdvExpiryUpdate", "2026-10-06", () => "a");
        batcher.SetLatest("u:NIFTY", "cdvExpiryUpdate", "2026-10-13", () => "b");
        batcher.SetLatest("u:SENSEX", "cdvUpdate", "selected", () => "c");

        Assert.Equal(3, batcher.Drain().Count);
    }

    [Fact]
    public void Accumulate_MergesPerKey_AndSendsOneArrayPerGroupAndEvent()
    {
        var batcher = NewBatcher();
        void Tick(string key, decimal price) => batcher.Accumulate<Leg>("c:NIFTY:N1", "oiReplayTicks", key, prev =>
            new Leg(key, price, prev is null ? price : Math.Max(prev.High, price), prev is null ? price : Math.Min(prev.Low, price), (prev?.Ticks ?? 0) + 1));

        Tick("25000:CE", 100); Tick("25000:CE", 112); Tick("25000:CE", 95); Tick("25000:CE", 101);
        Tick("25050:PE", 80);

        var messages = batcher.Drain();

        var message = Assert.Single(messages);
        var legs = Assert.IsAssignableFrom<IEnumerable<object>>(message.Payload).Cast<Leg>().ToList();
        Assert.Equal(2, legs.Count);
        var ce = legs.Single(l => l.Key == "25000:CE");
        Assert.Equal((101m, 112m, 95m, 4), (ce.Price, ce.High, ce.Low, ce.Ticks));
    }

    [Fact]
    public void Drain_ClearsEverything_SoNothingIsSentTwice()
    {
        var batcher = NewBatcher();
        batcher.SetLatest("u:NIFTY", "cdvUpdate", "selected", () => 1);
        batcher.Accumulate<Leg>("c:NIFTY:N1", "oiReplayTicks", "k", _ => new Leg("k", 1, 1, 1, 1));

        Assert.Equal(2, batcher.Drain().Count);
        Assert.Empty(batcher.Drain());
    }

    [Fact]
    public void Drain_AFailingFactory_DoesNotDropTheOtherMessages()
    {
        var batcher = NewBatcher();
        batcher.SetLatest("u:NIFTY", "cdvUpdate", "selected", () => throw new InvalidOperationException());
        batcher.SetLatest("u:SENSEX", "cdvUpdate", "selected", () => "ok");

        var message = Assert.Single(batcher.Drain());
        Assert.Equal("ok", message.Payload);
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

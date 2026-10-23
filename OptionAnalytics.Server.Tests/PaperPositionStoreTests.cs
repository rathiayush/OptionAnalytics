using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;
using OptionAnalytics.Server.Controllers;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Tests;

/// <summary>OI Replay's paper positions kept on the server per account and day (PaperPositionStore) - every browser the
/// account opens shows the same positions; they used to live in one browser's localStorage.</summary>
public sealed class PaperPositionStoreTests : IDisposable
{
    private static readonly DateOnly Day = new(2026, 10, 21);
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "paper-positions-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    private PaperPositionStore Store() => new(_dir, NullLogger<PaperPositionStore>.Instance);

    private static JsonObject Position(string id, string status = "OPEN", decimal? exit = null) => new()
    {
        ["id"] = id, ["side"] = "CE", ["strike"] = 25600, ["direction"] = "BUY", ["qtyLots"] = 1, ["lotSize"] = 75,
        ["entryPrice"] = 120.5m, ["status"] = status, ["exitPrice"] = exit,
    };

    [Fact]
    public void Another_browser_sees_the_same_positions_and_a_restart_keeps_them()
    {
        var store = Store();
        Assert.False(store.Get("a@x.in", Day).Exists);

        var (saved, error) = store.Change("a@x.in", Day, new[] { Position("1"), Position("2") }, null, clear: false);
        Assert.Null(error);
        Assert.Equal(1, saved!.Version);

        var again = Store().Get("A@x.in ", Day); // a fresh store (a restart), the same account however it is typed
        Assert.True(again.Exists);
        Assert.Equal(new[] { "1", "2" }, again.Positions.Select(p => (string)p["id"]!));
        Assert.Empty(Store().Get("other@x.in", Day).Positions); // another account has its own
        Assert.Empty(Store().Get("a@x.in", Day.AddDays(1)).Positions); // and another day starts empty
    }

    [Fact]
    public void A_closed_position_stays_as_it_closed_first()
    {
        var store = Store();
        store.Change("a", Day, new[] { Position("1") }, null, false);
        store.Change("a", Day, new[] { Position("1", "CLOSED", 100m) }, null, false);   // browser A: SL hit at 100
        var (after, _) = store.Change("a", Day, new[] { Position("1", "CLOSED", 99.5m) }, null, false); // browser B, a moment later
        var late = store.Change("a", Day, new[] { Position("1") }, null, false).Result;  // a stale page still holding it OPEN

        Assert.Equal(100m, (decimal)after!.Positions[0]["exitPrice"]!);
        Assert.Equal("CLOSED", (string)late!.Positions[0]["status"]!);
        Assert.Equal(2, late.Version); // neither later change changed anything
    }

    [Fact]
    public void Remove_and_clear_and_unchanged_upserts()
    {
        var store = Store();
        store.Change("a", Day, new[] { Position("1"), Position("2"), Position("3") }, null, false);
        var same = store.Change("a", Day, new[] { Position("2") }, null, false).Result!;
        Assert.Equal(1, same.Version); // nothing new - no new version

        var removed = store.Change("a", Day, null, new[] { "2" }, false).Result!;
        Assert.Equal(new[] { "1", "3" }, removed.Positions.Select(p => (string)p["id"]!));

        var cleared = store.Change("a", Day, null, null, clear: true).Result!;
        Assert.Empty(cleared.Positions);
        Assert.True(Store().Get("a", Day).Exists); // cleared is still kept: a browser with old ones must not bring them back
    }

    [Fact]
    public void Bad_changes_are_refused_whole()
    {
        var store = Store();
        var noId = new JsonObject { ["status"] = "OPEN" };
        var (_, error) = store.Change("a", Day, new[] { Position("1"), noId }, null, false);
        Assert.NotNull(error);
        Assert.False(store.Get("a", Day).Exists);

        var huge = Position("2");
        huge["note"] = new string('x', PaperPositionStore.MaxPositionBytes);
        Assert.NotNull(store.Change("a", Day, new[] { huge }, null, false).Error);
    }

    [Fact]
    public void A_keyed_telegram_message_goes_once_a_day()
    {
        var day = new DateOnly(2030, 1, 1);
        Assert.True(TelegramOnce.First(null, day));
        Assert.True(TelegramOnce.First(null, day));
        Assert.True(TelegramOnce.First("paper-exit-test-1", day));
        Assert.False(TelegramOnce.First("paper-exit-test-1", day));
        Assert.True(TelegramOnce.First("paper-exit-test-1", day.AddDays(1)));
    }
}

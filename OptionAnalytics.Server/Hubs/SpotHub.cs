using Microsoft.AspNetCore.SignalR;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.Hubs;

/// <summary>Push hub for every live event this app broadcasts (spotUpdate, oiReplayTick,
/// futuresTick, oiRestSnapshot, cdvUpdate, cdvBarClosed, confluenceAlert - see each broadcaster's
/// own SendAsync call for which). Originally pure broadcast-to-everyone (Clients.All) on the
/// reasoning "only two underlyings streamed at once" - no longer true once OI Replay/Live OI's 5
/// tracked (underlying, expiryFlag) combos, CDV, and futures were added on top: a client viewing
/// just NIFTY Weekly was still receiving (and discarding, client-side) every tick for every OTHER
/// underlying/expiry/futures contract too. SignalR Groups fix this at the SOURCE - a client only
/// receives what it actually asked to join, never something it has to filter out itself.
///
/// Two group naming conventions, matched to how each event is actually scoped - see each
/// broadcaster's own GroupNames helper for which applies:
///  - "u:{underlying}" - spotUpdate, confluenceAlert, cdvUpdate, cdvBarClosed, futuresTick (futures
///    has no expiryFlag concept - OiReplayLiveFeedService.FuturesUnderlyings is a plain underlying
///    list).
///  - "c:{underlying}:{expiryFlag}" - oiReplayTick, oiRestSnapshot (both genuinely tied to one
///    strike band for one specific expiry).
///
/// JoinGroup/LeaveGroup are intentionally generic (any string, not validated against a known list)
/// - the hub has no business knowing every caller's own naming scheme, only enforcing that a
/// connection only receives groups it explicitly asked to join. A client must re-join after every
/// reconnect (a new connection gets a new ConnectionId with no group membership at all) - each
/// frontend hook's own onreconnected handler already re-syncs its full state the same way, so
/// re-joining its current group(s) there is the same "resync from scratch" shape, not a new one.
///
/// High-frequency state (spot, option legs, futures, CDV) no longer goes to the SignalR groups
/// directly - it is conflated per connection and delivered as "liveBatch" (see
/// LiveBroadcastBatcher), which is why every join/leave is mirrored there and why the browser acks
/// each batch via AckLive. Rare one-off events (confluenceAlert, cdvBarClosed, oiRestSnapshot, the
/// raw "t:" tick tape) still use the plain groups.</summary>
public sealed class SpotHub : Hub
{
    private readonly LiveBroadcastBatcher _batcher;

    public SpotHub(LiveBroadcastBatcher batcher) => _batcher = batcher;

    public Task JoinGroup(string groupName)
    {
        _batcher.Join(Context.ConnectionId, groupName);
        return Groups.AddToGroupAsync(Context.ConnectionId, groupName);
    }

    public Task LeaveGroup(string groupName)
    {
        _batcher.Leave(Context.ConnectionId, groupName);
        return Groups.RemoveFromGroupAsync(Context.ConnectionId, groupName);
    }

    /// <summary>This server's clock, for the browser to estimate its own clock offset (NTP-style,
    /// from the round trip) - what lets a page show its true delay behind the market rather than
    /// only changes in it.</summary>
    public DateTimeOffset ServerTime() => DateTimeOffset.UtcNow;

    /// <summary>The browser has applied liveBatch <paramref name="sequence"/> and can take the next.</summary>
    public void AckLive(long sequence) => _batcher.Ack(Context.ConnectionId, sequence);

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        _batcher.Disconnected(Context.ConnectionId);
        return base.OnDisconnectedAsync(exception);
    }
}

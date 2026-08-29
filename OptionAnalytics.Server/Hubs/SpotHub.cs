using Microsoft.AspNetCore.SignalR;

namespace OptionAnalytics.Server.Hubs;

/// <summary>Pure push hub - the server broadcasts SpotSnapshot updates (see
/// SpotFeedHostedService.BroadcastAsync) and clients only ever listen on "spotUpdate". No
/// client-invokable methods are needed since there's nothing to subscribe/unsubscribe to with
/// only two underlyings streamed at once.</summary>
public sealed class SpotHub : Hub
{
}

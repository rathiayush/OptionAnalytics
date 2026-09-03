namespace OptionAnalytics.Server.Dhan;

/// <summary>What to do about a feed that has gone quiet.</summary>
public enum FeedRecoveryAction
{
    /// <summary>Nothing is wrong, or nothing can be concluded yet.</summary>
    None,

    /// <summary>Send the subscriptions again on the SAME connection. Always tried first: it is
    /// cheap, it repairs the most likely cause (a subscription Dhan never acted on), and unlike
    /// reconnecting it opens no new socket - so it cannot contribute to the connection-count limit
    /// Dhan answers with 805.</summary>
    Resubscribe,

    /// <summary>Tear the socket down and reconnect. Only for a connection that HAD been delivering
    /// and then went silent even after a re-subscribe - i.e. the connection itself is the
    /// problem.</summary>
    Reconnect,
}

/// <summary>
/// Decides whether the market feed has gone quiet and what to do about it. Ported from
/// LiveSpreadCalculator, which learned this the hard way.
///
/// The old watchdog here had one rule - "no data for 45s, abort the socket" - and that is actively
/// harmful on Dhan. Two different failures need two different answers:
///
///  1. A connection that WAS delivering and stopped. Likely half-open (a load balancer or NAT
///     dropped it without a close frame), so the fix ends in a reconnect - but a re-subscribe is
///     tried first, because it is far cheaper and sometimes enough.
///
///  2. A connection that has delivered NOTHING since it was established. Reconnecting is the WRONG
///     answer here and is what turns a blip into an outage. Dhan authorises a socket
///     asynchronously AFTER the handshake, so subscriptions sent immediately on connect can arrive
///     before authorisation and simply be ignored - the feed then looks perfectly healthy and never
///     ticks. Re-subscribing fixes exactly that. Reconnecting instead opens a new socket every
///     time, and Dhan disconnects the oldest with error 805 once five are open: an aborting
///     watchdog on a quiet feed manufactures its own connection-limit failure. Outside market hours
///     a healthy feed legitimately delivers nothing all night, so this case re-subscribes at a slow
///     cadence and NEVER escalates.
/// </summary>
public sealed class FeedStallDetector
{
    /// <summary>How long a connection that HAS been delivering may go silent before it is treated
    /// as stalled. Long enough not to trip on a mid-session lull in an illiquid strike, short
    /// enough that a dead feed is noticed in seconds rather than never.</summary>
    public static readonly TimeSpan StallTimeout = TimeSpan.FromSeconds(120);

    /// <summary>How long a freshly connected feed may deliver nothing before its subscriptions are
    /// re-sent. Much shorter than StallTimeout on purpose: once a subscription is live, data starts
    /// within seconds during market hours, so prolonged silence right after connecting means the
    /// subscription very likely never took effect. Only the FIRST attempt is this eager.</summary>
    public static readonly TimeSpan InitialDataTimeout = TimeSpan.FromSeconds(30);

    /// <summary>How often to test - one timestamp comparison, so it is nearly free.</summary>
    public static readonly TimeSpan CheckInterval = TimeSpan.FromSeconds(15);

    /// <summary>How long a connection must survive before it counts as healthy and the reconnect
    /// backoff may reset to its floor. A connect SUCCEEDING is not the same as it WORKING: a server
    /// that accepts and immediately closes would otherwise be retried every second forever,
    /// inviting exactly the rate-limit block that turns a blip into a sustained outage.</summary>
    public static readonly TimeSpan StableConnectionThreshold = TimeSpan.FromSeconds(60);

    private DateTimeOffset _connectedAt;
    private DateTimeOffset? _lastMessageAt;
    private DateTimeOffset? _lastRecoveryAt;
    private bool _everDelivered;
    private bool _resubscribedSinceLastMessage;

    /// <summary>Call on every (re)connect, before the subscriptions go out - a fresh socket is
    /// judged on its own behaviour, not the previous one's.</summary>
    public void OnConnected(DateTimeOffset now)
    {
        _connectedAt = now;
        _lastMessageAt = null;
        _lastRecoveryAt = null;
        _everDelivered = false;
        _resubscribedSinceLastMessage = false;
    }

    /// <summary>Call for every message received, of any kind. It is liveness being tracked, not
    /// usefulness: any frame proves the connection is delivering. Returns true the FIRST time this
    /// connection delivers anything, so the caller can log that one genuinely useful line.</summary>
    public bool OnMessage(DateTimeOffset now)
    {
        var isFirst = !_everDelivered;
        _lastMessageAt = now;
        _everDelivered = true;
        _resubscribedSinceLastMessage = false;
        return isFirst;
    }

    public TimeSpan TimeSinceConnected(DateTimeOffset now) => now - _connectedAt;

    /// <summary>What the caller should do right now. <paramref name="hasSubscriptions"/> false
    /// means there is no data to expect, so silence proves nothing.</summary>
    public FeedRecoveryAction Decide(DateTimeOffset now, bool hasSubscriptions)
    {
        if (!hasSubscriptions) return FeedRecoveryAction.None;

        // Never delivered gets ONE eager attempt, then settles to the normal cadence - fast
        // recovery when a subscription was missed, without chattering all night when the market is
        // simply closed.
        var timeout = !_everDelivered && _lastRecoveryAt is null ? InitialDataTimeout : StallTimeout;

        // Measured from the last thing that HAPPENED - a message, or the last recovery attempt, or
        // failing both the moment we connected. Counting from the recovery attempt is what gives a
        // re-subscribe a full window to take effect before anything escalates.
        var since = Max(_lastMessageAt ?? _connectedAt, _lastRecoveryAt ?? _connectedAt);
        if (now - since <= timeout) return FeedRecoveryAction.None;

        // Delivered before, and a re-subscribe has already been tried without bringing it back: the
        // connection itself is the problem.
        if (_everDelivered && _resubscribedSinceLastMessage)
        {
            _lastRecoveryAt = now;
            return FeedRecoveryAction.Reconnect;
        }

        _lastRecoveryAt = now;
        _resubscribedSinceLastMessage = true;
        return FeedRecoveryAction.Resubscribe;
    }

    private static DateTimeOffset Max(DateTimeOffset a, DateTimeOffset b) => a > b ? a : b;
}

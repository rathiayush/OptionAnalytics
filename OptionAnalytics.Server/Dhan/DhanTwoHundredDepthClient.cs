using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// Dhan's 200-level ("full") market depth WebSocket (wss://full-depth-api.dhan.co/twohundreddepth):
/// the top 200 bid and ask levels of ONE instrument per connection - Dhan allows no more on this feed
/// - so every subscription is its own socket. NSE only, like the 20-level feed.
///
/// Dhan drops the OLDEST socket once an account opens more than 5 (main market feed, order updates,
/// 20-level depth and these all count), so this client is capped at OrderFlow:MaxTwoHundredDepth
/// connections (default 2: NIFTY and BANKNIFTY futures), keeping the total at 4-5.
///
/// Each connection logs in through the URL, subscribes its instrument, and reconnects with backoff.
/// Dhan pings every 10s and closes a socket that does not answer within 40s - ClientWebSocket answers
/// pings by itself. DepthUpdated runs on the socket's receive loop - handlers must be quick.
///
/// A connection that stays open but sends no book for SilentReconnectAfter during market hours is closed
/// and opened again (a new subscribe): Dhan can keep a socket open and silent for an account that was not
/// entitled to the 200-level feed when it subscribed - a plan bought during the day is then picked up by
/// the next subscribe, with no server restart.
/// </summary>
public sealed class DhanTwoHundredDepthClient : BackgroundService
{
    private const int RequestCodeSubscribe = 23;
    private static readonly TimeSpan StreamingWindow = TimeSpan.FromSeconds(15);

    /// <summary>How long an open connection may go without a book, in market hours, before it is opened again.</summary>
    internal TimeSpan SilentReconnectAfter { get; init; } = TimeSpan.FromSeconds(60);

    /// <summary>Whether Dhan should be streaming the book now (for the tests: always).</summary>
    internal Func<DateTimeOffset, bool> MarketOpen { get; init; } = InMarketHours;

    /// <summary>NSE's session, IST weekdays 09:15-15:30 - when a 200-level book is expected to keep arriving.</summary>
    internal static bool InMarketHours(DateTimeOffset now)
    {
        var ist = now.ToOffset(IstClock.Offset);
        if (ist.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) return false;
        return ist.TimeOfDay >= new TimeSpan(9, 15, 0) && ist.TimeOfDay < new TimeSpan(15, 30, 0);
    }

    private readonly DhanOptions _options;
    private readonly DhanSession _session;
    private readonly ILogger<DhanTwoHundredDepthClient> _logger;
    private readonly int _maxConnections;
    private readonly ConcurrentDictionary<uint, Subscription> _subscriptions = new();
    private CancellationToken _stopping = CancellationToken.None;
    private readonly TaskCompletionSource _started = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public DhanTwoHundredDepthClient(IOptions<DhanOptions> options, DhanSession session, ILogger<DhanTwoHundredDepthClient> logger, IConfiguration? configuration = null)
    {
        _options = options.Value;
        _session = session;
        _logger = logger;
        _maxConnections = Math.Clamp(configuration?.GetValue("OrderFlow:MaxTwoHundredDepth", 2) ?? 2, 0, 3);
    }

    public event Action<DepthSidePacket>? DepthUpdated;

    /// <summary>Whether this feed can carry <paramref name="exchangeSegment"/> at all (NSE only).</summary>
    public bool Supports(string exchangeSegment) => _maxConnections > 0 && exchangeSegment.StartsWith("NSE_", StringComparison.OrdinalIgnoreCase);

    /// <summary>Whether this instrument's 200-level book has arrived recently.</summary>
    public bool IsStreaming(uint securityId)
        => _subscriptions.TryGetValue(securityId, out var s) && s.LastMessageTicks is var at and > 0 && DateTimeOffset.UtcNow.UtcTicks - at < StreamingWindow.Ticks;

    /// <summary>When this instrument was subscribed here, or null when it is not.</summary>
    public DateTimeOffset? SubscribedAt(uint securityId) => _subscriptions.TryGetValue(securityId, out var s) ? s.Since : null;

    public int ConnectionCount => _subscriptions.Values.Count(s => s.Connected);

    /// <summary>This instrument's 200-level connection - whether it is open, when its book last
    /// arrived and the last error Dhan gave - or null when it is not on this feed.</summary>
    public DepthConnectionStatus? Status(uint securityId) => _subscriptions.TryGetValue(securityId, out var s)
        ? new DepthConnectionStatus(s.Connected, s.LastMessageTicks > 0 ? new DateTimeOffset(Interlocked.Read(ref s.LastMessageTicks), TimeSpan.Zero) : null, s.LastError)
        : null;

    /// <summary>Opens a 200-level connection for this instrument. False when the segment is not
    /// supported or every allowed connection is taken.</summary>
    public bool Subscribe(uint securityId, string exchangeSegment)
    {
        if (!Supports(exchangeSegment)) return false;
        if (_subscriptions.ContainsKey(securityId)) return true;
        lock (_subscriptions)
        {
            if (_subscriptions.ContainsKey(securityId)) return true;
            if (_subscriptions.Count >= _maxConnections) return false;
            var subscription = new Subscription(securityId, exchangeSegment);
            _subscriptions[securityId] = subscription;
            _ = _started.Task.ContinueWith(_ => RunAsync(subscription), TaskScheduler.Default);
            return true;
        }
    }

    /// <summary>Closes this instrument's connection (a futures rollover frees its slot).</summary>
    public void Unsubscribe(uint securityId)
    {
        if (_subscriptions.TryRemove(securityId, out var subscription)) subscription.Cancel.Cancel();
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _stopping = stoppingToken;
        _started.TrySetResult();
        try { await Task.Delay(Timeout.Infinite, stoppingToken); }
        catch (OperationCanceledException) { }
        foreach (var subscription in _subscriptions.Values) subscription.Cancel.Cancel();
    }

    private async Task RunAsync(Subscription subscription)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(_stopping, subscription.Cancel.Token);
        var token = linked.Token;
        var backoff = TimeSpan.FromSeconds(2);
        while (!token.IsCancellationRequested)
        {
            if (!_session.IsAuthenticated)
            {
                try { await Task.Delay(TimeSpan.FromSeconds(5), token); } catch (OperationCanceledException) { break; }
                continue;
            }

            var startedAt = DateTimeOffset.UtcNow;
            try
            {
                await RunConnectionAsync(subscription, token);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                subscription.LastError = DepthConnectionStatus.Describe(ex);
                _logger.LogWarning(ex, "Dhan 200-level depth for {SecurityId} disconnected - retrying in {Seconds}s.", subscription.SecurityId, backoff.TotalSeconds);
            }
            finally
            {
                subscription.Connected = false;
            }

            if (DateTimeOffset.UtcNow - startedAt > TimeSpan.FromMinutes(2)) backoff = TimeSpan.FromSeconds(2);
            try { await Task.Delay(backoff, token); } catch (OperationCanceledException) { break; }
            backoff = TimeSpan.FromSeconds(Math.Min(backoff.TotalSeconds * 2, 120));
        }
    }

    private async Task RunConnectionAsync(Subscription subscription, CancellationToken cancellationToken)
    {
        using var socket = new ClientWebSocket();
        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
        var url = $"{_options.FullDepthWsUrl}?token={Uri.EscapeDataString(_session.AccessToken!)}&clientId={Uri.EscapeDataString(_session.ClientId!)}&authType=2";
        await socket.ConnectAsync(new Uri(url), cancellationToken);
        subscription.Connected = true;
        _logger.LogInformation("Connected to the Dhan 200-level depth feed for {SecurityId} ({Segment}).", subscription.SecurityId, subscription.Segment);

        var payload = JsonSerializer.SerializeToUtf8Bytes(new
        {
            RequestCode = RequestCodeSubscribe,
            ExchangeSegment = subscription.Segment,
            SecurityId = subscription.SecurityId.ToString(),
        });
        await socket.SendAsync(new ArraySegment<byte>(payload), WebSocketMessageType.Text, true, cancellationToken);

        var buffer = new byte[16 * 1024];
        using var message = new MemoryStream();
        // Cancels a receive that waited SilentReconnectAfter for a book in market hours (re-armed before each receive).
        using var silence = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var booksSinceConnect = 0;
        while (socket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
        {
            message.SetLength(0);
            WebSocketReceiveResult result;
            do
            {
                silence.CancelAfter(MarketOpen(DateTimeOffset.UtcNow) ? SilentReconnectAfter : Timeout.InfiniteTimeSpan);
                try
                {
                    result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), silence.Token);
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    throw new TimeoutException($"no book for {SilentReconnectAfter.TotalSeconds:0} s in market hours - subscribing again");
                }
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    subscription.LastError = $"closed by Dhan ({result.CloseStatus}{(string.IsNullOrWhiteSpace(result.CloseStatusDescription) ? "" : $": {result.CloseStatusDescription}")})";
                    _logger.LogWarning("Dhan 200-level depth for {SecurityId} closed by the server ({Status}: {Description}).",
                        subscription.SecurityId, result.CloseStatus, result.CloseStatusDescription);
                    return;
                }
                message.Write(buffer, 0, result.Count);
            } while (!result.EndOfMessage);

            if (result.MessageType != WebSocketMessageType.Binary) continue;
            var packets = DhanDepthPacketParser.ParseTwoHundred(message.GetBuffer().AsSpan(0, (int)message.Length), out var disconnect);
            if (disconnect is not null)
            {
                subscription.LastError = $"Dhan disconnect {disconnect}: {DhanSymbology.DescribeFeedErrorCode(disconnect.Value)}";
                _logger.LogWarning("Dhan 200-level depth for {SecurityId} sent a disconnect (code {Code}): {Reason}.",
                    subscription.SecurityId, disconnect, DhanSymbology.DescribeFeedErrorCode(disconnect.Value));
                return;
            }
            if (packets.Count > 0)
            {
                Interlocked.Exchange(ref subscription.LastMessageTicks, DateTimeOffset.UtcNow.UtcTicks);
                subscription.LastError = null;
                if (booksSinceConnect++ == 0)
                    _logger.LogInformation("Dhan 200-level book streaming for {SecurityId}: {Rows} rows on the first {Side} side.",
                        subscription.SecurityId, packets[0].Levels.Length, packets[0].IsBid ? "bid" : "ask");
            }
            foreach (var packet in packets)
            {
                try { DepthUpdated?.Invoke(packet); }
                catch (Exception ex) { _logger.LogDebug(ex, "A 200-level depth handler failed for {SecurityId}.", packet.SecurityId); }
            }
        }
    }

    private sealed class Subscription(uint securityId, string segment)
    {
        public uint SecurityId { get; } = securityId;
        public string Segment { get; } = segment;
        public DateTimeOffset Since { get; } = DateTimeOffset.UtcNow;
        public CancellationTokenSource Cancel { get; } = new();
        public volatile bool Connected;
        public long LastMessageTicks;
        public volatile string? LastError;
    }
}

using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services;

namespace OptionAnalytics.Server.TrueData;

/// <summary>
/// TrueData's real-time tick feed (TrueData:Live:Enabled - off by default) behind the Tick Flow page. Its own code: the ticks go
/// into a TickBook per index (exact footprint, bubbles, best bid / ask trail) - nothing here touches OrderFlowEngine or the Order
/// Flow page. A "trade" message carries the trade's OWN quantity, the day's volume, a sequence number (gaps counted) and the best
/// bid / ask; a "bidask" message when only the quote moved. NSE depth past level 1 is not in TrueData's feed.
///
/// One connection per account: a second login is refused ("User Already Connected"), so a refusal backs off for minutes (never a
/// loop). Connects only in IST weekday 08:30 - 15:45. Sandbox port 8086, production 8084. Memory only.
/// </summary>
public sealed class TrueDataLiveFeed : BackgroundService
{
    private readonly TrueDataOptions _options;
    private readonly ILogger<TrueDataLiveFeed> _logger;
    private readonly Dictionary<string, Stream> _byUnderlying = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, Stream> _byId = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Stream> _byName = new(StringComparer.OrdinalIgnoreCase);
    /// <summary>The arrival clock (a test sets it - the engine keeps a bar only inside the session).</summary>
    internal Func<DateTimeOffset> Clock { get; set; } = () => DateTimeOffset.UtcNow;
    private volatile string _state = "off";
    private volatile string? _lastError;
    private DateTimeOffset? _connectedAt, _lastFrameAt;
    private long _frames;
    // The newest raw messages (heartbeats left out, each cut at 400 characters - they hold no login): what TrueData actually sends, for the
    // page to show when nothing arrives. A message has no credentials in it.
    private readonly Queue<string> _recent = new();

    public TrueDataLiveFeed(IOptions<TrueDataOptions> options, ILogger<TrueDataLiveFeed> logger)
    {
        _options = options.Value;
        _logger = logger;
        foreach (var i in _options.Live.Instruments.Where(i => i.Underlying.Length > 0 && i.Symbol.Length > 0))
        {
            var stream = new Stream(i, new TickBook(i.Underlying.ToUpperInvariant(), i.Symbol, i.LotSize, i.TickSize));
            _byUnderlying[i.Underlying] = stream;
            _byName[i.Symbol] = stream;
        }
    }

    public sealed class Stream
    {
        public Stream(TrueDataLiveInstrument instrument, TickBook book) { Instrument = instrument; Book = book; }
        public TrueDataLiveInstrument Instrument { get; }
        public TickBook Book { get; }
        public long Quotes;
    }

    public sealed record Status(string State, string? Error, DateTimeOffset? ConnectedAt, DateTimeOffset? LastFrameAt, long Frames, string Port, IReadOnlyList<StreamStatus> Streams, IReadOnlyList<string> RecentFrames);
    public sealed record StreamStatus(string Underlying, string Symbol, long Trades, long Quotes, long SequenceGaps, long BookedVolume, long ExchangeVolume, decimal Bid, long BidQty, decimal Ask, long AskQty, decimal LastPrice, DateTimeOffset? LastTradeAt);

    private bool IsTcp => string.Equals(_options.Live.Transport, "tcp", StringComparison.OrdinalIgnoreCase);

    public TickBook? BookFor(string underlying) => _byUnderlying.TryGetValue(underlying, out var s) ? s.Book : null;
    public TrueDataLiveInstrument? InstrumentFor(string underlying) => _byUnderlying.TryGetValue(underlying, out var s) ? s.Instrument : null;

    public Status Snapshot()
    {
        lock (_byUnderlying)
            return new Status(_state, _lastError, _connectedAt, _lastFrameAt, Interlocked.Read(ref _frames),
                IsTcp ? $"TCP {_options.Live.TcpHost}:{_options.Live.TcpPort}" : _options.Live.Port == 8084 ? "WebSocket production (8084)" : $"WebSocket sandbox ({_options.Live.Port})",
                _byUnderlying.Values.Select(s =>
                {
                    var m = s.Book.Meta();
                    return new StreamStatus(m.Underlying, m.Symbol, m.Prints, s.Quotes, m.SequenceGaps, m.BookedVolume, m.ExchangeVolume, m.Bid, m.BidQty, m.Ask, m.AskQty, m.LastPrice, m.LastTradeAt);
                }).ToList(), RecentFramesCopy());
    }

    private string[] RecentFramesCopy() { lock (_recent) return _recent.ToArray(); }

    private void Remember(string text, string kind)
    {
        if (kind == "heartbeat") return;
        lock (_recent)
        {
            _recent.Enqueue(text.Length > 400 ? text[..400] + "…" : text);
            while (_recent.Count > 12) _recent.Dequeue();
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.Live.Enabled || !_options.IsConfigured || _byUnderlying.Count == 0)
        {
            _state = "off";
            return;
        }
        using var background = MarketHours.BackgroundScope();
        var wait = TimeSpan.FromSeconds(5);
        while (!stoppingToken.IsCancellationRequested)
        {
            if (!InWindow(DateTimeOffset.UtcNow))
            {
                _state = "outside hours";
                await Delay(TimeSpan.FromMinutes(1), stoppingToken);
                continue;
            }
            var refused = false;
            try
            {
                refused = await RunOnceAsync(stoppingToken);
                if (!refused) wait = TimeSpan.FromSeconds(5);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex)
            {
                _lastError = ex.Message;
                _logger.LogWarning("TrueData live feed: {Error}", ex.Message);
            }
            _state = refused ? "refused" : "reconnecting";
            // A refusal (wrong login, a session already open elsewhere) is never retried quickly; a dropped connection backs off.
            wait = refused ? TimeSpan.FromMinutes(5) : TimeSpan.FromSeconds(Math.Min(120, Math.Max(5, wait.TotalSeconds * 2)));
            await Delay(wait, stoppingToken);
        }
    }

    internal static bool InWindow(DateTimeOffset utc)
    {
        var ist = utc.ToOffset(TimeSpan.FromMinutes(330));
        if (ist.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) return false;
        var t = ist.TimeOfDay;
        return t >= new TimeSpan(8, 30, 0) && t <= new TimeSpan(15, 45, 0);
    }

    private static async Task Delay(TimeSpan span, CancellationToken token)
    {
        try { await Task.Delay(span, token); } catch (OperationCanceledException) { }
    }

    /// <summary>One connection until it ends. True when the server refused the login.</summary>
    internal Task<bool> RunOnceAsync(CancellationToken token) => IsTcp ? RunTcpAsync(token) : RunWebSocketAsync(token);

    private async Task<bool> RunWebSocketAsync(CancellationToken token)
    {
        _state = "connecting";
        var live = _options.Live;
        var uri = new Uri($"wss://{live.Host}:{live.Port}?user={Uri.EscapeDataString(_options.UserId)}&password={Uri.EscapeDataString(_options.Password)}");
        using var socket = new ClientWebSocket();
        await socket.ConnectAsync(uri, token);
        _connectedAt = DateTimeOffset.UtcNow;
        _lastError = null;
        var buffer = new byte[64 * 1024];
        var subscribed = false;
        while (socket.State == WebSocketState.Open && !token.IsCancellationRequested)
        {
            var text = await ReceiveAsync(socket, buffer, token);
            if (text is null) break;
            var frame = TrueDataLiveParser.Parse(text);
            var (nowSubscribed, refused) = await OnFrameAsync(frame, text, subscribed,
                json => SendAsync(socket, json, token));
            subscribed = nowSubscribed;
            if (refused) { await CloseAsync(socket); return true; }
        }
        // A login the server answered with a close and no message (a second session) reads as refused.
        return !subscribed;
    }

    /// <summary>The TCP stream (tcp.truedata.in:7070, TCP API v2.3): "LOGIN user password", then the same JSON "addsymbol" for the symbol ids,
    /// then the binary TR / BA packets (<see cref="TrueDataTcpParser"/>). The frames go through the same handling as the WebSocket's.</summary>
    private async Task<bool> RunTcpAsync(CancellationToken token)
    {
        _state = "connecting";
        var live = _options.Live;
        using var client = new TcpClient { NoDelay = true };
        client.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.KeepAlive, true);
        await client.ConnectAsync(live.TcpHost, live.TcpPort, token);
        _connectedAt = DateTimeOffset.UtcNow;
        _lastError = null;
        var stream = client.GetStream();
        await stream.WriteAsync(Encoding.ASCII.GetBytes($"LOGIN {_options.UserId} {_options.Password}\r\n"), token);
        var parser = new TrueDataTcpParser { Clock = Clock };
        var buffer = new byte[64 * 1024];
        var subscribed = false;
        while (!token.IsCancellationRequested)
        {
            IReadOnlyList<TrueDataFrame> frames;
            using var idle = CancellationTokenSource.CreateLinkedTokenSource(token);
            // A text line with no line end (the login answer may have none) is taken after a short quiet.
            if (parser.HasPendingText) idle.CancelAfter(300);
            int n;
            try { n = await stream.ReadAsync(buffer, idle.Token); }
            catch (OperationCanceledException) when (!token.IsCancellationRequested) { n = -1; }
            if (n == 0) break;
            frames = n < 0 ? parser.FlushText() : parser.Feed(buffer.AsSpan(0, n));
            foreach (var frame in frames)
            {
                var (nowSubscribed, refused) = await OnFrameAsync(frame, Describe(frame), subscribed,
                    json => stream.WriteAsync(Encoding.UTF8.GetBytes(json + "\r\n"), token).AsTask());
                subscribed = nowSubscribed;
                if (refused) return true;
            }
        }
        return !subscribed;
    }

    /// <summary>A frame as one short line for the page's raw-message box (a packet has no text of its own). No login in it.</summary>
    internal static string Describe(TrueDataFrame f) => f.Kind switch
    {
        "trade" when f.Trade is { } t => $"TR id {t.SymbolId} seq {t.Sequence} {t.Time:HH:mm:ss} ltp {t.Price} ltq {t.Quantity} ttq {t.TotalVolume} bid {t.Bid} x {t.BidQty} ask {t.Ask} x {t.AskQty}",
        "bidask" when f.Quote is { } q => $"BA id {q.SymbolId} {q.Time:HH:mm:ss} bid {q.Bid} x {q.BidQty} ask {q.Ask} x {q.AskQty}",
        "status" => $"market message {f.Message}",
        _ => f.Message ?? f.Kind,
    };

    /// <summary>One frame, whichever way it came: counts it, keeps it for the page, answers a login with the subscribe, routes a trade or
    /// a quote. Returns whether the symbols are subscribed now and whether the server refused the login.</summary>
    private async Task<(bool Subscribed, bool Refused)> OnFrameAsync(TrueDataFrame frame, string text, bool subscribed, Func<string, Task> send)
    {
        _lastFrameAt = DateTimeOffset.UtcNow;
        Interlocked.Increment(ref _frames);
        Remember(text, frame.Kind);
        switch (frame.Kind)
        {
            case "login" when !subscribed:
                _state = "connected";
                await send(JsonSerializer.Serialize(new { method = "addsymbol", symbols = _byName.Keys.ToArray() }));
                return (true, false);
            case "error":
                _lastError = frame.Message;
                _logger.LogWarning("TrueData live feed refused: {Message}", frame.Message);
                return (subscribed, !subscribed);
            case "symbols":
                Register(frame.Symbols ?? Array.Empty<TrueDataSymbol>());
                _state = "streaming";
                break;
            case "trade" when frame.Trade is { } trade:
                _state = "streaming";
                OnTrade(trade);
                break;
            case "bidask" when frame.Quote is { } quote:
                _state = "streaming";
                OnQuote(quote);
                break;
        }
        return (subscribed, false);
    }

    private static async Task CloseAsync(ClientWebSocket socket)
    {
        try { await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None); } catch { }
    }

    private static async Task SendAsync(ClientWebSocket socket, string text, CancellationToken token) =>
        await socket.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, token);

    private static async Task<string?> ReceiveAsync(ClientWebSocket socket, byte[] buffer, CancellationToken token)
    {
        using var ms = new MemoryStream();
        while (true)
        {
            var result = await socket.ReceiveAsync(buffer, token);
            if (result.MessageType == WebSocketMessageType.Close) return null;
            ms.Write(buffer, 0, result.Count);
            if (result.EndOfMessage) break;
        }
        return Encoding.UTF8.GetString(ms.GetBuffer(), 0, (int)ms.Length);
    }

    /// <summary>The ids the subscribe reply gave the symbols - the feed names them by id.</summary>
    internal void Register(IEnumerable<TrueDataSymbol> symbols)
    {
        lock (_byUnderlying)
            foreach (var s in symbols)
                if (_byName.TryGetValue(s.Name, out var stream)) _byId[s.SymbolId] = stream;
    }

    private Stream? StreamOf(string symbolId)
    {
        lock (_byUnderlying) return _byId.TryGetValue(symbolId, out var s) ? s : null;
    }

    internal void OnTrade(TrueDataTrade t)
    {
        if (StreamOf(t.SymbolId) is not { } s) return;
        s.Book.OnTrade(t.Time ?? Clock(), t.Sequence, t.Price, t.Quantity, t.Bid, t.BidQty, t.Ask, t.AskQty, t.TotalVolume);
    }

    internal void OnQuote(TrueDataQuote q)
    {
        if (StreamOf(q.SymbolId) is not { } s) return;
        Interlocked.Increment(ref s.Quotes);
        s.Book.OnQuote(q.Time ?? Clock(), q.Bid, q.BidQty, q.Ask, q.AskQty);
    }
}

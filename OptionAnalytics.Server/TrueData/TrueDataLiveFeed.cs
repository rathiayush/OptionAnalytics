using System.Diagnostics;
using System.Net.Sockets;
using System.Threading.Channels;
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
        _transport = LoadTransport();
        ChainSource = new TrueDataOptionChainSource(_options);
        foreach (var i in _options.Live.Instruments.Where(i => i.Underlying.Length > 0 && i.Symbol.Length > 0))
        {
            var stream = new Stream(i, new TickBook(i.Underlying.ToUpperInvariant(), i.Symbol, i.LotSize, i.TickSize));
            _byUnderlying[i.Underlying] = stream;
            _byName[i.Symbol] = stream;
        }
        (_optUnderlying, _optStrikes) = LoadOptions();   // after the instruments: the index picked must be one of them
    }

    public sealed class Stream
    {
        public Stream(TrueDataLiveInstrument instrument, TickBook book) { Instrument = instrument; Book = book; }
        public TrueDataLiveInstrument Instrument { get; }
        public TickBook Book { get; }
        public long Quotes;
    }

    public sealed record Status(string State, string? Error, DateTimeOffset? ConnectedAt, DateTimeOffset? LastFrameAt, long Frames, string Port, IReadOnlyList<StreamStatus> Streams, IReadOnlyList<string> RecentFrames, string Transport, OptionsStatus Options, QueueStatus Queue);
    public sealed record StreamStatus(string Underlying, string Symbol, long Trades, long Quotes, long SequenceGaps, long BookedVolume, long ExchangeVolume, decimal Bid, long BidQty, decimal Ask, long AskQty, decimal LastPrice, DateTimeOffset? LastTradeAt);

    private volatile string _transport = "websocket";
    private CancellationTokenSource? _connection;
    private bool IsTcp => _transport == "tcp";
    public string Transport => _transport;

    /// <summary>The source the page picked: "websocket" or "tcp". The connection open now is closed (TrueData allows one login an account)
    /// and the feed reconnects through the new one at once; the choice is kept in a small file, so it holds through a restart. Returns false for any
    /// other name.</summary>
    public bool SetTransport(string? transport)
    {
        var t = transport?.Trim().ToLowerInvariant();
        if (t is not ("websocket" or "tcp")) return false;
        if (t == _transport) return true;
        _transport = t;
        _lastError = null;
        SaveTransport(t);
        try { _connection?.Cancel(); } catch (ObjectDisposedException) { }
        return true;
    }

    private string? StateFile => string.IsNullOrWhiteSpace(_options.Live.StatePath) ? null : Path.Combine(_options.Live.StatePath, "tick-flow-source.txt");

    private void SaveTransport(string t)
    {
        try { if (StateFile is { } f) { Directory.CreateDirectory(Path.GetDirectoryName(f)!); File.WriteAllText(f, t); } }
        catch (Exception ex) { _logger.LogWarning("TrueData live feed: the chosen source was not saved: {Error}", ex.Message); }
    }

    private string LoadTransport()
    {
        try { if (StateFile is { } f && File.Exists(f) && File.ReadAllText(f).Trim().ToLowerInvariant() is ("websocket" or "tcp") and var t) return t; }
        catch { }
        return string.Equals(_options.Live.Transport, "tcp", StringComparison.OrdinalIgnoreCase) ? "tcp" : "websocket";
    }

    // ---- THE INBOX: the socket is read, the ticks are applied elsewhere ----
    // A receive loop that also applied every tick (the books' locks, the page's snapshot readers) would stop reading the socket whenever
    // a reader held a lock; TrueData's own spec warns that a client that does not keep up "could fill up the receive buffer ... leading to packet
    // drops". So the receive loop only parses and queues (a bounded channel, one reader that applies them IN ORDER) - the depth, the longest it
    // reached and the lag are in the status, and a full queue holds the socket (never drops a tick silently - `Backpressure` counts it).
    private const int InboxCapacity = 200_000;
    private readonly record struct Inbound(TrueDataFrame Frame, long Stamp);
    private readonly Channel<Inbound> _inbox = Channel.CreateBounded<Inbound>(new BoundedChannelOptions(InboxCapacity)
    { SingleReader = true, SingleWriter = true, FullMode = BoundedChannelFullMode.Wait });
    private long _enqueued, _processed, _backpressure, _maxDepth, _applyErrors, _lastRemembered;
    private double _lastLagMs, _maxLagMs;

    public sealed record QueueStatus(long Depth, long MaxDepth, long Processed, long Backpressure, double LagMs, double MaxLagMs, long Errors);

    public QueueStatus QueueSnapshot()
    {
        var processed = Interlocked.Read(ref _processed);
        return new QueueStatus(Math.Max(0, Interlocked.Read(ref _enqueued) - processed), Interlocked.Read(ref _maxDepth), processed,
            Interlocked.Read(ref _backpressure), Volatile.Read(ref _lastLagMs), Volatile.Read(ref _maxLagMs), Interlocked.Read(ref _applyErrors));
    }

    /// <summary>Queues a trade / quote frame for the worker (waits only when the queue is full).</summary>
    internal async ValueTask EnqueueAsync(TrueDataFrame frame, CancellationToken token)
    {
        var item = new Inbound(frame, Stopwatch.GetTimestamp());
        if (!_inbox.Writer.TryWrite(item))
        {
            Interlocked.Increment(ref _backpressure);
            await _inbox.Writer.WriteAsync(item, token);
        }
        var depth = Interlocked.Increment(ref _enqueued) - Interlocked.Read(ref _processed);
        if (depth > Volatile.Read(ref _maxDepth)) Interlocked.Exchange(ref _maxDepth, depth);
    }

    /// <summary>The single reader: applies the queued ticks in the order they arrived. A tick that throws is counted and skipped - it never stops the stream.</summary>
    internal async Task ProcessInboxAsync(CancellationToken token)
    {
        var reader = _inbox.Reader;
        try
        {
            while (await reader.WaitToReadAsync(token))
            {
                while (reader.TryRead(out var item))
                {
                    try
                    {
                        if (item.Frame.Trade is { } trade) OnTrade(trade);
                        else if (item.Frame.Quote is { } quote) OnQuote(quote);
                    }
                    catch (Exception ex)
                    {
                        if (Interlocked.Increment(ref _applyErrors) == 1) _logger.LogWarning("TrueData live feed: a tick was not applied: {Error}", ex.Message);
                    }
                    var lag = Stopwatch.GetElapsedTime(item.Stamp).TotalMilliseconds;
                    Volatile.Write(ref _lastLagMs, lag);
                    if (lag > Volatile.Read(ref _maxLagMs)) Volatile.Write(ref _maxLagMs, lag);
                    Interlocked.Increment(ref _processed);
                }
            }
        }
        catch (OperationCanceledException) { }
    }

    // ---- BIG OPTION ORDERS: the options' ticks (ATM +- N of the index picked on the page), watched for big orders ----
    private readonly OptionBigOrderWatch _watch = new();
    private readonly SemaphoreSlim _sendGate = new(1, 1);
    private readonly HashSet<string> _subscribedOptions = new(StringComparer.Ordinal);
    private volatile Func<string, Task>? _sender;
    private int _epoch, _subscribedEpoch = -1;
    private string _optUnderlying = "";
    private string _subscribedFor = "";
    private int _optStrikes = 10;
    private Dictionary<string, OptionContract>? _chain;
    private DateOnly _chainDay;
    private DateOnly? _chainExpiry;
    private decimal _optStep = 50, _optCentre;
    private string? _optError;
    private DateTimeOffset _chainRetryAt;
    private TimeSpan _chainBackoff = TimeSpan.FromSeconds(30);

    public OptionBigOrderWatch Watch => _watch;
    /// <summary>Where the option chain comes from (TrueData's REST master; a test sets a fake).</summary>
    internal IOptionChainSource ChainSource { get; set; }

    public sealed record OptionsStatus(string Underlying, int Strikes, string? Expiry, decimal Atm, decimal Step, int Subscribed, int Cap, long Ticks,
        DateTimeOffset? LastTickAt, long LastSeq, string? Error);

    public OptionsStatus OptionsSnapshot()
    {
        var m = _watch.Meta();
        return new OptionsStatus(_optUnderlying, _optStrikes, _chainExpiry?.ToString("yyyy-MM-dd"), _optCentre, _optStep, _subscribedOptions.Count,
            Math.Max(0, _options.Live.MaxSymbols - _byUnderlying.Count), m.Ticks, m.LastTickAt, m.LastSeq, _optError);
    }

    private string? OptionsFile => string.IsNullOrWhiteSpace(_options.Live.StatePath) ? null : Path.Combine(_options.Live.StatePath, "tick-flow-options.json");

    private (string, int) LoadOptions()
    {
        var underlying = _options.Live.OptionsUnderlying?.Trim().ToUpperInvariant() ?? "";
        var strikes = _options.Live.OptionStrikes;
        try
        {
            if (OptionsFile is { } f && File.Exists(f))
            {
                using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(f));
                if (doc.RootElement.TryGetProperty("underlying", out var u) && u.ValueKind == System.Text.Json.JsonValueKind.String) underlying = u.GetString()!.ToUpperInvariant();
                if (doc.RootElement.TryGetProperty("strikes", out var k) && k.TryGetInt32(out var n)) strikes = n;
            }
        }
        catch { }
        return (_byUnderlying.ContainsKey(underlying) ? underlying : "", Math.Clamp(strikes, 1, 15));
    }

    /// <summary>The index whose options are watched ("" = none) and how many strikes each side of the ATM. Kept in a file. False for an index that is not streamed.</summary>
    public bool SetOptions(string? underlying, int strikes)
    {
        var u = underlying?.Trim().ToUpperInvariant() ?? "";
        if (u.Length > 0 && !_byUnderlying.ContainsKey(u)) return false;
        _optUnderlying = u;
        _optStrikes = Math.Clamp(strikes, 1, 15);
        _optError = null;
        try
        {
            if (OptionsFile is { } f)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(f)!);
                File.WriteAllText(f, System.Text.Json.JsonSerializer.Serialize(new { underlying = u, strikes = _optStrikes }));
            }
        }
        catch (Exception ex) { _logger.LogWarning("TrueData live feed: the option choice was not saved: {Error}", ex.Message); }
        return true;
    }

    /// <summary>A connection that has logged in and subscribed the futures: the option stream sends through it (null = none - the connection ended).</summary>
    internal void UseConnection(Func<string, Task>? send)
    {
        if (send is not null) _epoch++;
        _sender = send;
    }

    private async Task LockedSend(Func<Task> send)
    {
        await _sendGate.WaitAsync();
        try { await send(); } finally { _sendGate.Release(); }
    }

    private async Task OptionsLoopAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try { await Task.Delay(TimeSpan.FromSeconds(5), token); } catch (OperationCanceledException) { return; }
            if (!InWindow(DateTimeOffset.UtcNow)) continue;
            try { await SyncOptionsAsync(DateTimeOffset.UtcNow, token); }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
            catch (Exception ex) { _optError = ex.Message; _logger.LogWarning("TrueData option stream: {Error}", ex.Message); }
        }
    }

    /// <summary>One round: keep the subscribed options ATM +- N of the index picked (the ATM from the options' own put-call parity once they tick, else
    /// the futures' price), within the symbol cap - adds the new strikes, drops those two steps past the window. A new connection starts with only the futures,
    /// so everything is subscribed again. Internal for the tests.</summary>
    internal async Task SyncOptionsAsync(DateTimeOffset now, CancellationToken token)
    {
        var send = _sender;
        if (send is null) return;
        if (_subscribedEpoch != _epoch) { _subscribedOptions.Clear(); _subscribedEpoch = _epoch; }
        var u = _optUnderlying;
        if (u.Length == 0 || !_byUnderlying.TryGetValue(u, out var stream))
        {
            if (_subscribedOptions.Count > 0) await RemoveOptionsAsync(send, _subscribedOptions.ToList());
            _chain = null; _subscribedFor = "";
            return;
        }
        if (_subscribedFor != u)
        {
            if (_subscribedOptions.Count > 0) await RemoveOptionsAsync(send, _subscribedOptions.ToList());
            _watch.Clear(); _chain = null; _subscribedFor = u;
        }
        var today = IstClock.IstDate(now);
        if (_chain is null || _chainDay != today)
        {
            if (now < _chainRetryAt) return;
            try { await LoadChainAsync(u, now, token); _chainBackoff = TimeSpan.FromSeconds(30); _optError = null; }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
            catch (Exception ex)
            {
                _optError = ex.Message;
                _chainRetryAt = now + _chainBackoff;
                _chainBackoff = TimeSpan.FromSeconds(Math.Min(600, _chainBackoff.TotalSeconds * 2));
                return;
            }
        }
        var chain = _chain!;
        var step = _optStep;
        var implied = _watch.ImpliedAtm(now);
        var price = implied?.Forward ?? stream.Book.Meta().LastPrice;
        if (price <= 0) return;
        var centre = implied?.Strike ?? Math.Round(price / step) * step;
        _optCentre = centre; _watch.Atm = centre; _watch.Step = step;

        var n = _optStrikes;
        var cap = Math.Max(0, _options.Live.MaxSymbols - _byUnderlying.Count);
        var remove = _subscribedOptions.Where(id => chain.TryGetValue(id, out var c) && Math.Abs(c.Strike - centre) > (n + 2) * step).ToList();
        var add = chain.Values.Where(c => Math.Abs(c.Strike - centre) <= n * step && !_subscribedOptions.Contains(c.SymbolId))
            .OrderBy(c => Math.Abs(c.Strike - centre)).ThenBy(c => c.Call ? 0 : 1).ToList();
        var room = cap - (_subscribedOptions.Count - remove.Count);
        if (add.Count > room) add = add.Take(Math.Max(0, room)).ToList();
        if (remove.Count > 0) await RemoveOptionsAsync(send, remove);
        if (add.Count > 0)
        {
            foreach (var c in add) { _watch.Track(c); _subscribedOptions.Add(c.SymbolId); }
            await send(JsonSerializer.Serialize(new { method = "addsymbol", symbols = add.Select(c => c.Symbol).ToArray() }));
        }
    }

    private async Task RemoveOptionsAsync(Func<string, Task> send, List<string> ids)
    {
        var names = ids.Where(id => _chain?.ContainsKey(id) == true).Select(id => _chain![id].Symbol).ToArray();
        if (names.Length > 0) await send(JsonSerializer.Serialize(new { method = "removesymbol", symbols = names }));
        foreach (var id in ids) { _subscribedOptions.Remove(id); _watch.Untrack(id); }
    }

    /// <summary>The chain of the nearest expiry that has one: each day from today (not today once it is past 15:30) on the expiry weekday or the day before
    /// it (a holiday moves an expiry earlier) is asked of TrueData until one answers - at most ~12 calls, once a day.</summary>
    private async Task LoadChainAsync(string underlying, DateTimeOffset now, CancellationToken token)
    {
        var ist = now.ToOffset(IstClock.Offset);
        var today = IstClock.IstDate(now);
        var first = ist.TimeOfDay >= new TimeSpan(15, 30, 0) ? today.AddDays(1) : today;
        for (var d = first; d <= first.AddDays(40); d = d.AddDays(1))
        {
            var rule = ExpiryCalendar.OptionExpiryWeekday(underlying, d);
            if (d.DayOfWeek != rule && d.AddDays(1).DayOfWeek != rule) continue;
            var contracts = await ChainSource.GetAsync(underlying, d, token);
            if (contracts.Count == 0) continue;
            _chain = contracts.ToDictionary(c => c.SymbolId, StringComparer.Ordinal);
            _chainExpiry = d; _chainDay = today;
            var strikes = contracts.Select(c => c.Strike).Distinct().OrderBy(k => k).ToList();
            var step = decimal.MaxValue;
            for (var i = 1; i < strikes.Count; i++) step = Math.Min(step, strikes[i] - strikes[i - 1]);
            _optStep = step == decimal.MaxValue || step <= 0 ? 50 : step;
            _subscribedOptions.Clear();
            return;
        }
        throw new InvalidOperationException($"No {underlying} option chain found for the next 40 days");
    }

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
                }).ToList(), RecentFramesCopy(), _transport, OptionsSnapshot(), QueueSnapshot());
    }

    private string[] RecentFramesCopy() { lock (_recent) return _recent.ToArray(); }

    /// <summary>Keeps a message for the page's raw box. Trade / quote frames are SAMPLED (at most one in 250 ms - formatting every tick of a busy feed
    /// was the most expensive thing the receive loop did); everything else is kept. <paramref name="text"/> null = made from the frame, only when kept.</summary>
    private void Remember(TrueDataFrame frame, string? text)
    {
        if (frame.Kind == "heartbeat") return;
        if (frame.Kind is "trade" or "bidask")
        {
            var now = Stopwatch.GetTimestamp();
            if (now - _lastRemembered < Stopwatch.Frequency / 4) return;
            _lastRemembered = now;
        }
        text ??= Describe(frame);
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
        _ = Task.Run(() => ProcessInboxAsync(stoppingToken), stoppingToken);
        _ = Task.Run(() => OptionsLoopAsync(stoppingToken), stoppingToken);
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
            using var connection = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
            _connection = connection;
            try
            {
                refused = await RunOnceAsync(connection.Token);
                if (!refused) wait = TimeSpan.FromSeconds(5);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (OperationCanceledException)
            {
                // The page picked another source: connect through it now (the old connection is closed, so the login is free).
                _state = "switching";
                wait = TimeSpan.Zero;
                continue;
            }
            catch (Exception ex)
            {
                _lastError = ex.Message;
                _logger.LogWarning("TrueData live feed: {Error}", ex.Message);
            }
            UseConnection(null);
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
        var rx = new MemoryStream();
        var subscribed = false;
        while (socket.State == WebSocketState.Open && !token.IsCancellationRequested)
        {
            var text = await ReceiveAsync(socket, buffer, rx, token);
            if (text is null) break;
            var frame = TrueDataLiveParser.Parse(text);
            var (nowSubscribed, refused) = await OnFrameAsync(frame, text, subscribed,
                json => LockedSend(() => SendAsync(socket, json, token)), token);
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
                var (nowSubscribed, refused) = await OnFrameAsync(frame, null, subscribed,
                    json => LockedSend(() => stream.WriteAsync(Encoding.UTF8.GetBytes(json + "\r\n"), token).AsTask()), token);
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
    private async Task<(bool Subscribed, bool Refused)> OnFrameAsync(TrueDataFrame frame, string? text, bool subscribed, Func<string, Task> send, CancellationToken token)
    {
        _lastFrameAt = DateTimeOffset.UtcNow;
        Interlocked.Increment(ref _frames);
        Remember(frame, text);
        switch (frame.Kind)
        {
            case "login" when !subscribed:
                _state = "connected";
                await send(JsonSerializer.Serialize(new { method = "addsymbol", symbols = _byName.Keys.ToArray() }));
                UseConnection(send);
                return (true, false);
            case "error":
                _lastError = frame.Message;
                _logger.LogWarning("TrueData live feed refused: {Message}", frame.Message);
                return (subscribed, !subscribed);
            case "symbols":
                Register(frame.Symbols ?? Array.Empty<TrueDataSymbol>());
                _state = "streaming";
                break;
            case "trade" when frame.Trade is not null:
            case "bidask" when frame.Quote is not null:
                _state = "streaming";
                await EnqueueAsync(frame, token);
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

    private static async Task<string?> ReceiveAsync(ClientWebSocket socket, byte[] buffer, MemoryStream ms, CancellationToken token)
    {
        ms.SetLength(0);   // one buffer for the connection, not one per message
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
            {
                if (_byName.TryGetValue(s.Name, out var stream)) _byId[s.SymbolId] = stream;
                else _watch.Alias(s.Name, s.SymbolId);
            }
    }

    private Stream? StreamOf(string symbolId)
    {
        lock (_byUnderlying) return _byId.TryGetValue(symbolId, out var s) ? s : null;
    }

    internal void OnTrade(TrueDataTrade t)
    {
        if (_watch.Tracks(t.SymbolId)) { _watch.OnTrade(t, t.Time ?? Clock()); return; }
        if (StreamOf(t.SymbolId) is not { } s) return;
        s.Book.OnTrade(t.Time ?? Clock(), t.Sequence, t.Price, t.Quantity, t.Bid, t.BidQty, t.Ask, t.AskQty, t.TotalVolume);
    }

    internal void OnQuote(TrueDataQuote q)
    {
        if (_watch.Tracks(q.SymbolId)) { _watch.OnQuote(q.SymbolId, q.Bid, q.BidQty, q.Ask, q.AskQty); return; }
        if (StreamOf(q.SymbolId) is not { } s) return;
        Interlocked.Increment(ref s.Quotes);
        s.Book.OnQuote(q.Time ?? Clock(), q.Bid, q.BidQty, q.Ask, q.AskQty);
    }
}

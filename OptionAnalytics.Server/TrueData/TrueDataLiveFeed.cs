using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services;
using OptionAnalytics.Server.Services.OrderFlow;

namespace OptionAnalytics.Server.TrueData;

/// <summary>
/// TrueData's real-time tick feed (TrueData:Live:Enabled - off by default) behind the "Tick Flow" page.
///
/// What it gives that Dhan's feed does not: a "trade" message per TRADE with its own quantity (LTQ), the day's running
/// volume (TTQ), a sequence number to prove nothing was dropped, and the best bid / ask in the same packet, plus a
/// "bidask" message when only the quote moved. Each goes through its own OrderFlowEngine (never the Dhan ones - the Order
/// Flow page is untouched) as a SpotTick whose LastTradedQty equals the volume it adds, so a trade is read exactly (no
/// several-trades-in-one-snapshot guess) and classified by the engine's rule against the quote BEFORE it.
///
/// What it cannot give: NSE depth beyond level 1 (TrueData's NSE feed is best bid / ask only), so the "deep" chart here is
/// the best bid / ask trail, not a 20 / 200-level book (the page says so).
///
/// One connection per account: a second login is refused ("User Already Connected"), so a refusal backs off for minutes
/// (never a loop). Connects only in IST weekday 08:30 - 15:45. Sandbox port 8086, production 8084. Memory only.
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
    private int _session;
    private volatile string _state = "off";
    private volatile string? _lastError;
    private DateTimeOffset? _connectedAt, _lastFrameAt;
    private long _frames;

    public TrueDataLiveFeed(IOptions<TrueDataOptions> options, ILogger<TrueDataLiveFeed> logger)
    {
        _options = options.Value;
        _logger = logger;
        foreach (var i in _options.Live.Instruments.Where(i => i.Underlying.Length > 0 && i.Symbol.Length > 0))
        {
            var stream = new Stream(i, new OrderFlowEngine(i.Underlying.ToUpperInvariant(), 0, i.Symbol, "NSE_FNO", i.TickSize, Math.Max(1, i.LotSize)));
            _byUnderlying[i.Underlying] = stream;
            _byName[i.Symbol] = stream;
        }
    }

    public sealed class Stream
    {
        public Stream(TrueDataLiveInstrument instrument, OrderFlowEngine engine) { Instrument = instrument; Engine = engine; }
        public TrueDataLiveInstrument Instrument { get; }
        public OrderFlowEngine Engine { get; }
        public long Trades, Quotes, Dropped, LastSequence;
        public DateTimeOffset? LastTradeAt;
        public decimal Bid, Ask;
        public long BidQty, AskQty;
        public decimal LastPrice;
    }

    public sealed record Status(string State, string? Error, DateTimeOffset? ConnectedAt, DateTimeOffset? LastFrameAt, long Frames, string Port, IReadOnlyList<StreamStatus> Streams);
    public sealed record StreamStatus(string Underlying, string Symbol, long Trades, long Quotes, long SequenceGaps, decimal Bid, long BidQty, decimal Ask, long AskQty, decimal LastPrice, DateTimeOffset? LastTradeAt);

    public OrderFlowEngine? EngineFor(string underlying) => _byUnderlying.TryGetValue(underlying, out var s) ? s.Engine : null;
    public TrueDataLiveInstrument? InstrumentFor(string underlying) => _byUnderlying.TryGetValue(underlying, out var s) ? s.Instrument : null;

    public Status Snapshot()
    {
        lock (_byUnderlying)
            return new Status(_state, _lastError, _connectedAt, _lastFrameAt, Interlocked.Read(ref _frames),
                _options.Live.Port == 8084 ? "production (8084)" : $"sandbox ({_options.Live.Port})",
                _byUnderlying.Values.Select(s => new StreamStatus(s.Instrument.Underlying.ToUpperInvariant(), s.Instrument.Symbol, s.Trades, s.Quotes, s.Dropped,
                    s.Bid, s.BidQty, s.Ask, s.AskQty, s.LastPrice, s.LastTradeAt)).ToList());
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
    private async Task<bool> RunOnceAsync(CancellationToken token)
    {
        _state = "connecting";
        var session = Interlocked.Increment(ref _session);
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
            _lastFrameAt = DateTimeOffset.UtcNow;
            Interlocked.Increment(ref _frames);
            var frame = TrueDataLiveParser.Parse(text);
            switch (frame.Kind)
            {
                case "login" when !subscribed:
                    _state = "connected";
                    subscribed = true;
                    var symbols = _byName.Keys.ToArray();
                    await SendAsync(socket, JsonSerializer.Serialize(new { method = "addsymbol", symbols }), token);
                    break;
                case "error":
                    _lastError = frame.Message;
                    _logger.LogWarning("TrueData live feed refused: {Message}", frame.Message);
                    if (!subscribed) { await CloseAsync(socket); return true; }
                    break;
                case "symbols":
                    Register(frame.Symbols ?? Array.Empty<TrueDataSymbol>());
                    _state = "streaming";
                    break;
                case "trade" when frame.Trade is { } trade:
                    OnTrade(trade, session);
                    break;
                case "bidask" when frame.Quote is { } quote:
                    OnQuote(quote, session);
                    break;
            }
        }
        // A login the server answered with a close and no message (a second session) reads as refused.
        return !subscribed;
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

    internal void OnTrade(TrueDataTrade t, int session)
    {
        if (StreamOf(t.SymbolId) is not { } s || t.Price <= 0) return;
        var now = Clock();
        if (s.LastSequence > 0 && t.Sequence > 0 && t.Sequence != s.LastSequence + 1 && t.Sequence > s.LastSequence) s.Dropped += t.Sequence - s.LastSequence - 1;
        if (t.Sequence > 0) s.LastSequence = t.Sequence;
        s.Trades++;
        s.LastTradeAt = t.Time ?? now;
        s.LastPrice = t.Price;
        if (t.Bid > 0 && t.Ask > 0) (s.Bid, s.BidQty, s.Ask, s.AskQty) = (t.Bid, t.BidQty, t.Ask, t.AskQty);
        Apply(s, now, t.Time ?? now, t.Price, t.TotalVolume, (int)Math.Clamp(t.Quantity, 0, int.MaxValue), t.OpenInterest, t.Bid, t.BidQty, t.Ask, t.AskQty, session);
    }

    internal void OnQuote(TrueDataQuote q, int session)
    {
        if (StreamOf(q.SymbolId) is not { } s || q.Bid <= 0 || q.Ask <= 0) return;
        var now = Clock();
        s.Quotes++;
        (s.Bid, s.BidQty, s.Ask, s.AskQty) = (q.Bid, q.BidQty, q.Ask, q.AskQty);
        // No trade: the volume stays where it was, so the engine reads only the new best bid / ask.
        Apply(s, now, q.Time ?? now, 0, null, 0, 0, q.Bid, q.BidQty, q.Ask, q.AskQty, session);
    }

    private static void Apply(Stream s, DateTimeOffset now, DateTimeOffset exchangeTime, decimal price, long? totalVolume, int lastQty, long oi,
        decimal bid, long bidQty, decimal ask, long askQty, int session)
    {
        // A quote before any trade has no day's volume to carry: sent as volume 0 it would make the first trade's whole day
        // volume one print. The engine's first TRADE sets the baseline (its own packet carries the quote too).
        if (totalVolume is null && s.Engine.LastKnownVolume is null) return;
        var volume = totalVolume ?? s.Engine.LastKnownVolume!.Value;
        var tick = new SpotTick(0, price, 0, 0, 0, 0, volume, bid, ask, oi, exchangeTime)
        {
            LastTradedQty = lastQty,
            Bids = bid > 0 ? new[] { new DepthLevel(bid, bidQty, 1) } : null,
            Asks = ask > 0 ? new[] { new DepthLevel(ask, askQty, 1) } : null,
            ReceivedAt = now,
            FeedSession = session,
        };
        s.Engine.OnTick(tick, now);
    }
}

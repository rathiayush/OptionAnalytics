using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using OptionAnalytics.Server.Telegram;

namespace OptionAnalytics.Server.Services.OrderFlow;

/// <summary>The thresholds of the server's iceberg / big order Telegram, per index: an ICEBERG is sent once it has traded
/// `IcebergLots` lots at its level, a BIG ORDER is a print of at least `BigOrderLots` lots (0 = not sent for that index).</summary>
public sealed record OrderFlowAlertLimits(string Underlying, int IcebergLots, int BigOrderLots, DateTimeOffset? UpdatedUtc = null);

/// <summary>
/// The per-index thresholds of the iceberg / big order Telegram (OrderFlowTelegramAlerts), in one JSON file beside the
/// server scanner's own (`{Storage:ScannerRunnerPath}/order-flow-alerts.json`), set by an admin on the Order Flow page
/// (GET / PUT /api/order-flow-alerts). An index missing from it - or no file - reads its defaults.
/// </summary>
public sealed class OrderFlowAlertSettingsStore
{
    public static readonly string[] Underlyings = { "NIFTY", "BANKNIFTY", "SENSEX" };
    public const int MaxLots = 100_000;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public static OrderFlowAlertLimits Default(string underlying) => new(underlying, 100, 100);

    private readonly string _path;
    private readonly object _lock = new();

    public OrderFlowAlertSettingsStore(ScannerRunnerStore scanner) : this(Path.Combine(scanner.DataDirectory, "order-flow-alerts.json"))
    {
    }

    internal OrderFlowAlertSettingsStore(string path)
    {
        _path = path;
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
    }

    public IReadOnlyList<OrderFlowAlertLimits> All()
    {
        lock (_lock)
        {
            var saved = Read();
            return Underlyings.Select(u => saved.TryGetValue(u, out var x) ? x : Default(u)).ToList();
        }
    }

    public OrderFlowAlertLimits Get(string underlying) => All().FirstOrDefault(x => x.Underlying == underlying) ?? Default(underlying);

    public (OrderFlowAlertLimits? Saved, string? Error) Save(string underlying, int icebergLots, int bigOrderLots)
    {
        var u = (underlying ?? "").Trim().ToUpperInvariant();
        if (!Underlyings.Contains(u)) return (null, $"Unknown index {underlying}.");
        if (icebergLots is < 0 or > MaxLots || bigOrderLots is < 0 or > MaxLots) return (null, $"Lots must be 0 (off) to {MaxLots:N0}.");
        var saved = new OrderFlowAlertLimits(u, icebergLots, bigOrderLots, DateTimeOffset.UtcNow);
        lock (_lock)
        {
            var rows = Read();
            rows[u] = saved;
            var temp = _path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(Underlyings.Where(rows.ContainsKey).Select(x => rows[x]).ToList(), Json));
            File.Move(temp, _path, overwrite: true);
        }
        return (saved, null);
    }

    private Dictionary<string, OrderFlowAlertLimits> Read()
    {
        var rows = new Dictionary<string, OrderFlowAlertLimits>();
        try
        {
            if (!File.Exists(_path)) return rows;
            foreach (var x in JsonSerializer.Deserialize<List<OrderFlowAlertLimits>>(File.ReadAllText(_path), Json) ?? new())
                if (x is not null && Underlyings.Contains(x.Underlying)) rows[x.Underlying] = x with { IcebergLots = Math.Clamp(x.IcebergLots, 0, MaxLots), BigOrderLots = Math.Clamp(x.BigOrderLots, 0, MaxLots) };
        }
        catch (Exception ex) when (ex is IOException or JsonException) { /* defaults */ }
        return rows;
    }
}

/// <summary>
/// The decisions of the iceberg / big order Telegram, kept apart from the timer so they can be tested on their own: given what
/// an index's Order Flow engine holds now (OrderFlowEngine.AlertReads), the messages to send.
///  - ICEBERG (a hidden buyer at a bid / seller at an offer - the engine's own detection: more than 2x the most ever shown
///    there traded while the level stayed in the book): ONCE, when it has traded at least `IcebergLots` lots. Keyed by
///    index, side, price and start (the day's keys kept on disk by the service - a restart sends none again); on the first
///    look of the day / after a restart, an iceberg that already ended is history, not news, and is marked without a message.
///  - BIG ORDER: every print of at least `BigOrderLots` lots after the last one seen (the first look starts from now - a
///    restart does not send the morning's), gathered and sent at most once every `BigOrderGap` (20 s) an index - one message
///    for one print, one listing them (up to `MaxListed`) for several - so a burst never floods the channel (a Telegram group
///    takes about 20 messages a minute).
/// Everything resets with the engine's day or a new contract.
/// </summary>
public sealed class OrderFlowAlertWatch
{
    public static readonly TimeSpan BigOrderGap = TimeSpan.FromSeconds(20);
    public const int MaxListed = 10;

    private sealed class IndexState
    {
        public DateOnly? Day;
        public uint SecurityId;
        public long? LastSeq;
        public bool Primed;
        public readonly List<OrderFlowTrade> Pending = new();
        public DateTimeOffset LastBigSent = DateTimeOffset.MinValue;
    }

    private readonly Dictionary<string, IndexState> _state = new();
    private readonly HashSet<string> _sent = new();
    private DateOnly? _sentDay;

    /// <summary>The iceberg keys sent today (the service keeps them on disk).</summary>
    public IReadOnlyCollection<string> SentKeys => _sent;
    public DateOnly? SentDay => _sentDay;

    /// <summary>Puts back the keys a previous run sent on `day` (read from disk at start).</summary>
    public void Restore(DateOnly day, IEnumerable<string> keys)
    {
        _sentDay = day;
        _sent.Clear();
        foreach (var k in keys) _sent.Add(k);
    }

    /// <summary>The sequence to read prints after for `underlying` (null = none yet: read none, just learn where it is).</summary>
    public long? AfterSeq(string underlying, uint securityId, DateOnly? day) =>
        _state.TryGetValue(underlying, out var s) && s.SecurityId == securityId && s.Day == day ? s.LastSeq : null;

    /// <summary>The messages for one look at an index (`reads` read with AfterSeq), as plain text. `changed` - the iceberg
    /// keys changed (save them).</summary>
    public IReadOnlyList<string> Step(string underlying, uint securityId, OrderFlowAlertReads reads, OrderFlowAlertLimits limits, DateTimeOffset now, out bool changed)
    {
        changed = false;
        var messages = new List<string>();
        if (reads.Day is not { } day) return messages;
        if (_sentDay != day) { _sentDay = day; _sent.Clear(); changed = true; }
        if (!_state.TryGetValue(underlying, out var s) || s.SecurityId != securityId || s.Day != day)
            _state[underlying] = s = new IndexState { Day = day, SecurityId = securityId };
        var lot = Math.Max(1, reads.LotSize);

        // Icebergs.
        if (limits.IcebergLots > 0)
        {
            foreach (var i in reads.Icebergs)
            {
                if (i.Traded < (long)limits.IcebergLots * lot) continue;
                var key = IcebergKey(underlying, i);
                if (!_sent.Add(key)) continue;
                changed = true;
                if (!s.Primed && i.EndedAt is not null) continue;
                messages.Add(IcebergText(underlying, i, lot, now));
            }
        }

        // Big orders - none on the first look (it only learns the last print), then every big print after it.
        if (s.LastSeq is not null && limits.BigOrderLots > 0)
            foreach (var t in reads.Trades) if (t.Seq > s.LastSeq && t.Quantity >= (long)limits.BigOrderLots * lot) s.Pending.Add(t);
        s.LastSeq = Math.Max(s.LastSeq ?? 0, reads.LastSeq);
        s.Primed = true;
        if (s.Pending.Count > 0 && now - s.LastBigSent >= BigOrderGap)
        {
            messages.Add(BigOrderText(underlying, s.Pending, lot));
            s.Pending.Clear();
            s.LastBigSent = now;
        }
        return messages;
    }

    internal static string IcebergKey(string underlying, OrderFlowIceberg i) =>
        $"{underlying}|{(i.IsBid ? "bid" : "ask")}|{i.Price.ToString(CultureInfo.InvariantCulture)}|{i.StartedAt.ToUnixTimeSeconds()}";

    private static string Lots(long quantity, int lot) => (quantity / (double)lot).ToString(quantity / (double)lot >= 10 ? "N0" : "0.#", CultureInfo.InvariantCulture);
    private static string Price(decimal p) => p.ToString("0.##", CultureInfo.InvariantCulture);
    private static string Clock(DateTimeOffset t) => t.ToOffset(IstClock.Offset).ToString("HH:mm:ss", CultureInfo.InvariantCulture);

    /// <summary>"🧊 Iceberg NIFTY futures: hidden BUYER at the bid 24510 · 120 lots traded there (15 shown at most) · 4 refills · still active · 10:32:15".</summary>
    public static string IcebergText(string underlying, OrderFlowIceberg i, int lot, DateTimeOffset now) =>
        $"🧊 Iceberg {underlying} futures: hidden {(i.IsBid ? "BUYER at the bid" : "SELLER at the offer")} {Price(i.Price)} · {Lots(i.Traded, lot)} lots traded there ({Lots(i.MaxDisplayed, lot)} shown at most)"
        + (i.Refills > 0 ? $" · {i.Refills} refills" : "") + (i.EndedAt is null ? " · still active" : " · ended") + $" · {Clock(now)}";

    /// <summary>One print: "🐋 Big order NIFTY futures: BUY 150 lots @ 24512.5 · 10:32:15"; several: a heading with what was
    /// bought / sold, then a line each (the first MaxListed).</summary>
    public static string BigOrderText(string underlying, IReadOnlyList<OrderFlowTrade> trades, int lot)
    {
        static string Line(OrderFlowTrade t, int lot) => $"{(t.Buy ? "BUY" : "SELL")} {Lots(t.Quantity, lot)} lots @ {Price(t.Price)} · {Clock(t.Time)}";
        if (trades.Count == 1) return $"🐋 Big order {underlying} futures: {Line(trades[0], lot)}";
        var bought = trades.Where(t => t.Buy).Sum(t => t.Quantity);
        var sold = trades.Where(t => !t.Buy).Sum(t => t.Quantity);
        var text = new StringBuilder($"🐋 Big orders {underlying} futures: {trades.Count} prints - bought {Lots(bought, lot)} lots, sold {Lots(sold, lot)} lots");
        foreach (var t in trades.Take(MaxListed)) text.Append('\n').Append(Line(t, lot));
        if (trades.Count > MaxListed) text.Append($"\n… and {trades.Count - MaxListed} more");
        return text.ToString();
    }
}

/// <summary>
/// The ICEBERG and BIG ORDER Telegram, sent BY THE SERVER for NIFTY, BANKNIFTY and SENSEX whether or not a page is open
/// (asked for - "iceberg orders and big orders should always send messages on Telegram, server side"): every 2 s in the F&amp;O
/// session it reads each index's live Order Flow engine (OrderFlowService - the near futures, all day) and sends what
/// OrderFlowAlertWatch decides, at the thresholds of OrderFlowAlertSettingsStore. No Dhan call - the engines' memory only.
/// The day's sent iceberg keys are kept on disk (`order-flow-alerts-sent.json` beside the settings), so a restart never sends
/// one twice. Every message also lands in the Telegram message log (TelegramAlertService) like any other.
/// </summary>
public sealed class OrderFlowTelegramAlerts : BackgroundService
{
    private static readonly TimeSpan Every = TimeSpan.FromSeconds(2);
    private readonly OrderFlowService _orderFlow;
    private readonly OrderFlowAlertSettingsStore _settings;
    private readonly TelegramAlertService _telegram;
    private readonly ILogger<OrderFlowTelegramAlerts> _logger;
    private readonly string _sentPath;
    private readonly OrderFlowAlertWatch _watch = new();

    public OrderFlowTelegramAlerts(OrderFlowService orderFlow, OrderFlowAlertSettingsStore settings, TelegramAlertService telegram, ScannerRunnerStore scanner, ILogger<OrderFlowTelegramAlerts> logger)
    {
        _orderFlow = orderFlow;
        _settings = settings;
        _telegram = telegram;
        _logger = logger;
        _sentPath = Path.Combine(scanner.DataDirectory, "order-flow-alerts-sent.json");
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var background = MarketHours.BackgroundScope();
        LoadSent();
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (MarketHours.InTradingSession(DateTimeOffset.UtcNow)) await RoundAsync(stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogWarning(ex, "Order flow Telegram round failed.");
            }
            try { await Task.Delay(Every, stoppingToken); } catch (OperationCanceledException) { return; }
        }
    }

    private async Task RoundAsync(CancellationToken cancellationToken)
    {
        var save = false;
        foreach (var u in OrderFlowAlertSettingsStore.Underlyings)
        {
            var engine = _orderFlow.EngineFor(u);
            if (engine is null) continue;
            var limits = _settings.Get(u);
            if (limits.IcebergLots <= 0 && limits.BigOrderLots <= 0) continue;
            var day = engine.ExportDayDate();
            var after = _watch.AfterSeq(u, engine.SecurityId, day) ?? long.MaxValue;
            var minQty = limits.BigOrderLots > 0 ? (long)limits.BigOrderLots * Math.Max(1, engine.LotSize) : long.MaxValue;
            var reads = engine.AlertReads(after, minQty);
            var messages = _watch.Step(u, engine.SecurityId, reads, limits, DateTimeOffset.UtcNow, out var changed);
            save |= changed;
            foreach (var m in messages) await _telegram.SendAsync(WebUtility.HtmlEncode(m), cancellationToken);
        }
        if (save) SaveSent();
    }

    private void LoadSent()
    {
        try
        {
            if (!File.Exists(_sentPath)) return;
            var saved = JsonSerializer.Deserialize<SentKeys>(File.ReadAllText(_sentPath));
            if (saved is not null && saved.Day == IstClock.Today()) _watch.Restore(saved.Day, saved.Keys ?? new());
        }
        catch (Exception ex) when (ex is IOException or JsonException) { _logger.LogWarning(ex, "Could not read the order flow Telegram's sent keys."); }
    }

    private void SaveSent()
    {
        try
        {
            if (_watch.SentDay is not { } day) return;
            var temp = _sentPath + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(new SentKeys(day, _watch.SentKeys.ToList())));
            File.Move(temp, _sentPath, overwrite: true);
        }
        catch (IOException ex) { _logger.LogWarning(ex, "Could not save the order flow Telegram's sent keys."); }
    }

    private sealed record SentKeys(DateOnly Day, List<string>? Keys);
}

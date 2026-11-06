using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using OptionAnalytics.Server.Telegram;

namespace OptionAnalytics.Server.Services.SignalStrategies;

/// <summary>
/// The Signal backtest's SAVED STRATEGIES and what their daily LIVE scan has done - all CSV, no database, under
/// {Storage:ScannerRunnerPath}/signal-strategies/:
/// <list type="bullet">
/// <item>strategies.csv - one row a strategy: id, name, owner, index, the Live / Alerts / Daily report switches, when it
/// was made and changed, and its settings (the page's - the rule, levels, timeframe - as one JSON cell);</item>
/// <item>history/{id}-days.csv - a row a day the live scan reported: trades, wins, net, charges, signals, when reported;</item>
/// <item>history/{id}-trades.csv - every closed trade of those days (the backtest CSV's columns);</item>
/// <item>history/{id}-events.csv - every live entry / exit sent, keyed so each goes out ONCE (a restart sends nothing twice);</item>
/// <item>history/{id}-orders.csv - the LIVE Dhan orders (SignalLiveOrders) for a strategy an admin armed: each entry placed,
/// not placed (and why) or skipped, each exit - with Dhan's order ids, so the exit closes exactly the entry's orders.</item>
/// </list>
/// Telegram: a new entry / exit when the strategy's Alerts is on, the day's report once when its Daily report is on.
/// Nothing here places an order: the live scan's events are kept here, and SignalLiveOrders places a strategy's orders only
/// when an admin turned its "Live orders" (LiveOrders) on.
/// </summary>
public sealed class SignalStrategyStore
{
    public const int MaxStrategiesPerOwner = 50;
    public const int MaxSettingsBytes = 64 * 1024;
    public static readonly string[] Underlyings = { "NIFTY", "BANKNIFTY", "SENSEX" };
    public static readonly string[] StrategyColumns = { "id", "name", "owner", "underlying", "live", "alerts", "dailyReport", "createdUtc", "updatedUtc", "settings", "liveOrders" };
    public static readonly string[] DayColumns = { "date", "underlying", "trades", "wins", "losses", "winRate", "net", "gross", "charges", "points", "signals", "limit", "reportedUtc" };
    public static readonly string[] TradeColumns = { "date", "side", "signal", "action", "option", "entryTime", "entry", "exitTime", "exit", "exitReason", "points", "gross", "charges", "net", "expiryDay", "why" };
    public static readonly string[] EventColumns = { "timeUtc", "date", "kind", "key", "text" };
    public static readonly string[] OrderColumns = { "timeUtc", "date", "trade", "kind", "status", "underlying", "option", "action", "lots", "orderIds", "message" };
    public static readonly string[] HistoryKinds = { "days", "trades", "events", "orders" };

    private readonly object _lock = new();
    private readonly string _dir;
    private readonly TelegramAlertService? _telegram;
    private readonly ILogger<SignalStrategyStore> _logger;

    /// <summary>Tests: what a Telegram message would do.</summary>
    internal Func<string, Task>? NotifyOverride { get; set; }

    public SignalStrategyStore(ScannerRunnerStore store, ILogger<SignalStrategyStore> logger, TelegramAlertService? telegram = null)
    {
        _dir = Path.Combine(store.DataDirectory, "signal-strategies");
        Directory.CreateDirectory(Path.Combine(_dir, "history"));
        _telegram = telegram;
        _logger = logger;
    }

    private string StrategiesPath => Path.Combine(_dir, "strategies.csv");
    public string HistoryPath(string id, string kind) => Path.Combine(_dir, "history", $"{id}-{kind}.csv");

    public static string TodayIst(DateTimeOffset now) => now.ToOffset(IstClock.Offset).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    // ---- The strategies ------------------------------------------------------------------------------------------------

    private List<SignalStrategy> ReadAll()
    {
        var list = new List<SignalStrategy>();
        foreach (var row in CsvTable.Read(StrategiesPath))
        {
            try
            {
                if (JsonNode.Parse(row.GetValueOrDefault("settings") ?? "") is not JsonObject settings) continue;
                list.Add(new SignalStrategy(row["id"], row["name"], row["owner"], row["underlying"], row["live"] == "true", row["alerts"] == "true",
                    row["dailyReport"] == "true", DateTimeOffset.Parse(row["createdUtc"], CultureInfo.InvariantCulture), DateTimeOffset.Parse(row["updatedUtc"], CultureInfo.InvariantCulture), settings,
                    row.GetValueOrDefault("liveOrders") == "true"));
            }
            catch (Exception ex) when (ex is JsonException or FormatException or KeyNotFoundException) { _logger.LogWarning("A saved strategy row could not be read: {Error}", ex.Message); }
        }
        return list;
    }

    private void WriteAll(IEnumerable<SignalStrategy> list) =>
        CsvTable.Write(StrategiesPath, StrategyColumns, list.Select(s => (IReadOnlyDictionary<string, string?>)new Dictionary<string, string?>
        {
            ["id"] = s.Id, ["name"] = s.Name, ["owner"] = s.Owner, ["underlying"] = s.Underlying, ["live"] = Bool(s.Live), ["alerts"] = Bool(s.Alerts),
            ["dailyReport"] = Bool(s.DailyReport), ["createdUtc"] = s.CreatedUtc.ToString("O"), ["updatedUtc"] = s.UpdatedUtc.ToString("O"), ["settings"] = s.Settings.ToJsonString(),
            ["liveOrders"] = Bool(s.LiveOrders),
        }));

    private static string Bool(bool v) => v ? "true" : "false";
    private static bool Same(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

    /// <summary>The strategies, by name - every account's for an admin (<paramref name="owner"/> null), else that account's.</summary>
    public IReadOnlyList<SignalStrategy> List(string? owner)
    {
        lock (_lock) return ReadAll().Where(s => owner is null || Same(s.Owner, owner)).OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    public SignalStrategy? Get(string id, string? owner)
    {
        lock (_lock) return ReadAll().FirstOrDefault(s => s.Id == id && (owner is null || Same(s.Owner, owner)));
    }

    /// <summary>The strategies the live scan runs.</summary>
    public IReadOnlyList<SignalStrategy> LiveStrategies()
    {
        lock (_lock) return ReadAll().Where(s => s.Live).ToList();
    }

    /// <summary>A strategy saved: { name, settings, live, alerts, dailyReport } checked - the strategy, or why not.</summary>
    public (SignalStrategy? Strategy, string? Error) Create(string owner, SignalStrategyRequest request, DateTimeOffset now)
    {
        var (name, settings, underlying, error) = Check(request, requireAll: true);
        if (error is not null) return (null, error);
        lock (_lock)
        {
            var all = ReadAll();
            if (all.Count(s => Same(s.Owner, owner)) >= MaxStrategiesPerOwner) return (null, $"{MaxStrategiesPerOwner} strategies are saved already - remove one first");
            if (all.Any(s => Same(s.Owner, owner) && Same(s.Name, name!))) return (null, $"A strategy is already called \"{name}\" - pick another name, or update that one");
            var strategy = new SignalStrategy($"{now:yyyyMMddHHmmss}{Guid.NewGuid().ToString("n")[..6]}", name!, owner, underlying!, request.Live ?? false,
                request.Alerts ?? true, request.DailyReport ?? true, now, now, settings!);
            all.Add(strategy);
            WriteAll(all);
            return (strategy, null);
        }
    }

    /// <summary>A strategy changed - only what the request carries (a new name, new settings, a switch). <paramref name="owner"/>
    /// null = an admin (every account's). LIVE ORDERS (real Dhan orders) are switched by an admin only; new settings saved by
    /// anyone else turn them off - what an armed strategy trades is never changed by an account that could not arm it.</summary>
    public (SignalStrategy? Strategy, string? Error) Update(string id, string? owner, SignalStrategyRequest request, DateTimeOffset now)
    {
        if (request is null) return (null, "Nothing to save.");
        if (request.LiveOrders is not null && owner is not null) return (null, "Only an admin can switch live orders.");
        var (name, settings, underlying, error) = Check(request, requireAll: false);
        if (error is not null) return (null, error);
        lock (_lock)
        {
            var all = ReadAll();
            var k = all.FindIndex(s => s.Id == id && (owner is null || Same(s.Owner, owner)));
            if (k < 0) return (null, "No such strategy.");
            var old = all[k];
            if (name is not null && all.Any(s => s.Id != id && Same(s.Owner, old.Owner) && Same(s.Name, name))) return (null, $"A strategy is already called \"{name}\"");
            all[k] = old with
            {
                Name = name ?? old.Name, Settings = settings ?? old.Settings, Underlying = underlying ?? old.Underlying, Live = request.Live ?? old.Live,
                Alerts = request.Alerts ?? old.Alerts, DailyReport = request.DailyReport ?? old.DailyReport, UpdatedUtc = now,
                LiveOrders = request.LiveOrders ?? (settings is not null && owner is not null ? false : old.LiveOrders),
            };
            WriteAll(all);
            return (all[k], null);
        }
    }

    /// <summary>A strategy and its history removed.</summary>
    public bool Delete(string id, string? owner)
    {
        lock (_lock)
        {
            var all = ReadAll();
            if (all.RemoveAll(s => s.Id == id && (owner is null || Same(s.Owner, owner))) == 0) return false;
            WriteAll(all);
            foreach (var kind in HistoryKinds) { try { File.Delete(HistoryPath(id, kind)); } catch { /* best effort */ } }
            return true;
        }
    }

    private static (string? Name, JsonObject? Settings, string? Underlying, string? Error) Check(SignalStrategyRequest? request, bool requireAll)
    {
        if (request is null) return (null, null, null, "Nothing to save.");
        string? name = null;
        if (request.Name is not null || requireAll)
        {
            name = (request.Name ?? "").Trim();
            if (name.Length == 0) return (null, null, null, "Give the strategy a name.");
            if (name.Length > 80) name = name[..80];
        }
        JsonObject? settings = null;
        string? underlying = null;
        if (request.Settings is not null || requireAll)
        {
            if (request.Settings is not JsonObject s) return (null, null, null, "The strategy's settings are missing.");
            if (s.ToJsonString().Length > MaxSettingsBytes) return (null, null, null, "The strategy's settings are too large.");
            underlying = (s["underlying"] as JsonValue)?.TryGetValue<string>(out var u) == true ? u.Trim().ToUpperInvariant() : "";
            if (!Underlyings.Contains(underlying)) return (null, null, null, "The index must be NIFTY, BANKNIFTY or SENSEX.");
            if (s["rule"] is not JsonObject) return (null, null, null, "The strategy has no rule.");
            settings = (JsonObject)s.DeepClone();
            settings["underlying"] = underlying;
        }
        return (name, settings, underlying, null);
    }

    // ---- What the live scan did ------------------------------------------------------------------------------------------

    /// <summary>The keys of the events already kept for a strategy's day.</summary>
    public HashSet<string> EventKeys(string id, string date)
    {
        lock (_lock) return CsvTable.Read(HistoryPath(id, "events")).Where(r => r.GetValueOrDefault("date") == date).Select(r => r.GetValueOrDefault("key") ?? "").ToHashSet();
    }

    /// <summary>Whether the day's report is kept already.</summary>
    public bool Reported(string id, string date)
    {
        lock (_lock) return CsvTable.Read(HistoryPath(id, "days")).Any(r => r.GetValueOrDefault("date") == date);
    }

    /// <summary>The live scan's entries / exits: those not kept yet are kept (and sent to Telegram when the strategy's Alerts
    /// is on) - each key once. Returns how many were new.</summary>
    public async Task<int> RecordEventsAsync(string id, string date, IReadOnlyList<SignalLiveEvent> events, DateTimeOffset now) =>
        (await KeepEventsAsync(id, date, events, now)).Fresh.Count;

    /// <summary>As RecordEventsAsync, returning the strategy (as it is now) and the events that were NEW - the only ones a
    /// live order may follow (a key kept before never places or closes anything again).</summary>
    public async Task<(SignalStrategy? Strategy, IReadOnlyList<SignalLiveEvent> Fresh)> KeepEventsAsync(string id, string date, IReadOnlyList<SignalLiveEvent> events, DateTimeOffset now)
    {
        var strategy = Get(id, null);
        if (strategy is null) return (null, Array.Empty<SignalLiveEvent>());
        List<SignalLiveEvent> fresh;
        lock (_lock)
        {
            var known = CsvTable.Read(HistoryPath(id, "events")).Where(r => r.GetValueOrDefault("date") == date).Select(r => r.GetValueOrDefault("key") ?? "").ToHashSet();
            fresh = events.Where(e => !string.IsNullOrWhiteSpace(e.Key) && known.Add(e.Key!)).ToList();
            if (fresh.Count == 0) return (strategy, fresh);
            CsvTable.Append(HistoryPath(id, "events"), EventColumns, fresh.Select(e => (IReadOnlyDictionary<string, string?>)new Dictionary<string, string?>
            {
                ["timeUtc"] = now.ToString("O"), ["date"] = date, ["kind"] = e.Kind, ["key"] = e.Key, ["text"] = e.Text,
            }));
        }
        if (strategy.Alerts)
            foreach (var e in fresh) await NotifyAsync(WebUtility.HtmlEncode(e.Text ?? ""));
        return (strategy, fresh);
    }

    /// <summary>A strategy's live order rows of a day, in the order they were written.</summary>
    public List<SignalOrderRow> Orders(string id, string date)
    {
        lock (_lock) return CsvTable.Read(HistoryPath(id, "orders")).Where(r => r.GetValueOrDefault("date") == date).Select(SignalOrderRow.From).ToList();
    }

    /// <summary>A live order row kept (an entry placed / not placed / skipped, an exit).</summary>
    public void RecordOrder(string id, SignalOrderRow row)
    {
        lock (_lock) CsvTable.Append(HistoryPath(id, "orders"), OrderColumns, new[] { row.ToRow() });
    }

    /// <summary>The day's report: its row and closed trades replace any kept for that date; Telegram (when Daily report is
    /// on) only the first time the day is reported. Returns whether it was the first time.</summary>
    public async Task<bool> RecordDayAsync(string id, string date, JsonObject? day, JsonArray? trades, string? text, DateTimeOffset now)
    {
        var strategy = Get(id, null);
        if (strategy is null || day is null) return false;
        bool first;
        lock (_lock)
        {
            var days = CsvTable.Read(HistoryPath(id, "days"));
            first = !days.Any(r => r.GetValueOrDefault("date") == date);
            var row = DayColumns.ToDictionary(c => c, c => (string?)Text(day[c]), StringComparer.OrdinalIgnoreCase);
            row["date"] = date;
            row["reportedUtc"] = days.FirstOrDefault(r => r.GetValueOrDefault("date") == date)?.GetValueOrDefault("reportedUtc") ?? now.ToString("O");
            var keptDays = days.Where(r => r.GetValueOrDefault("date") != date).Select(r => (IReadOnlyDictionary<string, string?>)r.ToDictionary(kv => kv.Key, kv => (string?)kv.Value)).ToList();
            keptDays.Add(row);
            CsvTable.Write(HistoryPath(id, "days"), DayColumns, keptDays.OrderBy(r => r["date"], StringComparer.Ordinal));
            var keptTrades = CsvTable.Read(HistoryPath(id, "trades")).Where(r => r.GetValueOrDefault("date") != date)
                .Select(r => (IReadOnlyDictionary<string, string?>)r.ToDictionary(kv => kv.Key, kv => (string?)kv.Value)).ToList();
            foreach (var t in (trades ?? new JsonArray()).OfType<JsonObject>())
            {
                var tr = TradeColumns.ToDictionary(c => c, c => (string?)Text(t[c]), StringComparer.OrdinalIgnoreCase);
                tr["date"] = date;
                keptTrades.Add(tr);
            }
            CsvTable.Write(HistoryPath(id, "trades"), TradeColumns, keptTrades.OrderBy(r => r["date"], StringComparer.Ordinal));
        }
        if (first && strategy.DailyReport && !string.IsNullOrWhiteSpace(text)) await NotifyAsync(WebUtility.HtmlEncode(text));
        return first;
    }

    private static string? Text(JsonNode? node) => node switch
    {
        null => null,
        JsonValue v when v.TryGetValue<double>(out var d) => d.ToString("0.##", CultureInfo.InvariantCulture),
        JsonValue v when v.TryGetValue<string>(out var s) => s,
        JsonValue v when v.TryGetValue<bool>(out var b) => b ? "true" : "false",
        _ => node.ToJsonString(),
    };

    /// <summary>A strategy's history: its days (newest first), their trades and the latest events.</summary>
    public SignalStrategyHistory History(string id)
    {
        lock (_lock)
        {
            var days = CsvTable.Read(HistoryPath(id, "days")).OrderByDescending(r => r.GetValueOrDefault("date"), StringComparer.Ordinal).ToList();
            var trades = CsvTable.Read(HistoryPath(id, "trades")).OrderByDescending(r => r.GetValueOrDefault("date"), StringComparer.Ordinal).ToList();
            var events = CsvTable.Read(HistoryPath(id, "events"));
            var orders = CsvTable.Read(HistoryPath(id, "orders"));
            return new SignalStrategyHistory(days, trades, events.Skip(Math.Max(0, events.Count - 200)).Reverse().ToList(),
                orders.Skip(Math.Max(0, orders.Count - 200)).Reverse().ToList());
        }
    }

    /// <summary>The last day reported and today's live events, for the list.</summary>
    public (Dictionary<string, string>? LastDay, int EventsToday) Glance(string id, string today)
    {
        lock (_lock)
        {
            var last = CsvTable.Read(HistoryPath(id, "days")).OrderByDescending(r => r.GetValueOrDefault("date"), StringComparer.Ordinal).FirstOrDefault();
            var events = CsvTable.Read(HistoryPath(id, "events")).Count(r => r.GetValueOrDefault("date") == today);
            return (last, events);
        }
    }

    private async Task NotifyAsync(string html)
    {
        try
        {
            if (NotifyOverride is { } notify) await notify(html);
            else if (_telegram is not null) await _telegram.SendAsync(html, CancellationToken.None);
        }
        catch (Exception ex) { _logger.LogWarning(ex, "Saved strategy: the Telegram message could not be sent."); }
    }
}

/// <summary>A saved strategy: its name, owner, index, the live scan's switches, its settings (the page's) and whether it
/// places LIVE Dhan orders (an admin's switch, off by default).</summary>
public sealed record SignalStrategy(string Id, string Name, string Owner, string Underlying, bool Live, bool Alerts, bool DailyReport,
    DateTimeOffset CreatedUtc, DateTimeOffset UpdatedUtc, JsonObject Settings, bool LiveOrders = false);

/// <summary>A strategy saved or changed from the page (null = left as it is). LiveOrders: an admin only (a new strategy
/// is never saved with it on).</summary>
public sealed record SignalStrategyRequest(string? Name = null, JsonNode? Settings = null, bool? Live = null, bool? Alerts = null, bool? DailyReport = null,
    bool? LiveOrders = null);

/// <summary>An entry / exit the live scan saw (its key makes it once), with the trade it belongs to.</summary>
public sealed record SignalLiveEvent(string? Key, string? Kind, string? Text, SignalLiveTrade? Trade = null);

/// <summary>The trade behind a live event (signalLive.js - liveTrade): its key (date|rule-or-mirror|entry ms, the same for
/// its entry and its exit), the TRADED index, the options' expiry, strike, CE / PE, BUY / SELL, the entry premium and its
/// time (epoch ms - the signal minute's start), the strategy's own stop-loss / target in premium points from that entry (0 =
/// none), rule or mirror, and an exit's reason.</summary>
public sealed record SignalLiveTrade(string? Key, string? Underlying, string? Expiry, decimal? Strike, string? Side, string? Action,
    decimal? Entry, long? EntryTime, decimal? StopLossPoints, decimal? TargetPoints, string? Strategy = null, string? ExitReason = null);

/// <summary>One line of a strategy's live orders file (history/{id}-orders.csv).</summary>
public sealed record SignalOrderRow(DateTimeOffset TimeUtc, string Date, string Trade, string Kind, string Status, string Underlying, string Option,
    string Action, int Lots, IReadOnlyList<string> OrderIds, string Message)
{
    internal IReadOnlyDictionary<string, string?> ToRow() => new Dictionary<string, string?>
    {
        ["timeUtc"] = TimeUtc.ToString("O"), ["date"] = Date, ["trade"] = Trade, ["kind"] = Kind, ["status"] = Status, ["underlying"] = Underlying,
        ["option"] = Option, ["action"] = Action, ["lots"] = Lots.ToString(CultureInfo.InvariantCulture), ["orderIds"] = string.Join(' ', OrderIds), ["message"] = Message,
    };

    internal static SignalOrderRow From(Dictionary<string, string> r) => new(
        DateTimeOffset.TryParse(r.GetValueOrDefault("timeUtc"), CultureInfo.InvariantCulture, DateTimeStyles.None, out var t) ? t : DateTimeOffset.MinValue,
        r.GetValueOrDefault("date") ?? "", r.GetValueOrDefault("trade") ?? "", r.GetValueOrDefault("kind") ?? "", r.GetValueOrDefault("status") ?? "",
        r.GetValueOrDefault("underlying") ?? "", r.GetValueOrDefault("option") ?? "", r.GetValueOrDefault("action") ?? "",
        int.TryParse(r.GetValueOrDefault("lots"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var lots) ? lots : 0,
        (r.GetValueOrDefault("orderIds") ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries), r.GetValueOrDefault("message") ?? "");
}

public sealed record SignalStrategyHistory(List<Dictionary<string, string>> Days, List<Dictionary<string, string>> Trades, List<Dictionary<string, string>> Events,
    List<Dictionary<string, string>> Orders);

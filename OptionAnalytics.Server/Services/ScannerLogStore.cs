using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// The Order Flow strategy scanner's record on the server as TWO CSV files under
/// Storage:ScannerLogPath (env Storage__ScannerLogPath; /app/data/scanner-log on the volume), each holding
/// every underlying and every day - no file per day:
///   signals.csv - one row per signal: its levels, the day type and the adaptive call when it fired,
///                 its outcome;
///   trades.csv  - one row per option trade punched (paper or live): premiums, points, rupees, its exit,
///                 and the signal it came from with that signal's adaptive call.
/// The browser keeps its own copy; this one lasts and is the same for every device. The scanner posts a
/// day's rows as they change (outcomes resolve during the day): each row has a key, a posted row
/// replaces the stored row with that key, every other row is kept, and a file is rewritten atomically
/// (temp file + move) under a lock.
/// </summary>
public sealed class ScannerLogStore
{
    public const string SignalsFile = "signals.csv";
    public const string TradesFile = "trades.csv";
    /// <summary>The server-side scanner (source "server") keeps its own two files beside these - run side by side
    /// with the page, the same signal must not overwrite the page's row.</summary>
    public const string ServerPrefix = "server-";
    public static string FilePrefix(string? source) => source == "server" ? ServerPrefix : "";
    public const int MaxSignals = 3000;
    public const int MaxTrades = 1000;
    private const int MaxText = 400;
    private static readonly Regex UnderlyingPattern = new("^[A-Z]{2,20}$", RegexOptions.Compiled);
    private static readonly TimeSpan Ist = TimeSpan.FromMinutes(330);

    public static readonly string[] SignalColumns =
    {
        "key", "date", "underlying", "time_ist", "strategy_no", "strategy_id", "strategy", "side", "entry", "stop", "target",
        "confidence", "estimated", "day_type", "day_type_price", "vote_oi", "vote_cvd", "adaptive_take", "adaptive_price_only",
        "adaptive_reason", "status", "r", "points", "exit_time_ist", "exit_price", "exit_reason", "source", "user", "updated_utc",
    };

    public static readonly string[] TradeColumns =
    {
        "key", "date", "underlying", "entry_time_ist", "exit_time_ist", "live", "action", "option", "strike", "lots", "lot_size",
        "entry_premium", "exit_premium", "points", "rupees", "stt", "brokerage", "other_charges", "net_rupees", "net_per_lot",
        "exit_reason", "signal_time_ist", "strategy_no", "strategy_id",
        "signal_side", "day_type", "adaptive_take", "adaptive_reason", "source", "user", "updated_utc",
    };

    private readonly string _directory;
    private readonly SemaphoreSlim _lock = new(1, 1);
    private readonly ILogger<ScannerLogStore> _logger;

    public ScannerLogStore(IHostEnvironment environment, IConfiguration configuration, ILogger<ScannerLogStore> logger)
    {
        var configured = configuration["Storage:ScannerLogPath"];
        var relativeOrAbsolute = string.IsNullOrWhiteSpace(configured) ? "scanner-log" : configured;
        _directory = Path.IsPathRooted(relativeOrAbsolute) ? relativeOrAbsolute : Path.Combine(environment.ContentRootPath, relativeOrAbsolute);
        Directory.CreateDirectory(_directory);
        _logger = logger;
    }

    /// <summary>The full path of 'signals' / 'trades', else null.</summary>
    public string? PathOf(string kind) => kind switch
    {
        "signals" => Path.Combine(_directory, SignalsFile),
        "trades" => Path.Combine(_directory, TradesFile),
        "server-signals" => Path.Combine(_directory, ServerPrefix + SignalsFile),
        "server-trades" => Path.Combine(_directory, ServerPrefix + TradesFile),
        _ => null,
    };

    /// <summary>Validates and upserts one day's signals and trades. Returns the rows written, or an error
    /// for a request that is not a valid day.</summary>
    public async Task<(int Signals, int Trades, string? Error)> UpsertDayAsync(ScannerLogDayRequest request, string? user, CancellationToken cancellationToken)
    {
        var underlying = request.Underlying?.Trim().ToUpperInvariant() ?? "";
        if (!UnderlyingPattern.IsMatch(underlying)) return (0, 0, "Bad underlying.");
        if (!DateOnly.TryParseExact(request.Date ?? "", "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)
            || date.Year < 2020 || date > DateOnly.FromDateTime(DateTime.UtcNow).AddDays(1))
            return (0, 0, "Bad date.");
        var signals = request.Signals ?? new List<ScannerSignalRow>();
        var trades = request.Trades ?? new List<ScannerTradeRow>();
        if (signals.Count > MaxSignals || trades.Count > MaxTrades) return (0, 0, "Too many rows.");
        var source = Text(request.Source);
        var who = Text(user);
        var now = DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);
        var day = date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

        var signalRows = signals.Where((s) => s.Time > 0 && !string.IsNullOrWhiteSpace(s.StrategyId)).Select((s) => new Dictionary<string, string>
        {
            ["key"] = $"{underlying}|{day}|{Text(s.StrategyId)}|{Text(s.Side)}|{s.Time}",
            ["date"] = day, ["underlying"] = underlying, ["time_ist"] = IstTime(s.Time),
            ["strategy_no"] = Num(s.StrategyNo), ["strategy_id"] = Text(s.StrategyId), ["strategy"] = Text(s.Strategy), ["side"] = Text(s.Side),
            ["entry"] = Num(s.Entry), ["stop"] = Num(s.Stop), ["target"] = Num(s.Target), ["confidence"] = Num(s.Confidence),
            ["estimated"] = Bool(s.Estimated), ["day_type"] = Text(s.DayType), ["day_type_price"] = Text(s.DayTypePrice),
            ["vote_oi"] = Text(s.VoteOi), ["vote_cvd"] = Text(s.VoteCvd), ["adaptive_take"] = Bool(s.AdaptiveTake),
            ["adaptive_price_only"] = Bool(s.AdaptivePriceOnly), ["adaptive_reason"] = Text(s.AdaptiveReason),
            ["status"] = Text(s.Status), ["r"] = Num(s.R), ["points"] = Num(FuturesPoints(s.Side, s.Entry, s.ExitPrice, s.Status)), ["exit_time_ist"] = s.ExitTime is > 0 ? IstTime(s.ExitTime.Value) : "",
            ["exit_price"] = Num(s.ExitPrice), ["exit_reason"] = Text(s.ExitReason), ["source"] = source, ["user"] = who, ["updated_utc"] = now,
        }).ToList();
        var tradeRows = trades.Where((t) => !string.IsNullOrWhiteSpace(t.Key) && t.EntryTime > 0).Select((t) => new Dictionary<string, string>
        {
            ["key"] = $"{underlying}|{day}|{Text(t.Key)}", ["date"] = day, ["underlying"] = underlying, ["entry_time_ist"] = IstTime(t.EntryTime),
            ["exit_time_ist"] = t.ExitTime is > 0 ? IstTime(t.ExitTime.Value) : "", ["live"] = Bool(t.Live), ["action"] = Text(t.Action),
            ["option"] = Text(t.Option), ["strike"] = Num(t.Strike), ["lots"] = Num(t.Lots), ["lot_size"] = Num(t.LotSize),
            ["entry_premium"] = Num(t.EntryPremium), ["exit_premium"] = Num(t.ExitPremium), ["points"] = Num(t.Points), ["rupees"] = Num(t.Rupees),
            ["stt"] = Num(t.Stt), ["brokerage"] = Num(t.Brokerage), ["other_charges"] = Num(t.OtherCharges), ["net_rupees"] = Num(t.NetRupees), ["net_per_lot"] = Num(t.NetPerLot),
            ["exit_reason"] = Text(t.ExitReason), ["signal_time_ist"] = t.SignalTime is > 0 ? IstTime(t.SignalTime.Value) : "",
            ["strategy_no"] = Num(t.StrategyNo), ["strategy_id"] = Text(t.StrategyId), ["signal_side"] = Text(t.SignalSide),
            ["day_type"] = Text(t.DayType), ["adaptive_take"] = Bool(t.AdaptiveTake), ["adaptive_reason"] = Text(t.AdaptiveReason),
            ["source"] = source, ["user"] = who, ["updated_utc"] = now,
        }).ToList();

        await _lock.WaitAsync(cancellationToken);
        try
        {
            var prefix = FilePrefix(request.Source);
            if (signalRows.Count > 0) Upsert(Path.Combine(_directory, prefix + SignalsFile), SignalColumns, signalRows, "time_ist");
            if (tradeRows.Count > 0) Upsert(Path.Combine(_directory, prefix + TradesFile), TradeColumns, tradeRows, "entry_time_ist");
        }
        finally
        {
            _lock.Release();
        }
        return (signalRows.Count, tradeRows.Count, null);
    }

    // The futures points a closed signal captured: exit - entry for a LONG, entry - exit for a SHORT.
    internal static bool IsClosed(string? status) => status is "win" or "loss" or "flat";

    internal static double? FuturesPoints(string? side, double? entry, double? exit, string? status)
    {
        if (!IsClosed(status) || entry is not { } e || exit is not { } x || !double.IsFinite(e) || !double.IsFinite(x)) return null;
        return string.Equals(side, "SHORT", StringComparison.OrdinalIgnoreCase) ? e - x : x - e;
    }

    /// <summary>The totals of everything stored, per underlying: one row per day and a TOTAL row per
    /// underlying (see ScannerSummaryRow). Read from the two CSV files, so it is always what the files say.</summary>
    public async Task<IReadOnlyList<ScannerSummaryRow>> SummaryAsync(CancellationToken cancellationToken, string? source = null)
    {
        List<Dictionary<string, string>> signals, trades;
        var prefix = FilePrefix(source);
        await _lock.WaitAsync(cancellationToken);
        try
        {
            signals = Read(Path.Combine(_directory, prefix + SignalsFile)).ToList();
            trades = Read(Path.Combine(_directory, prefix + TradesFile)).ToList();
        }
        finally
        {
            _lock.Release();
        }
        return Summarize(signals, trades);
    }

    internal static IReadOnlyList<ScannerSummaryRow> Summarize(IEnumerable<Dictionary<string, string>> signals, IEnumerable<Dictionary<string, string>> trades)
    {
        static string C(Dictionary<string, string> r, string k) => r.GetValueOrDefault(k, "");
        static double? N(Dictionary<string, string> r, string k) =>
            double.TryParse(C(r, k), NumberStyles.Float, CultureInfo.InvariantCulture, out var v) && double.IsFinite(v) ? v : null;
        var acc = new Dictionary<(string Underlying, string Date), Acc>();
        Acc At(Dictionary<string, string> r) => acc.TryGetValue((C(r, "underlying"), C(r, "date")), out var a) ? a : acc[(C(r, "underlying"), C(r, "date"))] = new Acc();
        foreach (var r in signals)
        {
            var a = At(r);
            var take = C(r, "adaptive_take") == "true";
            a.Signals++;
            if (take) a.AdaptiveSignals++;
            if (!IsClosed(C(r, "status"))) continue;
            // The points column; older rows (before it existed) derive it from entry / exit.
            var pts = N(r, "points") ?? FuturesPoints(C(r, "side"), N(r, "entry"), N(r, "exit_price"), C(r, "status")) ?? 0;
            var rr = N(r, "r") ?? 0;
            a.Closed++;
            if (C(r, "status") == "win") a.Wins++;
            a.FuturesPoints += pts; a.TotalR += rr;
            if (take) a.AdaptiveFuturesPoints += pts;
        }
        foreach (var r in trades)
        {
            var a = At(r);
            var take = C(r, "adaptive_take") == "true";
            var pts = N(r, "points") ?? 0;
            var net = N(r, "net_rupees") ?? N(r, "rupees") ?? 0;
            a.Trades++;
            var tag = C(r, "adaptive_take");
            if (tag == "false") { a.NonAdaptiveTrades++; a.NonAdaptiveOptionPoints += pts; a.NonAdaptiveNet += net; a.NonAdaptiveNetPerLot += N(r, "net_per_lot") ?? 0; }
            else if (tag != "true") a.UntaggedTrades++;
            if (C(r, "live") == "true") a.LiveTrades++;
            if (C(r, "exit_time_ist").Length == 0) a.OpenTrades++;
            a.OptionPoints += pts;
            a.Gross += N(r, "rupees") ?? 0;
            a.Charges += (N(r, "stt") ?? 0) + (N(r, "brokerage") ?? 0) + (N(r, "other_charges") ?? 0);
            a.Net += net;
            a.NetPerLot += N(r, "net_per_lot") ?? 0;
            if (take) { a.AdaptiveTrades++; a.AdaptiveOptionPoints += pts; a.AdaptiveNet += net; a.AdaptiveNetPerLot += N(r, "net_per_lot") ?? 0; }
        }
        var rows = new List<ScannerSummaryRow>();
        foreach (var underlying in acc.Keys.Select(k => k.Underlying).Distinct().OrderBy(u => u, StringComparer.Ordinal))
        {
            var total = new Acc();
            foreach (var ((_, date), a) in acc.Where(kv => kv.Key.Underlying == underlying).OrderBy(kv => kv.Key.Date, StringComparer.Ordinal))
            {
                rows.Add(a.ToRow("day", underlying, date));
                total.Add(a);
            }
            rows.Add(total.ToRow("total", underlying, ""));
        }
        return rows;
    }

    private sealed class Acc
    {
        public int Signals, Closed, Wins, Trades, LiveTrades, OpenTrades, AdaptiveSignals, AdaptiveTrades, NonAdaptiveTrades, UntaggedTrades;
        public double FuturesPoints, TotalR, OptionPoints, Gross, Charges, Net, NetPerLot, AdaptiveFuturesPoints, AdaptiveOptionPoints, AdaptiveNet,
            AdaptiveNetPerLot, NonAdaptiveOptionPoints, NonAdaptiveNet, NonAdaptiveNetPerLot;

        public void Add(Acc o)
        {
            Signals += o.Signals; Closed += o.Closed; Wins += o.Wins; Trades += o.Trades; LiveTrades += o.LiveTrades; OpenTrades += o.OpenTrades;
            AdaptiveSignals += o.AdaptiveSignals; AdaptiveTrades += o.AdaptiveTrades; FuturesPoints += o.FuturesPoints; TotalR += o.TotalR;
            OptionPoints += o.OptionPoints; Gross += o.Gross; Charges += o.Charges; Net += o.Net; NetPerLot += o.NetPerLot;
            AdaptiveFuturesPoints += o.AdaptiveFuturesPoints; AdaptiveOptionPoints += o.AdaptiveOptionPoints; AdaptiveNet += o.AdaptiveNet;
            NonAdaptiveTrades += o.NonAdaptiveTrades; UntaggedTrades += o.UntaggedTrades; AdaptiveNetPerLot += o.AdaptiveNetPerLot;
            NonAdaptiveOptionPoints += o.NonAdaptiveOptionPoints; NonAdaptiveNet += o.NonAdaptiveNet; NonAdaptiveNetPerLot += o.NonAdaptiveNetPerLot;
        }

        public ScannerSummaryRow ToRow(string scope, string underlying, string date) => new(scope, underlying, date, Signals, Closed, Wins,
            Closed > 0 ? Math.Round(100.0 * Wins / Closed, 1) : null, Math.Round(FuturesPoints, 2), Math.Round(TotalR, 2), Trades, LiveTrades, OpenTrades,
            Math.Round(OptionPoints, 2), Math.Round(Gross, 2), Math.Round(Charges, 2), Math.Round(Net, 2), Math.Round(NetPerLot, 2),
            AdaptiveSignals, Math.Round(AdaptiveFuturesPoints, 2), AdaptiveTrades, Math.Round(AdaptiveOptionPoints, 2), Math.Round(AdaptiveNet, 2),
            Math.Round(AdaptiveNetPerLot, 2), NonAdaptiveTrades, Math.Round(NonAdaptiveOptionPoints, 2), Math.Round(NonAdaptiveNet, 2), Math.Round(NonAdaptiveNetPerLot, 2), UntaggedTrades);
    }

    public static readonly string[] SummaryColumns =
    {
        "scope", "underlying", "date", "signals", "closed_signals", "wins", "win_pct", "futures_points", "total_r", "trades", "live_trades", "open_trades",
        "option_points", "gross_rupees", "charges", "net_rupees", "net_per_lot", "adaptive_signals", "adaptive_futures_points", "adaptive_trades",
        "adaptive_option_points", "adaptive_net_rupees", "adaptive_net_per_lot", "non_adaptive_trades", "non_adaptive_option_points",
        "non_adaptive_net_rupees", "non_adaptive_net_per_lot", "untagged_trades",
    };

    /// <summary>The summary as CSV: a row per underlying and day, then that underlying's TOTAL.</summary>
    public static string SummaryCsv(IEnumerable<ScannerSummaryRow> rows)
    {
        var sb = new StringBuilder();
        sb.Append(string.Join(',', SummaryColumns)).Append('\n');
        foreach (var r in rows)
            sb.Append(string.Join(',', new[]
            {
                r.Scope, r.Underlying, r.Date, Num(r.Signals), Num(r.ClosedSignals), Num(r.Wins), Num(r.WinPct), Num(r.FuturesPoints), Num(r.TotalR), Num(r.Trades),
                Num(r.LiveTrades), Num(r.OpenTrades), Num(r.OptionPoints), Num(r.GrossRupees), Num(r.Charges), Num(r.NetRupees), Num(r.NetPerLot),
                Num(r.AdaptiveSignals), Num(r.AdaptiveFuturesPoints), Num(r.AdaptiveTrades), Num(r.AdaptiveOptionPoints), Num(r.AdaptiveNetRupees),
                Num(r.AdaptiveNetPerLot), Num(r.NonAdaptiveTrades), Num(r.NonAdaptiveOptionPoints), Num(r.NonAdaptiveNetRupees), Num(r.NonAdaptiveNetPerLot),
                Num(r.UntaggedTrades),
            }.Select(Escape))).Append('\n');
        return sb.ToString();
    }

    /// <summary>A file as it is now ('signals' / 'trades'; only the header before anything is stored), or null.</summary>
    public string? ReadAll(string kind)
    {
        var path = PathOf(kind);
        if (path is null) return null;
        return File.Exists(path) ? File.ReadAllText(path) : string.Join(',', kind.EndsWith("signals") ? SignalColumns : TradeColumns) + "\n";
    }

    private void Upsert(string path, string[] columns, List<Dictionary<string, string>> rows, string timeColumn)
    {
        var byKey = new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);
        foreach (var row in Read(path)) if (row.TryGetValue("key", out var k) && k.Length > 0) byKey[k] = row;
        foreach (var row in rows) byKey[row["key"]] = row;
        var sb = new StringBuilder();
        sb.Append(string.Join(',', columns)).Append('\n');
        // Oldest first (the IST time holds the date), then the underlying.
        foreach (var row in byKey.Values
                     .OrderBy((r) => r.GetValueOrDefault(timeColumn, ""), StringComparer.Ordinal)
                     .ThenBy((r) => r.GetValueOrDefault("underlying", ""), StringComparer.Ordinal)
                     .ThenBy((r) => r["key"], StringComparer.Ordinal))
            sb.Append(Line(columns, row)).Append('\n');
        var temp = path + ".tmp";
        File.WriteAllText(temp, sb.ToString(), new UTF8Encoding(false));
        File.Move(temp, path, overwrite: true);
        _logger.LogDebug("Scanner log {Path}: {Rows} rows", path, byKey.Count);
    }

    /// <summary>Rows of a CSV this store wrote (RFC 4180 quoting), as column -> value.</summary>
    internal static IEnumerable<Dictionary<string, string>> Read(string path)
    {
        if (!File.Exists(path)) yield break;
        var records = Parse(File.ReadAllText(path));
        if (records.Count == 0) yield break;
        var header = records[0];
        foreach (var record in records.Skip(1))
        {
            var row = new Dictionary<string, string>(StringComparer.Ordinal);
            for (var i = 0; i < header.Count; i++) row[header[i]] = i < record.Count ? record[i] : "";
            yield return row;
        }
    }

    internal static List<List<string>> Parse(string text)
    {
        var records = new List<List<string>>();
        var record = new List<string>();
        var field = new StringBuilder();
        var quoted = false;
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (quoted)
            {
                if (c == '"' && i + 1 < text.Length && text[i + 1] == '"') { field.Append('"'); i++; }
                else if (c == '"') quoted = false;
                else field.Append(c);
            }
            else if (c == '"') quoted = true;
            else if (c == ',') { record.Add(field.ToString()); field.Clear(); }
            else if (c == '\n')
            {
                record.Add(field.ToString()); field.Clear();
                records.Add(record); record = new List<string>();
            }
            else if (c != '\r') field.Append(c);
        }
        if (field.Length > 0 || record.Count > 0) { record.Add(field.ToString()); records.Add(record); }
        return records;
    }

    private static string Line(string[] columns, Dictionary<string, string> row) =>
        string.Join(',', columns.Select((c) => Escape(row.GetValueOrDefault(c, ""))));

    private static string Escape(string value) =>
        value.IndexOfAny(new[] { ',', '"', '\n', '\r' }) >= 0 ? $"\"{value.Replace("\"", "\"\"")}\"" : value;

    /// <summary>Free text, capped and made safe to open in a spreadsheet: a cell starting with = + - @
    /// (a formula) gets a leading apostrophe.</summary>
    internal static string Text(string? value)
    {
        var v = (value ?? "").Replace('\r', ' ').Replace('\n', ' ').Trim();
        if (v.Length > MaxText) v = v[..MaxText];
        return v.Length > 0 && "=+-@\t".Contains(v[0]) ? "'" + v : v;
    }

    private static string Num(double? value) => value is { } v && double.IsFinite(v) ? v.ToString("0.####", CultureInfo.InvariantCulture) : "";
    private static string Num(int? value) => value?.ToString(CultureInfo.InvariantCulture) ?? "";
    private static string Bool(bool? value) => value is null ? "" : value.Value ? "true" : "false";
    private static string IstTime(long ms) => DateTimeOffset.FromUnixTimeMilliseconds(ms).ToOffset(Ist).ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
}

/// <summary>One day's scanner record from the browser (times are epoch milliseconds).</summary>
/// <summary>Totals of the stored signals and trades for one underlying: Scope "day" (one date) or "total"
/// (every stored day). Futures points = what the closed signals captured on the futures (exit - entry,
/// reversed for a SHORT); option points = the premium points of the punched option trades (an open trade
/// at its last posted value); NetPerLot = the P&amp;L after charges of each trade as if done with one lot,
/// summed. Adaptive* = the same for the trades an adaptive scanner would have taken, NonAdaptive* for the
/// ones it would have skipped (UntaggedTrades: trades saved with no adaptive call - in neither).</summary>
public sealed record ScannerSummaryRow(
    string Scope, string Underlying, string Date, int Signals, int ClosedSignals, int Wins, double? WinPct, double FuturesPoints, double TotalR,
    int Trades, int LiveTrades, int OpenTrades, double OptionPoints, double GrossRupees, double Charges, double NetRupees, double NetPerLot,
    int AdaptiveSignals, double AdaptiveFuturesPoints, int AdaptiveTrades, double AdaptiveOptionPoints, double AdaptiveNetRupees,
    double AdaptiveNetPerLot, int NonAdaptiveTrades, double NonAdaptiveOptionPoints, double NonAdaptiveNetRupees, double NonAdaptiveNetPerLot, int UntaggedTrades);

public sealed record ScannerLogDayRequest(string? Underlying, string? Date, string? Source, List<ScannerSignalRow>? Signals, List<ScannerTradeRow>? Trades);

public sealed record ScannerSignalRow(
    long Time, int? StrategyNo, string? StrategyId, string? Strategy, string? Side, double? Entry, double? Stop, double? Target,
    double? Confidence, bool? Estimated, string? DayType, string? DayTypePrice, string? VoteOi, string? VoteCvd,
    bool? AdaptiveTake, bool? AdaptivePriceOnly, string? AdaptiveReason, string? Status, double? R, long? ExitTime,
    double? ExitPrice, string? ExitReason);

/// <summary>An option trade punched for a signal (paper or live) - SignalTime / StrategyId / SignalSide name
/// the signal it came from. Stt / Brokerage / OtherCharges / NetRupees / NetPerLot: its costs and net P&amp;L
/// as the scanner works them out (rupees).</summary>
public sealed record ScannerTradeRow(
    string? Key, long EntryTime, long? ExitTime, bool? Live, string? Action, string? Option, double? Strike, int? Lots,
    int? LotSize, double? EntryPremium, double? ExitPremium, double? Points, double? Rupees, string? ExitReason,
    long? SignalTime, int? StrategyNo, string? StrategyId, string? SignalSide, string? DayType, bool? AdaptiveTake, string? AdaptiveReason,
    double? Stt = null, double? Brokerage = null, double? OtherCharges = null, double? NetRupees = null, double? NetPerLot = null);

using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// The Order Flow strategy scanner's record on the server, as plain CSV: every signal (its levels, the
/// day type and the adaptive call when it fired, its outcome) and every option trade punched for it
/// (paper or live, with the adaptive flag and P&amp;L). The browser keeps its own copy; this one lasts
/// and is the same for every device.
///
/// ONE FILE PER KIND, UNDERLYING AND DAY - signals_NIFTY_2026-10-05.csv, trades_NIFTY_2026-10-05.csv -
/// under Storage:ScannerLogPath (env Storage__ScannerLogPath; mount a volume in production, like the
/// other Storage paths). The scanner posts a day's rows as they change (outcomes resolve during the
/// day); each row has a key, a posted row replaces the stored row with the same key, rows not posted
/// again are kept, and the file is rewritten atomically (temp file + move) under a lock.
/// </summary>
public sealed class ScannerLogStore
{
    public const int MaxSignals = 3000;
    public const int MaxTrades = 1000;
    private const int MaxText = 400;
    private static readonly Regex UnderlyingPattern = new("^[A-Z]{2,20}$", RegexOptions.Compiled);
    private static readonly Regex FilePattern = new(@"^(signals|trades)_[A-Z]{2,20}_\d{4}-\d{2}-\d{2}\.csv$", RegexOptions.Compiled);
    private static readonly TimeSpan Ist = TimeSpan.FromMinutes(330);

    public static readonly string[] SignalColumns =
    {
        "key", "date", "underlying", "time_ist", "strategy_no", "strategy_id", "strategy", "side", "entry", "stop", "target",
        "confidence", "estimated", "day_type", "day_type_price", "vote_oi", "vote_cvd", "adaptive_take", "adaptive_price_only",
        "adaptive_reason", "status", "r", "exit_time_ist", "exit_price", "exit_reason", "source", "user", "updated_utc",
    };

    public static readonly string[] TradeColumns =
    {
        "key", "date", "underlying", "entry_time_ist", "exit_time_ist", "live", "action", "option", "strike", "lots", "lot_size",
        "entry_premium", "exit_premium", "points", "rupees", "exit_reason", "strategy_no", "strategy_id", "signal_side",
        "day_type", "adaptive_take", "adaptive_reason", "source", "user", "updated_utc",
    };

    private readonly string _directory;
    private readonly SemaphoreSlim _lock = new(1, 1);
    private readonly ILogger<ScannerLogStore> _logger;

    public ScannerLogStore(IHostEnvironment environment, IConfiguration configuration, ILogger<ScannerLogStore> logger)
    {
        var configured = configuration["Storage:ScannerLogPath"];
        var relativeOrAbsolute = string.IsNullOrWhiteSpace(configured) ? "scanner-log" : configured;
        _directory = Path.IsPathRooted(relativeOrAbsolute) ? relativeOrAbsolute : Path.Combine(environment.ContentRootPath, relativeOrAbsolute);
        _logger = logger;
        Directory.CreateDirectory(_directory);
    }

    /// <summary>Validates and upserts one day's signals and trades. Returns the row counts written, or an
    /// error for a request that is not a valid day.</summary>
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
            ["key"] = $"{Text(s.StrategyId)}|{Text(s.Side)}|{s.Time}",
            ["date"] = day, ["underlying"] = underlying, ["time_ist"] = IstTime(s.Time),
            ["strategy_no"] = Num(s.StrategyNo), ["strategy_id"] = Text(s.StrategyId), ["strategy"] = Text(s.Strategy), ["side"] = Text(s.Side),
            ["entry"] = Num(s.Entry), ["stop"] = Num(s.Stop), ["target"] = Num(s.Target), ["confidence"] = Num(s.Confidence),
            ["estimated"] = Bool(s.Estimated), ["day_type"] = Text(s.DayType), ["day_type_price"] = Text(s.DayTypePrice),
            ["vote_oi"] = Text(s.VoteOi), ["vote_cvd"] = Text(s.VoteCvd), ["adaptive_take"] = Bool(s.AdaptiveTake),
            ["adaptive_price_only"] = Bool(s.AdaptivePriceOnly), ["adaptive_reason"] = Text(s.AdaptiveReason),
            ["status"] = Text(s.Status), ["r"] = Num(s.R), ["exit_time_ist"] = s.ExitTime is > 0 ? IstTime(s.ExitTime.Value) : "",
            ["exit_price"] = Num(s.ExitPrice), ["exit_reason"] = Text(s.ExitReason), ["source"] = source, ["user"] = who, ["updated_utc"] = now,
        }).ToList();
        var tradeRows = trades.Where((t) => !string.IsNullOrWhiteSpace(t.Key) && t.EntryTime > 0).Select((t) => new Dictionary<string, string>
        {
            ["key"] = Text(t.Key), ["date"] = day, ["underlying"] = underlying, ["entry_time_ist"] = IstTime(t.EntryTime),
            ["exit_time_ist"] = t.ExitTime is > 0 ? IstTime(t.ExitTime.Value) : "", ["live"] = Bool(t.Live), ["action"] = Text(t.Action),
            ["option"] = Text(t.Option), ["strike"] = Num(t.Strike), ["lots"] = Num(t.Lots), ["lot_size"] = Num(t.LotSize),
            ["entry_premium"] = Num(t.EntryPremium), ["exit_premium"] = Num(t.ExitPremium), ["points"] = Num(t.Points), ["rupees"] = Num(t.Rupees),
            ["exit_reason"] = Text(t.ExitReason), ["strategy_no"] = Num(t.StrategyNo), ["strategy_id"] = Text(t.StrategyId),
            ["signal_side"] = Text(t.SignalSide), ["day_type"] = Text(t.DayType), ["adaptive_take"] = Bool(t.AdaptiveTake),
            ["adaptive_reason"] = Text(t.AdaptiveReason), ["source"] = source, ["user"] = who, ["updated_utc"] = now,
        }).ToList();

        await _lock.WaitAsync(cancellationToken);
        try
        {
            if (signalRows.Count > 0) Upsert(Path.Combine(_directory, $"signals_{underlying}_{day}.csv"), SignalColumns, signalRows, "time_ist");
            if (tradeRows.Count > 0) Upsert(Path.Combine(_directory, $"trades_{underlying}_{day}.csv"), TradeColumns, tradeRows, "entry_time_ist");
        }
        finally
        {
            _lock.Release();
        }
        return (signalRows.Count, tradeRows.Count, null);
    }

    /// <summary>The stored files, newest day first.</summary>
    public IReadOnlyList<ScannerLogFile> ListFiles() =>
        new DirectoryInfo(_directory).EnumerateFiles("*.csv")
            .Where((f) => FilePattern.IsMatch(f.Name))
            .Select((f) => new ScannerLogFile(f.Name, f.Length, f.LastWriteTimeUtc))
            .OrderByDescending((f) => f.Name[(f.Name.LastIndexOf('_') + 1)..])
            .ThenBy((f) => f.Name)
            .ToList();

    /// <summary>The full path of a stored file by its exact name, or null - only names this store writes
    /// are accepted, so nothing outside the folder can be reached.</summary>
    public string? PathOf(string name)
    {
        if (string.IsNullOrEmpty(name) || !FilePattern.IsMatch(name)) return null;
        var path = Path.Combine(_directory, name);
        return File.Exists(path) ? path : null;
    }

    /// <summary>Every stored day of one kind ('signals' / 'trades') as one CSV (one header), oldest first.</summary>
    public string? Combined(string kind)
    {
        if (kind is not ("signals" or "trades")) return null;
        var columns = kind == "signals" ? SignalColumns : TradeColumns;
        var sb = new StringBuilder();
        sb.Append(string.Join(',', columns)).Append('\n');
        foreach (var file in ListFiles().Where((f) => f.Name.StartsWith(kind + "_", StringComparison.Ordinal)).OrderBy((f) => f.Name[(f.Name.LastIndexOf('_') + 1)..]).ThenBy((f) => f.Name))
        {
            foreach (var row in Read(Path.Combine(_directory, file.Name)))
                sb.Append(Line(columns, row)).Append('\n');
        }
        return sb.ToString();
    }

    private void Upsert(string path, string[] columns, List<Dictionary<string, string>> rows, string sortColumn)
    {
        var byKey = new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);
        foreach (var row in Read(path)) if (row.TryGetValue("key", out var k) && k.Length > 0) byKey[k] = row;
        foreach (var row in rows) byKey[row["key"]] = row;
        var sb = new StringBuilder();
        sb.Append(string.Join(',', columns)).Append('\n');
        foreach (var row in byKey.Values.OrderBy((r) => r.GetValueOrDefault(sortColumn, ""), StringComparer.Ordinal).ThenBy((r) => r["key"], StringComparer.Ordinal))
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

public sealed record ScannerLogFile(string Name, long Bytes, DateTime UpdatedUtc);

/// <summary>One day's scanner record from the browser (times are epoch milliseconds).</summary>
public sealed record ScannerLogDayRequest(string? Underlying, string? Date, string? Source, List<ScannerSignalRow>? Signals, List<ScannerTradeRow>? Trades);

public sealed record ScannerSignalRow(
    long Time, int? StrategyNo, string? StrategyId, string? Strategy, string? Side, double? Entry, double? Stop, double? Target,
    double? Confidence, bool? Estimated, string? DayType, string? DayTypePrice, string? VoteOi, string? VoteCvd,
    bool? AdaptiveTake, bool? AdaptivePriceOnly, string? AdaptiveReason, string? Status, double? R, long? ExitTime,
    double? ExitPrice, string? ExitReason);

public sealed record ScannerTradeRow(
    string? Key, long EntryTime, long? ExitTime, bool? Live, string? Action, string? Option, double? Strike, int? Lots,
    int? LotSize, double? EntryPremium, double? ExitPremium, double? Points, double? Rupees, string? ExitReason,
    int? StrategyNo, string? StrategyId, string? SignalSide, string? DayType, bool? AdaptiveTake, string? AdaptiveReason);

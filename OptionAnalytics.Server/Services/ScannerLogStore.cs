using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// The Order Flow strategy scanner's record on the server as ONE CSV file - scanner-log.csv under
/// Storage:ScannerLogPath (env Storage__ScannerLogPath; /app/data/scanner-log on the volume) - every
/// underlying and every day in it: one row per signal (its levels, the day type and the adaptive call
/// when it fired, its outcome) with the option trades punched for it (paper or live) on the same row -
/// how many, live or not, total points and rupees, and each trade spelled out. The browser keeps its
/// own copy; this one lasts and is the same for every device.
///
/// The scanner posts a day's signals as they change (outcomes resolve during the day); each row has a
/// key (underlying, date, strategy, side, signal time), a posted row replaces the stored row with that
/// key, every other row is kept, and the file is rewritten atomically (temp file + move) under a lock.
/// </summary>
public sealed class ScannerLogStore
{
    public const string FileName = "scanner-log.csv";
    public const int MaxSignals = 3000;
    public const int MaxTradesPerSignal = 20;
    private const int MaxText = 400;
    private static readonly Regex UnderlyingPattern = new("^[A-Z]{2,20}$", RegexOptions.Compiled);
    private static readonly TimeSpan Ist = TimeSpan.FromMinutes(330);

    public static readonly string[] Columns =
    {
        "key", "date", "underlying", "time_ist", "strategy_no", "strategy_id", "strategy", "side", "entry", "stop", "target",
        "confidence", "estimated", "day_type", "day_type_price", "vote_oi", "vote_cvd", "adaptive_take", "adaptive_price_only",
        "adaptive_reason", "status", "r", "exit_time_ist", "exit_price", "exit_reason",
        "trades", "trade_live", "trade_points", "trade_rupees", "trade_detail", "source", "user", "updated_utc",
    };

    private readonly string _path;
    private readonly SemaphoreSlim _lock = new(1, 1);
    private readonly ILogger<ScannerLogStore> _logger;

    public ScannerLogStore(IHostEnvironment environment, IConfiguration configuration, ILogger<ScannerLogStore> logger)
    {
        var configured = configuration["Storage:ScannerLogPath"];
        var relativeOrAbsolute = string.IsNullOrWhiteSpace(configured) ? "scanner-log" : configured;
        var directory = Path.IsPathRooted(relativeOrAbsolute) ? relativeOrAbsolute : Path.Combine(environment.ContentRootPath, relativeOrAbsolute);
        Directory.CreateDirectory(directory);
        _path = Path.Combine(directory, FileName);
        _logger = logger;
    }

    /// <summary>The CSV file's full path.</summary>
    public string FilePath => _path;

    /// <summary>Validates and upserts one day's signals (with their trades). Returns the rows written,
    /// or an error for a request that is not a valid day.</summary>
    public async Task<(int Rows, string? Error)> UpsertDayAsync(ScannerLogDayRequest request, string? user, CancellationToken cancellationToken)
    {
        var underlying = request.Underlying?.Trim().ToUpperInvariant() ?? "";
        if (!UnderlyingPattern.IsMatch(underlying)) return (0, "Bad underlying.");
        if (!DateOnly.TryParseExact(request.Date ?? "", "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)
            || date.Year < 2020 || date > DateOnly.FromDateTime(DateTime.UtcNow).AddDays(1))
            return (0, "Bad date.");
        var signals = request.Signals ?? new List<ScannerSignalRow>();
        if (signals.Count > MaxSignals || signals.Any((s) => (s.Trades?.Count ?? 0) > MaxTradesPerSignal)) return (0, "Too many rows.");
        var source = Text(request.Source);
        var who = Text(user);
        var now = DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);
        var day = date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

        var rows = signals.Where((s) => s.Time > 0 && !string.IsNullOrWhiteSpace(s.StrategyId)).Select((s) =>
        {
            var trades = s.Trades ?? new List<ScannerTradeRow>();
            var points = trades.Where((t) => t.Points is { } p && double.IsFinite(p)).Select((t) => t.Points!.Value).ToList();
            var rupees = trades.Where((t) => t.Rupees is { } r && double.IsFinite(r)).Select((t) => t.Rupees!.Value).ToList();
            return new Dictionary<string, string>
            {
                ["key"] = $"{underlying}|{day}|{Text(s.StrategyId)}|{Text(s.Side)}|{s.Time}",
                ["date"] = day, ["underlying"] = underlying, ["time_ist"] = IstTime(s.Time),
                ["strategy_no"] = Num(s.StrategyNo), ["strategy_id"] = Text(s.StrategyId), ["strategy"] = Text(s.Strategy), ["side"] = Text(s.Side),
                ["entry"] = Num(s.Entry), ["stop"] = Num(s.Stop), ["target"] = Num(s.Target), ["confidence"] = Num(s.Confidence),
                ["estimated"] = Bool(s.Estimated), ["day_type"] = Text(s.DayType), ["day_type_price"] = Text(s.DayTypePrice),
                ["vote_oi"] = Text(s.VoteOi), ["vote_cvd"] = Text(s.VoteCvd), ["adaptive_take"] = Bool(s.AdaptiveTake),
                ["adaptive_price_only"] = Bool(s.AdaptivePriceOnly), ["adaptive_reason"] = Text(s.AdaptiveReason),
                ["status"] = Text(s.Status), ["r"] = Num(s.R), ["exit_time_ist"] = s.ExitTime is > 0 ? IstTime(s.ExitTime.Value) : "",
                ["exit_price"] = Num(s.ExitPrice), ["exit_reason"] = Text(s.ExitReason),
                ["trades"] = trades.Count > 0 ? trades.Count.ToString(CultureInfo.InvariantCulture) : "",
                ["trade_live"] = trades.Count > 0 ? Bool(trades.Any((t) => t.Live == true)) : "",
                ["trade_points"] = points.Count > 0 ? Num(points.Sum()) : "",
                ["trade_rupees"] = rupees.Count > 0 ? Num(rupees.Sum()) : "",
                ["trade_detail"] = Text(string.Join(" | ", trades.Select(TradeText))),
                ["source"] = source, ["user"] = who, ["updated_utc"] = now,
            };
        }).ToList();

        if (rows.Count == 0) return (0, null);
        await _lock.WaitAsync(cancellationToken);
        try
        {
            Upsert(rows);
        }
        finally
        {
            _lock.Release();
        }
        return (rows.Count, null);
    }

    /// <summary>The file as it is now (only the header before anything is stored).</summary>
    public string ReadAll() => File.Exists(_path) ? File.ReadAllText(_path) : string.Join(',', Columns) + "\n";

    // "SELL PE 22650 x1 @100 -> 80 = +20 pts Rs 1500 (Target hit, 10:35-10:55)" - one punched trade.
    private static string TradeText(ScannerTradeRow t)
    {
        var sb = new StringBuilder();
        if (t.Live == true) sb.Append("LIVE ");
        sb.Append(t.Action).Append(' ').Append(t.Option).Append(' ').Append(Num(t.Strike)).Append(" x").Append(Num(t.Lots));
        sb.Append(" @").Append(Num(t.EntryPremium)).Append(" -> ").Append(t.ExitPremium is null ? "open" : Num(t.ExitPremium));
        if (t.Points is { } p && double.IsFinite(p)) sb.Append(" = ").Append(p >= 0 ? "+" : "").Append(Num(p)).Append(" pts");
        if (t.Rupees is { } r && double.IsFinite(r)) sb.Append(" Rs ").Append(Num(Math.Round(r)));
        var when = t.EntryTime > 0 ? IstTime(t.EntryTime)[11..16] + (t.ExitTime is > 0 ? "-" + IstTime(t.ExitTime.Value)[11..16] : "") : "";
        var why = string.Join(", ", new[] { t.ExitReason, when }.Where((x) => !string.IsNullOrWhiteSpace(x)));
        if (why.Length > 0) sb.Append(" (").Append(why).Append(')');
        return sb.ToString();
    }

    private void Upsert(List<Dictionary<string, string>> rows)
    {
        var byKey = new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);
        foreach (var row in Read(_path)) if (row.TryGetValue("key", out var k) && k.Length > 0) byKey[k] = row;
        foreach (var row in rows) byKey[row["key"]] = row;
        var sb = new StringBuilder();
        sb.Append(string.Join(',', Columns)).Append('\n');
        // Oldest first: by date, then the time, then the underlying.
        foreach (var row in byKey.Values
                     .OrderBy((r) => r.GetValueOrDefault("time_ist", ""), StringComparer.Ordinal)
                     .ThenBy((r) => r.GetValueOrDefault("underlying", ""), StringComparer.Ordinal)
                     .ThenBy((r) => r["key"], StringComparer.Ordinal))
            sb.Append(Line(Columns, row)).Append('\n');
        var temp = _path + ".tmp";
        File.WriteAllText(temp, sb.ToString(), new UTF8Encoding(false));
        File.Move(temp, _path, overwrite: true);
        _logger.LogDebug("Scanner log {Path}: {Rows} rows", _path, byKey.Count);
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
public sealed record ScannerLogDayRequest(string? Underlying, string? Date, string? Source, List<ScannerSignalRow>? Signals);

public sealed record ScannerSignalRow(
    long Time, int? StrategyNo, string? StrategyId, string? Strategy, string? Side, double? Entry, double? Stop, double? Target,
    double? Confidence, bool? Estimated, string? DayType, string? DayTypePrice, string? VoteOi, string? VoteCvd,
    bool? AdaptiveTake, bool? AdaptivePriceOnly, string? AdaptiveReason, string? Status, double? R, long? ExitTime,
    double? ExitPrice, string? ExitReason, List<ScannerTradeRow>? Trades = null);

/// <summary>An option trade punched for a signal (paper or live).</summary>
public sealed record ScannerTradeRow(
    long EntryTime, long? ExitTime, bool? Live, string? Action, string? Option, double? Strike, int? Lots,
    double? EntryPremium, double? ExitPremium, double? Points, double? Rupees, string? ExitReason);

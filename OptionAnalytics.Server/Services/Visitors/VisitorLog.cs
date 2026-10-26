using System.Globalization;
using System.Text;
using System.Text.Json;

namespace OptionAnalytics.Server.Services.Visitors;

/// <summary>One thing someone did on the site: opened a page, signed in, failed to sign in, signed out. Account is the
/// signed-in email (null for a visitor with no account - Visitor then tells their visits apart: a random id their browser
/// keeps); for a failed sign-in, the email typed. Where they are is the city / region / country worked out from their
/// connection (GeoLocator) - their IP address itself is never kept.</summary>
public sealed record VisitEntry(
    DateTimeOffset Time, string Kind, string? Account, string? Role, string? Page, string? Visitor,
    string? City, string? Region, string? Country, string? Device);

/// <summary>Who opened which page, when and from where - every account and visitors with no account (the admin
/// Visitors page). One CSV file per IST day under Storage:VisitorLogPath ({yyyy-MM-dd}.csv, a header row then a row per
/// entry - Columns), kept KeepDays days; a cell starting with = + - @ gets a leading apostrophe so a spreadsheet never
/// runs it (a failed sign-in's typed email is anyone's text). The same visitor on the same page within DedupeWindow is
/// one entry (a reload, React re-renders), and a day holds at most MaxEntriesPerDay so a script hammering the visit
/// beacon cannot fill the disk. Days kept by the first version as JSON lines ({yyyy-MM-dd}.jsonl) are moved into the
/// day's CSV at start.</summary>
public sealed class VisitorLog
{
    public const int KeepDays = 90;
    public const int MaxEntriesPerDay = 20_000;
    public const int MaxRead = 5_000;
    internal static readonly TimeSpan DedupeWindow = TimeSpan.FromSeconds(60);
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    /// <summary>The CSV's columns: the time in IST and UTC, then the entry.</summary>
    public static readonly string[] Columns = { "time_ist", "time_utc", "event", "account", "role", "page", "visitor", "city", "region", "country", "device" };
    public static string Header => string.Join(',', Columns);

    private readonly string _root;
    private readonly ILogger<VisitorLog> _logger;
    private readonly Func<DateTimeOffset> _clock;
    private readonly object _lock = new();
    private readonly Dictionary<string, DateTimeOffset> _recent = new();
    private DateOnly _countDay;
    private int _countToday;
    private DateOnly _prunedOn;

    public VisitorLog(IHostEnvironment environment, IConfiguration configuration, ILogger<VisitorLog> logger)
        : this(ResolveRoot(environment, configuration), logger)
    {
    }

    internal VisitorLog(string root, ILogger<VisitorLog> logger, Func<DateTimeOffset>? clock = null)
    {
        _root = root;
        _logger = logger;
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
        Directory.CreateDirectory(_root);
        MoveJsonLinesDays();
    }

    private static string ResolveRoot(IHostEnvironment environment, IConfiguration configuration)
    {
        var configured = configuration["Storage:VisitorLogPath"];
        var path = string.IsNullOrWhiteSpace(configured) ? "visitor-log" : configured;
        return Path.IsPathRooted(path) ? path : Path.Combine(environment.ContentRootPath, path);
    }

    /// <summary>Adds an entry (its Time is set here); false when it repeats the same visitor's same page within
    /// DedupeWindow, or today is full.</summary>
    public bool Record(VisitEntry entry)
    {
        var now = _clock();
        var day = IstDay(now);
        lock (_lock)
        {
            var who = entry.Account ?? entry.Visitor ?? "?";
            var key = $"{entry.Kind}|{who}|{entry.Page}";
            if (entry.Kind == "page" && _recent.TryGetValue(key, out var last) && now - last < DedupeWindow) return false;
            if (_recent.Count > 5_000) foreach (var stale in _recent.Where(kv => now - kv.Value >= DedupeWindow).Select(kv => kv.Key).ToList()) _recent.Remove(stale);
            if (_countDay != day) { _countDay = day; _countToday = CountRows(FileOf(day)); }
            if (_countToday >= MaxEntriesPerDay) return false;
            _recent[key] = now;
            try
            {
                AppendRows(FileOf(day), new[] { entry with { Time = now } });
                _countToday++;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Could not write the visitor log.");
                return false;
            }
            if (_prunedOn != day) { _prunedOn = day; Prune(day); }
            return true;
        }
    }

    /// <summary>The entries of the last `days` IST days (today included), newest first, at most MaxRead.</summary>
    public IReadOnlyList<VisitEntry> Read(int days)
    {
        days = Math.Clamp(days, 1, KeepDays);
        var today = IstDay(_clock());
        var all = new List<VisitEntry>();
        lock (_lock)
        {
            for (var d = 0; d < days && all.Count < MaxRead; d++)
            {
                var rows = ReadDay(today.AddDays(-d));
                for (var i = rows.Count - 1; i >= 0 && all.Count < MaxRead; i--) all.Add(rows[i]);
            }
        }
        return all;
    }

    /// <summary>Deletes the whole history (every day's file) - the Visitors page's Clear history, an admin's. Returns how
    /// many entries were removed.</summary>
    public int Clear()
    {
        lock (_lock)
        {
            var removed = 0;
            foreach (var file in Directory.EnumerateFiles(_root).Where(f => f.EndsWith(".csv", StringComparison.OrdinalIgnoreCase) || f.EndsWith(".jsonl", StringComparison.OrdinalIgnoreCase)).ToList())
            {
                try
                {
                    removed += file.EndsWith(".csv", StringComparison.OrdinalIgnoreCase) ? CountRows(file) : File.ReadLines(file).Count();
                    File.Delete(file);
                }
                catch (IOException ex) { _logger.LogWarning(ex, "Could not delete {File} from the visitor log.", file); }
            }
            _recent.Clear();
            _countDay = default;
            _countToday = 0;
            return removed;
        }
    }

    /// <summary>The last `days` IST days as one CSV (the header once, oldest entry first) - the page's download.</summary>
    public string Csv(int days)
    {
        days = Math.Clamp(days, 1, KeepDays);
        var today = IstDay(_clock());
        var csv = new StringBuilder(Header).Append('\n');
        lock (_lock)
        {
            for (var d = days - 1; d >= 0; d--)
                foreach (var e in ReadDay(today.AddDays(-d))) csv.Append(Row(e)).Append('\n');
        }
        return csv.ToString();
    }

    private static DateOnly IstDay(DateTimeOffset t) => DateOnly.FromDateTime(t.ToOffset(IstClock.Offset).DateTime);

    private string FileOf(DateOnly day) => Path.Combine(_root, $"{day:yyyy-MM-dd}.csv");

    private List<VisitEntry> ReadDay(DateOnly day)
    {
        var file = FileOf(day);
        var rows = new List<VisitEntry>();
        if (!File.Exists(file)) return rows;
        foreach (var line in File.ReadLines(file).Skip(1))
            if (Parse(line) is { } e) rows.Add(e);
        return rows;
    }

    private static void AppendRows(string file, IEnumerable<VisitEntry> entries)
    {
        var text = new StringBuilder();
        if (!File.Exists(file) || new FileInfo(file).Length == 0) text.Append(Header).Append('\n');
        foreach (var e in entries) text.Append(Row(e)).Append('\n');
        File.AppendAllText(file, text.ToString());
    }

    private static int CountRows(string file)
    {
        if (!File.Exists(file)) return 0;
        try { return Math.Max(0, File.ReadLines(file).Count() - 1); } catch (IOException) { return 0; }
    }

    /// <summary>One entry as a CSV row (Columns).</summary>
    internal static string Row(VisitEntry e) => string.Join(',', new[]
    {
        e.Time.ToOffset(IstClock.Offset).ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture),
        e.Time.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture),
        e.Kind, e.Account, e.Role, e.Page, e.Visitor, e.City, e.Region, e.Country, e.Device,
    }.Select(Cell));

    /// <summary>A CSV row back to an entry, or null when it is not one.</summary>
    internal static VisitEntry? Parse(string line)
    {
        var f = SplitRow(line);
        if (f.Count < Columns.Length) return null;
        if (!DateTimeOffset.TryParse(f[1], CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var time)) return null;
        string? V(int i) => f[i].Length == 0 ? null : Unguard(f[i]);
        return string.IsNullOrEmpty(f[2]) ? null : new VisitEntry(time, f[2], V(3), V(4), V(5), V(6), V(7), V(8), V(9), V(10));
    }

    // A value as a cell: one line, a formula start neutralised, quoted when it holds a comma or a quote.
    private static string Cell(string? value)
    {
        var v = (value ?? "").Replace('\r', ' ').Replace('\n', ' ');
        if (v.Length > 0 && "=+-@\t".Contains(v[0])) v = "'" + v;
        return v.IndexOfAny(new[] { ',', '"' }) >= 0 ? $"\"{v.Replace("\"", "\"\"")}\"" : v;
    }

    private static string Unguard(string v) => v.Length > 1 && v[0] == '\'' && "=+-@\t".Contains(v[1]) ? v[1..] : v;

    private static List<string> SplitRow(string line)
    {
        var fields = new List<string>();
        var field = new StringBuilder();
        var quoted = false;
        for (var i = 0; i < line.Length; i++)
        {
            var c = line[i];
            if (quoted)
            {
                if (c == '"' && i + 1 < line.Length && line[i + 1] == '"') { field.Append('"'); i++; }
                else if (c == '"') quoted = false;
                else field.Append(c);
            }
            else if (c == '"') quoted = true;
            else if (c == ',') { fields.Add(field.ToString()); field.Clear(); }
            else if (c != '\r') field.Append(c);
        }
        fields.Add(field.ToString());
        return fields;
    }

    // The first version kept each day as JSON lines: move them into that day's CSV (in time order) and drop them.
    private void MoveJsonLinesDays()
    {
        try
        {
            foreach (var jsonl in Directory.EnumerateFiles(_root, "*.jsonl").ToList())
            {
                if (!DateOnly.TryParseExact(Path.GetFileNameWithoutExtension(jsonl), "yyyy-MM-dd", out var day)) continue;
                var moved = new List<VisitEntry>();
                foreach (var line in File.ReadLines(jsonl))
                {
                    try { if (JsonSerializer.Deserialize<VisitEntry>(line, JsonOptions) is { } e) moved.Add(e); }
                    catch (JsonException) { /* a torn line - skipped */ }
                }
                var all = ReadDay(day).Concat(moved).OrderBy(e => e.Time).ToList();
                var csv = FileOf(day);
                var temp = csv + ".tmp";
                File.Delete(temp);
                AppendRows(temp, all);
                File.Move(temp, csv, overwrite: true);
                File.Delete(jsonl);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not move the visitor log's JSON-lines days to CSV.");
        }
    }

    private void Prune(DateOnly today)
    {
        var oldest = today.AddDays(-(KeepDays - 1));
        try
        {
            foreach (var file in Directory.EnumerateFiles(_root, "*.csv"))
                if (DateOnly.TryParseExact(Path.GetFileNameWithoutExtension(file), "yyyy-MM-dd", out var d) && d < oldest) File.Delete(file);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not prune the visitor log.");
        }
    }

    /// <summary>A page path from the browser, or null: starts with '/', at most 100 characters of a path's own
    /// characters - no query string, nothing else.</summary>
    public static string? CleanPage(string? page)
    {
        if (string.IsNullOrWhiteSpace(page)) return null;
        var p = page.Trim();
        var cut = p.IndexOfAny(new[] { '?', '#' });
        if (cut >= 0) p = p[..cut];
        if (p.Length == 0 || p[0] != '/' || p.Length > 100) return null;
        return p.All(c => char.IsAsciiLetterOrDigit(c) || c is '/' or '-' or '_' or '.') ? p : null;
    }

    /// <summary>The browser's random visitor id, or null: 6 - 40 letters, digits or '-'.</summary>
    public static string? CleanVisitor(string? visitor)
    {
        if (string.IsNullOrWhiteSpace(visitor)) return null;
        var v = visitor.Trim();
        return v.Length is >= 6 and <= 40 && v.All(c => char.IsAsciiLetterOrDigit(c) || c == '-') ? v : null;
    }

    /// <summary>An email typed at a failed sign-in, cut to 100 characters.</summary>
    public static string? CleanTyped(string? typed)
    {
        if (string.IsNullOrWhiteSpace(typed)) return null;
        var t = new string(typed.Trim().Where(c => !char.IsControl(c)).ToArray());
        return t.Length > 100 ? t[..100] : t;
    }
}

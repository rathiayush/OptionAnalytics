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
/// Visitors page). One JSON-lines file per IST day under Storage:VisitorLogPath, kept KeepDays days. The same visitor
/// on the same page within DedupeWindow is one entry (a reload, React re-renders), and a day holds at most
/// MaxEntriesPerDay so a script hammering the visit beacon cannot fill the disk.</summary>
public sealed class VisitorLog
{
    public const int KeepDays = 90;
    public const int MaxEntriesPerDay = 20_000;
    public const int MaxRead = 5_000;
    internal static readonly TimeSpan DedupeWindow = TimeSpan.FromSeconds(60);
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

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
        var day = DateOnly.FromDateTime(now.ToOffset(IstClock.Offset).DateTime);
        lock (_lock)
        {
            var who = entry.Account ?? entry.Visitor ?? "?";
            var key = $"{entry.Kind}|{who}|{entry.Page}";
            if (entry.Kind == "page" && _recent.TryGetValue(key, out var last) && now - last < DedupeWindow) return false;
            if (_recent.Count > 5_000) foreach (var stale in _recent.Where(kv => now - kv.Value >= DedupeWindow).Select(kv => kv.Key).ToList()) _recent.Remove(stale);
            if (_countDay != day) { _countDay = day; _countToday = CountLines(FileOf(day)); }
            if (_countToday >= MaxEntriesPerDay) return false;
            _recent[key] = now;
            try
            {
                File.AppendAllText(FileOf(day), JsonSerializer.Serialize(entry with { Time = now }, JsonOptions) + "\n");
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
        var today = DateOnly.FromDateTime(_clock().ToOffset(IstClock.Offset).DateTime);
        var all = new List<VisitEntry>();
        lock (_lock)
        {
            for (var d = 0; d < days && all.Count < MaxRead; d++)
            {
                var file = FileOf(today.AddDays(-d));
                if (!File.Exists(file)) continue;
                var lines = File.ReadAllLines(file);
                for (var i = lines.Length - 1; i >= 0 && all.Count < MaxRead; i--)
                {
                    try { if (JsonSerializer.Deserialize<VisitEntry>(lines[i], JsonOptions) is { } e) all.Add(e); }
                    catch (JsonException) { /* a torn line - skipped */ }
                }
            }
        }
        return all;
    }

    private string FileOf(DateOnly day) => Path.Combine(_root, $"{day:yyyy-MM-dd}.jsonl");

    private static int CountLines(string file)
    {
        if (!File.Exists(file)) return 0;
        try { return File.ReadLines(file).Count(); } catch (IOException) { return 0; }
    }

    private void Prune(DateOnly today)
    {
        var oldest = today.AddDays(-(KeepDays - 1));
        try
        {
            foreach (var file in Directory.EnumerateFiles(_root, "*.jsonl"))
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

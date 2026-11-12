using System.Globalization;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using OptionAnalytics.Server.Services;
using OptionAnalytics.Server.Services.SignalStrategies;

namespace OptionAnalytics.Server.Telegram;

/// <summary>
/// EVERY Telegram message the app sends, kept exactly as it went (asked for - "a page which will read the messages and show
/// how the price reacts after those signals ... the exact same messages that go from the code"): TelegramAlertService -
/// the one way out to Telegram, the server's own alerts and the pages' (POST /api/alerts/telegram) alike - records each one
/// here with when it went and how it went ("sent", "failed", or "off" - Telegram not configured: what WOULD have gone). A
/// bot cannot read back its own posts in a channel (the Bot API gives no channel history and never hands a bot its own
/// messages), so the copy is kept at the source - the same text. One CSV per IST day (`{yyyy-MM-dd}.csv` under
/// Storage:TelegramLogPath, /app/data/telegram-log on the volume; KeepDays kept): time in IST and UTC, the status and the
/// message (its HTML as sent; a line break kept as \n, a backslash as \\ - a CSV row is one line). Read back as plain
/// text (`PlainText`) by GET /api/telegram-log (the Telegram signals page). `TelegramMessageLogTests.cs`.
/// </summary>
public sealed class TelegramMessageLog
{
    public const int KeepDays = 400;
    public const int MaxDaysRead = 92;
    public const int MaxPerDay = 20_000;
    public static readonly string[] Columns = { "time_ist", "time_utc", "status", "text" };
    public static readonly string[] Statuses = { "sent", "failed", "off" };

    private readonly string _root;
    private readonly ILogger<TelegramMessageLog> _logger;
    private readonly Func<DateTimeOffset> _clock;
    private readonly object _lock = new();
    private DateOnly _countDay;
    private int _countToday;
    private DateOnly _prunedOn;

    public TelegramMessageLog(IHostEnvironment environment, IConfiguration configuration, ILogger<TelegramMessageLog> logger)
        : this(ResolveRoot(environment, configuration), logger)
    {
    }

    internal TelegramMessageLog(string root, ILogger<TelegramMessageLog> logger, Func<DateTimeOffset>? clock = null)
    {
        _root = root;
        _logger = logger;
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
        Directory.CreateDirectory(_root);
        CoveredFrom = ReadOrMarkCoveredFrom();
    }

    /// <summary>Since when this log has been recording (`covered-from.txt`, written once when it first runs - on the volume,
    /// so kept through restarts). A log that was already running before this mark existed counts from the day AFTER its
    /// first file - that first day may have begun before it.</summary>
    public DateTimeOffset CoveredFrom { get; }

    /// <summary>Whether the log holds the whole of an IST day: it was recording before that day's 09:00 (the session opens at
    /// 09:15), so every message the server sent that day is in it - the Telegram signals page then reads the day from here
    /// and asks Telegram nothing.</summary>
    public bool Covers(DateOnly day) => CoveredFrom <= IstClock.AtIstTime(day, 9 * 60);

    private DateTimeOffset ReadOrMarkCoveredFrom()
    {
        var marker = Path.Combine(_root, "covered-from.txt");
        try
        {
            if (File.Exists(marker) && DateTimeOffset.TryParse(File.ReadAllText(marker).Trim(), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var kept))
                return kept;
            var firstDay = Directory.EnumerateFiles(_root, "*.csv")
                .Select(f => DateOnly.TryParseExact(Path.GetFileNameWithoutExtension(f), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) ? d : (DateOnly?)null)
                .Where(d => d is not null).Min();
            var from = firstDay is { } d0 ? IstClock.AtIstTime(d0.AddDays(1), 0) : _clock();
            File.WriteAllText(marker, from.ToString("O", CultureInfo.InvariantCulture));
            return from;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not read or write the Telegram message log's start mark - no day counts as whole.");
            return DateTimeOffset.MaxValue;
        }
    }

    private static string ResolveRoot(IHostEnvironment environment, IConfiguration configuration)
    {
        var configured = configuration["Storage:TelegramLogPath"];
        var path = string.IsNullOrWhiteSpace(configured) ? "telegram-log" : configured;
        return Path.IsPathRooted(path) ? path : Path.Combine(environment.ContentRootPath, path);
    }

    public string Root => _root;

    /// <summary>Keeps one message as it went (`status`: sent / failed / off). Never throws - a log that cannot be written
    /// must not stop an alert.</summary>
    public void Record(string message, string status)
    {
        if (string.IsNullOrWhiteSpace(message)) return;
        var now = _clock();
        var day = IstDay(now);
        lock (_lock)
        {
            try
            {
                var file = FileOf(day);
                if (_countDay != day) { _countDay = day; _countToday = CountRows(file); }
                if (_countToday >= MaxPerDay) return;
                var text = new StringBuilder();
                if (!File.Exists(file) || new FileInfo(file).Length == 0) text.Append(string.Join(',', Columns)).Append('\n');
                text.Append(string.Join(',', new[]
                {
                    now.ToOffset(IstClock.Offset).ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture),
                    now.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture),
                    Statuses.Contains(status) ? status : "sent",
                    Escape(message),
                }.Select(CsvTable.Cell))).Append('\n');
                File.AppendAllText(file, text.ToString());
                _countToday++;
                if (_prunedOn != day) { _prunedOn = day; Prune(day); }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Could not write the Telegram message log.");
            }
        }
    }

    /// <summary>The messages of the IST days `from` .. `to` (at most MaxDaysRead days, ending at `to`), oldest first, as
    /// plain text.</summary>
    public IReadOnlyList<TelegramLogEntry> Read(DateOnly from, DateOnly to)
    {
        if (to < from) (from, to) = (to, from);
        if (to.DayNumber - from.DayNumber >= MaxDaysRead) from = to.AddDays(-(MaxDaysRead - 1));
        var all = new List<TelegramLogEntry>();
        lock (_lock)
        {
            for (var day = from; day <= to; day = day.AddDays(1))
            {
                var file = FileOf(day);
                if (!File.Exists(file)) continue;
                foreach (var line in File.ReadLines(file).Skip(1))
                {
                    var f = CsvTable.SplitRow(line);
                    if (f.Count < Columns.Length) continue;
                    if (!DateTimeOffset.TryParse(f[1], CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var time)) continue;
                    all.Add(new TelegramLogEntry(time, CsvTable.Uncell(f[2]), PlainText(Unescape(CsvTable.Uncell(f[3])))));
                }
            }
        }
        return all;
    }

    /// <summary>A message as sent (HTML for parse_mode HTML) as the text Telegram shows: the tags dropped (a &lt;br&gt; a line
    /// break), the entities decoded.</summary>
    public static string PlainText(string html)
    {
        var text = Regex.Replace(html ?? "", "<br\\s*/?>", "\n", RegexOptions.IgnoreCase);
        text = Regex.Replace(text, "<[^>]+>", "");
        return WebUtility.HtmlDecode(text).Trim();
    }

    // One line a row: a line break as \n, a backslash as \\.
    internal static string Escape(string text) => text.Replace("\\", "\\\\").Replace("\r", "").Replace("\n", "\\n");

    internal static string Unescape(string text)
    {
        var sb = new StringBuilder(text.Length);
        for (var i = 0; i < text.Length; i++)
        {
            if (text[i] == '\\' && i + 1 < text.Length)
            {
                var next = text[i + 1];
                if (next == 'n') { sb.Append('\n'); i++; continue; }
                if (next == '\\') { sb.Append('\\'); i++; continue; }
            }
            sb.Append(text[i]);
        }
        return sb.ToString();
    }

    private void Prune(DateOnly today)
    {
        var oldest = today.AddDays(-KeepDays);
        foreach (var file in Directory.EnumerateFiles(_root, "*.csv"))
        {
            var name = Path.GetFileNameWithoutExtension(file);
            if (DateOnly.TryParseExact(name, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day) && day < oldest)
            {
                try { File.Delete(file); }
                catch (IOException ex) { _logger.LogWarning(ex, "Could not delete {File} from the Telegram message log.", file); }
            }
        }
    }

    private static int CountRows(string file)
    {
        if (!File.Exists(file)) return 0;
        try { return Math.Max(0, File.ReadLines(file).Count() - 1); } catch (IOException) { return 0; }
    }

    private static DateOnly IstDay(DateTimeOffset t) => DateOnly.FromDateTime(t.ToOffset(IstClock.Offset).DateTime);

    private string FileOf(DateOnly day) => Path.Combine(_root, $"{day:yyyy-MM-dd}.csv");
}

/// <summary>One message as it went: when (UTC), how ("sent" / "failed" / "off") and its text as Telegram shows it.</summary>
public sealed record TelegramLogEntry(DateTimeOffset Time, string Status, string Text);

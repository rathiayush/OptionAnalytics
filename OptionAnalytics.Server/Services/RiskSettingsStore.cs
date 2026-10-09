using System.Globalization;
using System.Text;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// The account's daily loss limit and kill switch (see KillSwitchService), in one CSV file on the server
/// (Storage:RiskSettingsPath, default /app/data/risk-settings.csv on the volume), written again with the
/// defaults (₹20,000, on) when missing or unreadable. The limit - or switching it off - can be changed ONCE
/// per IST day (a limit moved in the heat of a losing day is the thing it guards against); the day the kill
/// switch tripped is kept too, so a restart does not let new orders through.
/// </summary>
public sealed class RiskSettingsStore
{
    public const decimal DefaultDailyLossLimit = 20_000m;
    public const decimal MinLimit = 1_000m;
    public const decimal MaxLimit = 10_00_000m;
    public static readonly string[] Columns = { "daily_loss_limit", "kill_switch_enabled", "changed_on", "tripped_on", "updated_utc" };

    private readonly string _path;
    private readonly object _lock = new();
    private readonly ILogger<RiskSettingsStore> _logger;

    public RiskSettingsStore(IHostEnvironment environment, IConfiguration configuration, ILogger<RiskSettingsStore> logger)
    {
        var configured = configuration["Storage:RiskSettingsPath"];
        var path = string.IsNullOrWhiteSpace(configured) ? "risk-settings.csv" : configured;
        _path = Path.IsPathRooted(path) ? path : Path.Combine(environment.ContentRootPath, path);
        _logger = logger;
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
    }

    public string FilePath => _path;

    public static RiskSettings Default() => new(DefaultDailyLossLimit, true, null, null, null);

    /// <summary>The settings - the file is (re)created with the defaults when it is not there.</summary>
    public RiskSettings Get()
    {
        lock (_lock)
        {
            var s = Read();
            if (s is null) { s = Default(); Write(s); }
            return s;
        }
    }

    /// <summary>Changes the limit / on-off - once per IST day (<paramref name="today"/>). Returns the saved
    /// settings, or why not.</summary>
    public (RiskSettings? Saved, string? Error) Change(decimal dailyLossLimit, bool enabled, DateOnly today)
    {
        if (dailyLossLimit < MinLimit || dailyLossLimit > MaxLimit)
            return (null, $"The daily loss limit must be ₹{MinLimit:N0} to ₹{MaxLimit:N0}.");
        lock (_lock)
        {
            var current = Read() ?? Default();
            if (current.DailyLossLimit == dailyLossLimit && current.Enabled == enabled) return (current, null);
            if (current.TrippedOn == today)
                return (null, "The kill switch tripped today - the limit can be changed again tomorrow.");
            if (current.ChangedOn == today)
                return (null, "The daily loss limit was already changed today - it can be changed again tomorrow.");
            var saved = current with { DailyLossLimit = dailyLossLimit, Enabled = enabled, ChangedOn = today, UpdatedUtc = DateTimeOffset.UtcNow };
            Write(saved);
            return (saved, null);
        }
    }

    /// <summary>Records that the kill switch tripped on <paramref name="day"/>.</summary>
    public RiskSettings MarkTripped(DateOnly day)
    {
        lock (_lock)
        {
            var saved = (Read() ?? Default()) with { TrippedOn = day, UpdatedUtc = DateTimeOffset.UtcNow };
            Write(saved);
            return saved;
        }
    }

    private RiskSettings? Read()
    {
        try
        {
            if (!File.Exists(_path)) return null;
            var lines = File.ReadAllLines(_path).Where(l => l.Trim().Length > 0).ToList();
            if (lines.Count < 2) return null;
            var head = lines[0].Split(',').Select(h => h.Trim()).ToList();
            var cells = lines[1].Split(',');
            string Cell(string name) => head.IndexOf(name) is var i and >= 0 && i < cells.Length ? cells[i].Trim() : "";
            if (!decimal.TryParse(Cell("daily_loss_limit"), NumberStyles.Number, CultureInfo.InvariantCulture, out var limit) || limit < MinLimit || limit > MaxLimit)
                return null;
            return new RiskSettings(limit,
                !bool.TryParse(Cell("kill_switch_enabled"), out var on) || on,
                DateOnly.TryParseExact(Cell("changed_on"), "yyyy-MM-dd", out var changed) ? changed : null,
                DateOnly.TryParseExact(Cell("tripped_on"), "yyyy-MM-dd", out var tripped) ? tripped : null,
                DateTimeOffset.TryParse(Cell("updated_utc"), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) ? at : null);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Risk settings: {Path} could not be read - writing it again with the defaults.", _path);
            return null;
        }
    }

    private void Write(RiskSettings s)
    {
        var csv = new StringBuilder();
        csv.AppendLine(string.Join(',', Columns));
        csv.AppendLine(string.Join(',', s.DailyLossLimit.ToString("0.##", CultureInfo.InvariantCulture), s.Enabled ? "true" : "false",
            s.ChangedOn?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) ?? "", s.TrippedOn?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) ?? "",
            s.UpdatedUtc?.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture) ?? ""));
        var temp = _path + ".tmp";
        File.WriteAllText(temp, csv.ToString());
        File.Move(temp, _path, overwrite: true);
    }
}

/// <summary>The daily loss limit (rupees, the whole Dhan account's P&L for the day) and whether the kill
/// switch is on; ChangedOn - the IST day it was last changed (once a day); TrippedOn - the day it tripped.</summary>
public sealed record RiskSettings(decimal DailyLossLimit, bool Enabled, DateOnly? ChangedOn, DateOnly? TrippedOn, DateTimeOffset? UpdatedUtc);

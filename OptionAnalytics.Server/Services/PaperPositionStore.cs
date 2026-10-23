using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// OI Replay's paper positions - the trade panel's punched orders - for each account and IST day, kept on the server
/// (Storage:PaperPositionsPath, one JSON file per account and day) so every browser the account opens shows the same
/// positions and P&amp;L; they used to live in one browser's localStorage only. A position is the page's own JSON object
/// (an "id", a "status" OPEN / CLOSED, and the rest as the page writes it). A change is an upsert by id - except that a
/// CLOSED position never changes again: when two open browsers both see the same stop-loss hit, the first close stands.
/// Each change bumps the day's version, which the pages poll. Days older than KeepDays are removed - counted from the
/// server's own IST day, never from the date a page sends (a browser whose clock ran a month ahead would otherwise have
/// removed every account's days), and only a day within KeepDays of today, or tomorrow, can be written.
/// </summary>
public sealed class PaperPositionStore
{
    public const int MaxPositions = 500;
    public const int MaxPositionBytes = 4096;
    private const int KeepDays = 30;
    private const int MaxIdLength = 100;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly string _root;
    private readonly object _lock = new();
    private readonly ILogger<PaperPositionStore> _logger;
    private readonly Func<DateOnly> _today;
    private DateOnly _prunedOn;

    public PaperPositionStore(IHostEnvironment environment, IConfiguration configuration, ILogger<PaperPositionStore> logger)
        : this(ResolveRoot(environment, configuration), logger)
    {
    }

    internal PaperPositionStore(string root, ILogger<PaperPositionStore> logger, Func<DateOnly>? today = null)
    {
        _root = root;
        _logger = logger;
        _today = today ?? IstClock.Today;
        Directory.CreateDirectory(_root);
    }

    private static string ResolveRoot(IHostEnvironment environment, IConfiguration configuration)
    {
        var configured = configuration["Storage:PaperPositionsPath"];
        var path = string.IsNullOrWhiteSpace(configured) ? "paper-positions" : configured;
        return Path.IsPathRooted(path) ? path : Path.Combine(environment.ContentRootPath, path);
    }

    /// <summary>One account's day: its positions, the version (0 = nothing saved yet) and whether anything was ever saved
    /// for it (a page with positions from before they were kept here sends them once, when nothing is).</summary>
    public sealed record Snapshot(DateOnly Date, long Version, bool Exists, IReadOnlyList<JsonObject> Positions);

    public Snapshot Get(string account, DateOnly date)
    {
        lock (_lock)
        {
            var day = Read(account, date);
            return day is null ? new Snapshot(date, 0, false, Array.Empty<JsonObject>()) : new Snapshot(date, day.Version, true, day.Positions);
        }
    }

    /// <summary>Applies one change from a page: `clear` empties the day first, then `remove` drops those ids, then each of
    /// `upsert` is added (new id) or replaces its position (an OPEN one - a CLOSED position stays as it is). Returns the day
    /// after it, or why the change was refused (nothing is applied then).</summary>
    public (Snapshot? Result, string? Error) Change(string account, DateOnly date, IReadOnlyList<JsonObject>? upsert, IReadOnlyList<string>? remove, bool clear)
    {
        var today = _today();
        if (date < today.AddDays(-KeepDays) || date > today.AddDays(1))
            return (null, $"Paper positions are kept for today and the last {KeepDays} days only - {date:yyyy-MM-dd} is outside that (is this device's date right?).");
        var incoming = upsert ?? Array.Empty<JsonObject>();
        foreach (var position in incoming)
        {
            if (IdOf(position) is not { Length: > 0 and <= MaxIdLength }) return (null, "Every position needs an id (at most 100 characters).");
            if (Encoding.UTF8.GetByteCount(position.ToJsonString()) > MaxPositionBytes) return (null, $"A position is larger than {MaxPositionBytes} bytes.");
        }

        lock (_lock)
        {
            var existing = Read(account, date);
            var day = existing ?? new Day(0, new List<JsonObject>());
            var positions = clear ? new List<JsonObject>() : day.Positions.ToList();
            var changed = clear && day.Positions.Count > 0;

            if (remove is { Count: > 0 })
                changed |= positions.RemoveAll(p => remove.Contains(IdOf(p))) > 0;

            foreach (var position in incoming)
            {
                var id = IdOf(position);
                var at = positions.FindIndex(p => IdOf(p) == id);
                if (at < 0)
                {
                    if (positions.Count >= MaxPositions) return (null, $"At most {MaxPositions} positions a day.");
                    positions.Add(Copy(position));
                    changed = true;
                }
                else if (!IsClosed(positions[at]) && !JsonNode.DeepEquals(positions[at], position))
                {
                    positions[at] = Copy(position);
                    changed = true;
                }
            }

            // A first save (even of nothing - Clear all) marks the day as kept here.
            if (!changed && existing is not null) return (new Snapshot(date, day.Version, true, day.Positions), null);
            var saved = new Day(day.Version + 1, positions);
            Write(account, date, saved);
            Prune(today);
            return (new Snapshot(date, saved.Version, true, saved.Positions), null);
        }
    }

    private sealed record Day(long Version, IReadOnlyList<JsonObject> Positions);

    private sealed record DayFile(long Version, List<JsonObject> Positions);

    private static string? IdOf(JsonObject position) =>
        position.TryGetPropertyValue("id", out var id) && id is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    private static bool IsClosed(JsonObject position) =>
        position.TryGetPropertyValue("status", out var status) && status is JsonValue value && value.TryGetValue<string>(out var text) && text == "CLOSED";

    private static JsonObject Copy(JsonObject position) => (JsonObject)position.DeepClone();

    // One folder per account, named by a hash of it (an e-mail is not a safe folder name).
    private string AccountDirectory(string account)
    {
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(account.Trim().ToLowerInvariant())))[..16].ToLowerInvariant();
        return Path.Combine(_root, hash);
    }

    private string PathOf(string account, DateOnly date) => Path.Combine(AccountDirectory(account), $"{date:yyyy-MM-dd}.json");

    private Day? Read(string account, DateOnly date)
    {
        var path = PathOf(account, date);
        if (!File.Exists(path)) return null;
        try
        {
            var file = JsonSerializer.Deserialize<DayFile>(File.ReadAllText(path), JsonOptions);
            return file is null ? null : new Day(file.Version, file.Positions ?? new List<JsonObject>());
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "Paper positions: could not read {Path} - treated as empty.", path);
            return new Day(0, new List<JsonObject>());
        }
    }

    private void Write(string account, DateOnly date, Day day)
    {
        var path = PathOf(account, date);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temp = path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(new DayFile(day.Version, day.Positions.ToList()), JsonOptions));
        File.Move(temp, path, overwrite: true);
    }

    // Once a day: every account's days older than KeepDays go.
    private void Prune(DateOnly today)
    {
        if (_prunedOn == today) return;
        _prunedOn = today;
        try
        {
            foreach (var file in Directory.EnumerateFiles(_root, "*.json", SearchOption.AllDirectories))
                if (DateOnly.TryParseExact(Path.GetFileNameWithoutExtension(file), "yyyy-MM-dd", out var day) && day < today.AddDays(-KeepDays))
                    File.Delete(file);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "Paper positions: could not remove old days.");
        }
    }
}

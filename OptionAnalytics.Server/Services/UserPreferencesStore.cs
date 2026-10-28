using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// Each account's page preferences - how its dashboards are laid out and which cards, timeframes, EMAs, tabs and
/// switches it chose: the browser's own "optionanalytics.*" settings, each kept as the exact text the page stored - on
/// the server (Storage:PreferencesPath, one JSON file per account), so a refresh, a server restart or a deploy, another
/// browser or another computer all open the pages the way they were left. The browser keeps its own copy too and reads
/// that at once; this is what a fresh browser starts from (prefsSync.js). A change sets keys and removes the ones sent
/// as null; every change bumps the account's version. The limits keep a page that misbehaves from filling the disk.
/// </summary>
public sealed class UserPreferencesStore
{
    public const string KeyPrefix = "optionanalytics.";
    public const int MaxKeys = 400;
    public const int MaxKeyLength = 120;
    public const int MaxValueBytes = 64 * 1024;
    public const int MaxTotalBytes = 1024 * 1024;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly string _root;
    private readonly object _lock = new();
    private readonly ILogger<UserPreferencesStore> _logger;

    public UserPreferencesStore(IHostEnvironment environment, IConfiguration configuration, ILogger<UserPreferencesStore> logger)
        : this(ResolveRoot(environment, configuration), logger)
    {
    }

    internal UserPreferencesStore(string root, ILogger<UserPreferencesStore> logger)
    {
        _root = root;
        _logger = logger;
        Directory.CreateDirectory(_root);
    }

    private static string ResolveRoot(IHostEnvironment environment, IConfiguration configuration)
    {
        var configured = configuration["Storage:PreferencesPath"];
        var path = string.IsNullOrWhiteSpace(configured) ? "preferences" : configured;
        return Path.IsPathRooted(path) ? path : Path.Combine(environment.ContentRootPath, path);
    }

    /// <summary>An account's preferences and their version (0 = nothing saved yet - the browser then sends what it has).</summary>
    public sealed record Snapshot(long Version, IReadOnlyDictionary<string, string> Values);

    public Snapshot Get(string account)
    {
        lock (_lock)
        {
            var file = Read(account);
            return new Snapshot(file.Version, file.Values);
        }
    }

    /// <summary>Sets each key to its value, or removes it when the value is null. Returns the preferences after it, or
    /// why the change was refused (nothing is applied then).</summary>
    public (Snapshot? Result, string? Error) Change(string account, IReadOnlyDictionary<string, string?>? values)
    {
        if (string.IsNullOrWhiteSpace(account)) return (null, "Not signed in.");
        if (values is null || values.Count == 0) return (null, "Nothing to save.");
        foreach (var (key, value) in values)
        {
            if (!IsValidKey(key)) return (null, $"\"{Shorten(key)}\" is not a page preference (\"{KeyPrefix}...\", at most {MaxKeyLength} characters).");
            if (value is not null && Encoding.UTF8.GetByteCount(value) > MaxValueBytes) return (null, $"\"{key}\" is larger than {MaxValueBytes / 1024} KB.");
        }

        lock (_lock)
        {
            var file = Read(account);
            var next = new Dictionary<string, string>(file.Values, StringComparer.Ordinal);
            var changed = false;
            foreach (var (key, value) in values)
            {
                if (value is null) changed |= next.Remove(key);
                else if (!next.TryGetValue(key, out var old) || old != value)
                {
                    next[key] = value;
                    changed = true;
                }
            }

            if (next.Count > MaxKeys) return (null, $"At most {MaxKeys} preferences an account.");
            if (next.Sum(p => Encoding.UTF8.GetByteCount(p.Key) + Encoding.UTF8.GetByteCount(p.Value)) > MaxTotalBytes)
                return (null, $"An account's preferences are kept to {MaxTotalBytes / 1024} KB.");
            if (!changed) return (new Snapshot(file.Version, file.Values), null);

            var saved = new PreferencesFile(file.Version + 1, next);
            Write(account, saved);
            return (new Snapshot(saved.Version, saved.Values), null);
        }
    }

    public static bool IsValidKey(string? key) =>
        key is { Length: > 0 and <= MaxKeyLength } && key.StartsWith(KeyPrefix, StringComparison.Ordinal) && key.Length > KeyPrefix.Length
        && !key.Any(char.IsControl);

    private static string Shorten(string? key) => key is null ? "" : key.Length <= 40 ? key : key[..40] + "...";

    private sealed record PreferencesFile(long Version, Dictionary<string, string> Values);

    // One file per account, named by a hash of it (an e-mail is not a safe file name).
    private string PathOf(string account)
    {
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(account.Trim().ToLowerInvariant())))[..16].ToLowerInvariant();
        return Path.Combine(_root, $"{hash}.json");
    }

    private PreferencesFile Read(string account)
    {
        var path = PathOf(account);
        if (!File.Exists(path)) return new PreferencesFile(0, new Dictionary<string, string>(StringComparer.Ordinal));
        try
        {
            var file = JsonSerializer.Deserialize<PreferencesFile>(File.ReadAllText(path), JsonOptions);
            var values = new Dictionary<string, string>(file?.Values ?? new Dictionary<string, string>(), StringComparer.Ordinal);
            return new PreferencesFile(file?.Version ?? 0, values);
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "Preferences: could not read {Path} - treated as empty.", path);
            return new PreferencesFile(0, new Dictionary<string, string>(StringComparer.Ordinal));
        }
    }

    private void Write(string account, PreferencesFile file)
    {
        var path = PathOf(account);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temp = path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(file, JsonOptions));
        File.Move(temp, path, overwrite: true);
    }
}

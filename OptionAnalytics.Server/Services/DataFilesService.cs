using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OptionAnalytics.Server.Services;

/// <summary>One place the server keeps files: a folder (browsable) or a single file.</summary>
public sealed record DataPlace(string Key, string Name, string What, bool IsDirectory, string FullPath);

/// <summary>A place as listed: whether it is there, how many files it holds and how big they are (Partial = the count
/// stopped at its limit), and its newest change.</summary>
public sealed record DataPlaceInfo(string Key, string Name, string What, bool IsDirectory, string Path, bool Exists, int Files, long Bytes, bool Partial, DateTimeOffset? ModifiedUtc);

/// <summary>One entry of a folder (Path = relative to its place, '/'-separated).</summary>
public sealed record DataEntry(string Name, string Path, bool IsDirectory, int Files, long Bytes, bool Partial, DateTimeOffset? ModifiedUtc);

/// <summary>The start of a file, as text: csv / json / text, or binary (no text). Gzipped files are read unzipped.</summary>
public sealed record DataFilePreview(string Name, string Path, long Bytes, DateTimeOffset ModifiedUtc, string Kind, bool Gzip, string? Text, bool Truncated);

/// <summary>
/// The files the server keeps - the scanner log (CSV), the scanner runner's config / state and the tuning's results,
/// history and cache of the days it fetched (Dhan API), the cached spot and expired-option data (Dhan API), and the single
/// settings / state files (trade settings, risk settings, live list, server live trades, triggers, order history, time
/// exits) - for the admin's Data files page: listed, read (the start of a file) and downloaded. READ-ONLY.
/// Every path is resolved inside its place (no "..", no link out of it); anything that looks like a secret (appsettings,
/// keys, certificates, tokens, the data-protection key ring) is never listed or served.
/// </summary>
public sealed class DataFilesService
{
    public const int DefaultPreviewBytes = 256 * 1024;
    public const int MaxPreviewBytes = 2 * 1024 * 1024;
    private const int MeasureBudget = 20_000;

    private readonly List<DataPlace> _places = new();

    public DataFilesService(IHostEnvironment environment, IConfiguration configuration)
    {
        string Resolve(string key, string fallback)
        {
            var configured = configuration[key];
            var path = string.IsNullOrWhiteSpace(configured) ? fallback : configured;
            return Path.GetFullPath(Path.IsPathRooted(path) ? path : Path.Combine(environment.ContentRootPath, path));
        }
        void Add(string key, string name, string what, bool dir, string config, string fallback) => _places.Add(new DataPlace(key, name, what, dir, Resolve(config, fallback)));

        Add("scanner-log", "Scanner log", "Every signal and trade the scanners recorded, per index (CSV) - what the Trades page and the live list read.", true, "Storage:ScannerLogPath", "scanner-log");
        Add("scanner-runner", "Scanner runner & tuning", "The server scanner's config and day state; the tuning's results, history and its cache of the days it fetched (cached Dhan API data).", true, "Storage:ScannerRunnerPath", "scanner-runner-data");
        Add("dhan-cache", "Dhan API cache", "Every past-day Dhan Data API response (spot / futures / option candles, the expired-option chain), kept so a closed day is asked of Dhan once (DhanDataCache).", true, "Storage:DhanCachePath", "dhan-cache");
        Add("historical", "Historical spot data", "Cached spot candles (Dhan API).", true, "Storage:HistoricalDataPath", "historical-data");
        Add("expired-options", "Expired option data", "Cached expired-option data (Dhan API).", true, "Storage:ExpiredOptionDataPath", "expired-option-data");
        Add("trade-settings", "Trade settings", "Lots, manual SL / target / trail, the strategies' max rules, slippage and the scanner per index.", false, "Storage:TradeSettingsPath", "trade-settings.csv");
        Add("risk-settings", "Risk settings", "The account's daily loss limit / kill switch.", false, "Storage:RiskSettingsPath", "risk-settings.csv");
        Add("live-list", "Live list", "Which strategies trade live on each index, and why.", false, "Storage:LiveListPath", "live-list.json");
        Add("server-live", "Server live trades", "The server scanner's live trades and each index's Live-today switch.", false, "Storage:ServerLivePath", "server-live.json");
        Add("triggers", "Price triggers", "The armed strategy / price triggers.", false, "Storage:TriggersPath", "strategy-triggers.json");
        Add("order-history", "Trigger order history", "Orders the triggers placed.", false, "Storage:OrderHistoryPath", "trigger-order-history.json");
        Add("live-time-exits", "Live time exits", "The live trades the server will close itself, and when.", false, "Storage:LiveTimeExitsPath", "live-time-exits.json");
    }

    public IReadOnlyList<DataPlace> All => _places;

    /// <summary>A name that could hold a secret: never listed, read or downloaded.</summary>
    public static bool Hidden(string name)
    {
        var n = name.ToLowerInvariant();
        return n.StartsWith("appsettings") || n.StartsWith(".env") || n.StartsWith("dataprotection") || n.StartsWith("key-")
            || n.EndsWith(".pfx") || n.EndsWith(".pem") || n.EndsWith(".key") || n.EndsWith(".p12") || n.EndsWith(".crt")
            || n.Contains("secret") || n.Contains("token") || n.Contains("credential") || n.Contains("password");
    }

    public IReadOnlyList<DataPlaceInfo> Places()
    {
        var list = new List<DataPlaceInfo>();
        foreach (var p in _places)
        {
            if (p.IsDirectory)
            {
                var exists = Directory.Exists(p.FullPath);
                var budget = MeasureBudget;
                var (files, bytes, newest) = exists ? Measure(new DirectoryInfo(p.FullPath), ref budget) : (0, 0L, null);
                list.Add(new DataPlaceInfo(p.Key, p.Name, p.What, true, p.FullPath, exists, files, bytes, budget <= 0, newest));
            }
            else
            {
                var fi = new FileInfo(p.FullPath);
                var ok = fi.Exists && !Hidden(fi.Name);
                list.Add(new DataPlaceInfo(p.Key, p.Name, p.What, false, p.FullPath, ok, ok ? 1 : 0, ok ? fi.Length : 0, false, ok ? fi.LastWriteTimeUtc : null));
            }
        }
        return list;
    }

    /// <summary>A folder's entries (`sub` = a folder inside the place, "" = its top), folders first.</summary>
    public (IReadOnlyList<DataEntry>? Entries, string? Error) List(string key, string? sub)
    {
        var place = _places.FirstOrDefault(p => p.Key == key);
        if (place is null) return (null, "unknown place");
        if (!place.IsDirectory)
        {
            var fi = new FileInfo(place.FullPath);
            return (fi.Exists && !Hidden(fi.Name) ? new[] { new DataEntry(fi.Name, "", false, 1, fi.Length, false, fi.LastWriteTimeUtc) } : Array.Empty<DataEntry>(), null);
        }
        var (dir, error) = Inside(place, sub, directory: true);
        if (dir is null) return (null, error);
        var info = new DirectoryInfo(dir);
        if (!info.Exists) return (Array.Empty<DataEntry>(), null);
        if (info.LinkTarget is not null && sub is { Length: > 0 }) return (null, "not allowed");
        var rel = Relative(place, dir);
        var entries = new List<DataEntry>();
        var budget = MeasureBudget;
        foreach (var d in info.EnumerateDirectories().Where(d => !Hidden(d.Name) && d.LinkTarget is null).OrderBy(d => d.Name, StringComparer.OrdinalIgnoreCase))
        {
            var (files, bytes, newest) = Measure(d, ref budget);
            entries.Add(new DataEntry(d.Name, Join(rel, d.Name), true, files, bytes, budget <= 0, newest ?? d.LastWriteTimeUtc));
        }
        foreach (var f in info.EnumerateFiles().Where(f => !Hidden(f.Name) && f.LinkTarget is null).OrderBy(f => f.Name, StringComparer.OrdinalIgnoreCase))
            entries.Add(new DataEntry(f.Name, Join(rel, f.Name), false, 1, f.Length, false, f.LastWriteTimeUtc));
        return (entries, null);
    }

    /// <summary>The full path of a FILE in a place (a single-file place: that file), or why not.</summary>
    public (string? FullPath, string? Error) File(string key, string? sub)
    {
        var place = _places.FirstOrDefault(p => p.Key == key);
        if (place is null) return (null, "unknown place");
        if (!place.IsDirectory)
        {
            var fi = new FileInfo(place.FullPath);
            return fi.Exists && !Hidden(fi.Name) ? (fi.FullName, null) : (null, "not there");
        }
        var (path, error) = Inside(place, sub, directory: false);
        if (path is null) return (null, error);
        var file = new FileInfo(path);
        if (!file.Exists || file.LinkTarget is not null) return (null, "not there");
        return (file.FullName, null);
    }

    /// <summary>The start of a file (`maxBytes`, unzipped for .gz), as text unless it is binary; small JSON comes indented.</summary>
    public static DataFilePreview Preview(string fullPath, string relativePath, int maxBytes)
    {
        var fi = new FileInfo(fullPath);
        var limit = Math.Clamp(maxBytes, 1024, MaxPreviewBytes);
        var gzip = fi.Name.EndsWith(".gz", StringComparison.OrdinalIgnoreCase);
        var name = gzip ? fi.Name[..^3] : fi.Name;
        byte[] buffer;
        bool truncated;
        using (var file = fi.OpenRead())
        using (Stream input = gzip ? new GZipStream(file, CompressionMode.Decompress) : file)
        {
            buffer = new byte[limit + 1];
            var read = 0;
            int n;
            while (read < buffer.Length && (n = input.Read(buffer, read, buffer.Length - read)) > 0) read += n;
            truncated = read > limit;
            Array.Resize(ref buffer, Math.Min(read, limit));
        }
        if (buffer.Take(8000).Any(b => b == 0)) return new DataFilePreview(fi.Name, relativePath, fi.Length, fi.LastWriteTimeUtc, "binary", gzip, null, truncated);
        var text = Encoding.UTF8.GetString(buffer);
        var ext = Path.GetExtension(name).ToLowerInvariant();
        var kind = ext is ".csv" ? "csv" : ext is ".json" ? "json" : "text";
        if (kind == "json" && !truncated)
        {
            try { text = JsonNode.Parse(text)?.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) ?? text; } catch { /* shown as it is */ }
        }
        return new DataFilePreview(fi.Name, relativePath, fi.Length, fi.LastWriteTimeUtc, kind, gzip, text, truncated);
    }

    public string RelativeOf(string key, string fullPath)
    {
        var place = _places.First(p => p.Key == key);
        return place.IsDirectory ? Relative(place, fullPath) : "";
    }

    // `sub` resolved inside the place's folder: no rooted path, nothing outside it, no hidden part on the way.
    private static (string? Path, string? Error) Inside(DataPlace place, string? sub, bool directory)
    {
        var root = place.FullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var rel = (sub ?? "").Replace('\\', '/').Trim('/');
        if (rel.Length == 0) return directory ? (root, null) : (null, "no file named");
        if (Path.IsPathRooted(rel) || rel.Split('/').Any(part => part is "" or "." or ".." || Hidden(part))) return (null, "not allowed");
        var full = Path.GetFullPath(Path.Combine(root, rel.Replace('/', Path.DirectorySeparatorChar)));
        if (!full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal)) return (null, "not allowed");
        // No link on the way out of the place.
        for (var d = new DirectoryInfo(Path.GetDirectoryName(full)!); d.FullName.Length > root.Length; d = d.Parent!)
            if (d.Exists && d.LinkTarget is not null) return (null, "not allowed");
        return (full, null);
    }

    private static string Relative(DataPlace place, string full)
    {
        var root = place.FullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        return full.Length <= root.Length ? "" : full[(root.Length + 1)..].Replace(Path.DirectorySeparatorChar, '/');
    }

    private static string Join(string rel, string name) => rel.Length == 0 ? name : $"{rel}/{name}";

    // Files, bytes and the newest change under a folder - at most `budget` files looked at (shared across a listing).
    private static (int Files, long Bytes, DateTimeOffset? Newest) Measure(DirectoryInfo dir, ref int budget)
    {
        var files = 0;
        long bytes = 0;
        DateTimeOffset? newest = null;
        try
        {
            foreach (var f in dir.EnumerateFiles("*", new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint }))
            {
                if (budget-- <= 0) break;
                if (Hidden(f.Name)) continue;
                files++;
                bytes += f.Length;
                if (newest is null || f.LastWriteTimeUtc > newest) newest = f.LastWriteTimeUtc;
            }
        }
        catch (Exception) { /* a folder that went away while counting */ }
        return (files, bytes, newest);
    }
}

using System.Collections.Concurrent;
using System.Text.Json;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services.OrderFlow;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// The admin CACHE page's server side (asked for - "a page to see all the cache files and manage them; I can delete ... delete
/// folder"): the server's DATA CACHES - files it can always fetch again - listed folder by folder with their sizes, and a
/// file or a whole folder deleted on request:
/// <list type="bullet">
/// <item>dhan - the Dhan data cache (Storage:DhanCachePath - DhanDataCache): every PAST day Dhan sent, one gzip file per
/// instrument and day under v1/, NSE's past days (nse/ - NseDayStore) and Dhan's scrip master (scrip-master/). A day deleted
/// is asked of Dhan again the next time it is needed; the folder's size is counted again after a delete (TrimNow).</item>
/// <item>order-flow - the futures order flow the server recorded live (Storage:OrderFlowPath - OrderFlowDayStore): a day
/// deleted comes back as the estimate from Dhan's candles; its read-back copies in memory are dropped (ForgetLoaded);
/// today's file is written again at the next checkpoint.</item>
/// <item>historical / expired-options - the Expired Backtest's spot and option CSVs (HistoricalSpotDataStore,
/// ExpiredOptionDataStore), fetched again by their prefetch / when needed.</item>
/// </list>
/// Nothing else is listed: settings, saved strategies, preferences, logs and the login keys are not caches. Every path is
/// RELATIVE to its cache's folder and checked: no "..", nothing absolute, nothing that resolves outside the folder, and no
/// symlink is followed - one on the way is refused, one inside a folder being deleted is removed itself, never what it
/// points at. Folder totals are counted on request (kept 30 s; a delete drops them).
/// </summary>
public sealed class CacheBrowser
{
    /// <summary>At most this many entries a folder are listed (folders first, by name) - the rest are counted, not listed.</summary>
    public const int MaxEntries = 2000;
    private static readonly TimeSpan TotalsKeptFor = TimeSpan.FromSeconds(30);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly IReadOnlyList<CacheRoot> _roots;
    private readonly ILogger _logger;
    private readonly ConcurrentDictionary<string, (DateTime At, CacheTotals Totals)> _totals = new(StringComparer.Ordinal);

    internal Func<DateTime> Clock { get; set; } = () => DateTime.UtcNow;
    internal Func<string> Today { get; set; } = () => IstClock.Today().ToString("yyyy-MM-dd");

    public CacheBrowser(DhanDataCache dhan, OrderFlowDayStore orderFlow, HistoricalSpotDataStore historical, ExpiredOptionDataStore expiredOptions,
        ILogger<CacheBrowser> logger)
        : this(new[]
        {
            new CacheRoot("dhan", "Dhan data cache", dhan.Directory,
                $"Every past day Dhan sent - spot, futures and option 1-minute candles, the expired-option chain - one gzip file per instrument and day (v1), NSE's past days (nse) and Dhan's instrument list (scrip-master). A day deleted is asked of Dhan again the next time it is needed. Held to {dhan.MaxBytes / 1073741824d:0.#} GB - over it, the files read least recently go first.",
                () => Task.Run(() => { try { dhan.TrimNow(); } catch (Exception ex) { logger.LogWarning(ex, "Counting the Dhan cache again failed."); } })),
            new CacheRoot("order-flow", "Order Flow days", orderFlow.Root,
                "The futures order flow the server recorded live - footprint, tape, book - one gzip file per contract and day (the newest 30 dates). A day deleted comes back as the estimate from Dhan's 1-minute candles; today's file is written again at the next checkpoint (every 5 min).",
                orderFlow.ForgetLoaded),
            new CacheRoot("historical", "Historical spot CSVs", historical.Folder,
                "Six months of NIFTY / BANKNIFTY 1-minute spot for the Expired Backtest (its prefetch, when it is on - fetched again at the next start).",
                null),
            new CacheRoot("expired-options", "Expired option CSVs", expiredOptions.Folder,
                "Rolling / expired option bars, one CSV per expiry, for the Expired Backtest - fetched again when needed.",
                null),
        }, logger)
    { }

    internal CacheBrowser(IReadOnlyList<CacheRoot> roots, ILogger logger)
    {
        _roots = roots;
        _logger = logger;
    }

    /// <summary>Each cache: what it is, its folder and what it holds now.</summary>
    public IReadOnlyList<CacheRootInfo> Roots() => _roots.Select(r =>
    {
        var exists = r.Path is not null && Directory.Exists(r.Path);
        return new CacheRootInfo(r.Id, r.Name, r.About, r.Path is null ? null : Path.GetFullPath(r.Path), exists,
            exists ? Totals(Path.GetFullPath(r.Path!)) : CacheTotals.Empty);
    }).ToList();

    /// <summary>One folder of a cache (`path` relative to its root, "" = the root): its folders (with their totals) and files.</summary>
    public (CacheListing? Listing, string? Error) List(string rootId, string? path)
    {
        var (root, full, rel, error) = Resolve(rootId, path);
        if (error is not null) return (null, error);
        if (!Directory.Exists(full)) return (null, File.Exists(full) ? "That is a file - open its folder." : "Not found - deleted already?");
        var entries = new List<CacheEntry>();
        var count = 0;
        foreach (var info in Children(full!).OrderBy(i => i is FileInfo).ThenBy(i => i.Name, StringComparer.Ordinal))
        {
            if (++count > MaxEntries) continue;
            var childRel = rel.Length == 0 ? info.Name : $"{rel}/{info.Name}";
            var about = Hint(root!.Id, rel, info);
            entries.Add(info is DirectoryInfo dir
                ? Folder(dir, childRel, about)
                : new CacheEntry(info.Name, childRel, false, ((FileInfo)info).Length, 1, Utc(info.LastWriteTimeUtc), about));
        }
        return (new CacheListing(root!.Id, root.Name, rel, Totals(full!), entries, count > MaxEntries ? count : null), null);
    }

    private CacheEntry Folder(DirectoryInfo dir, string rel, string? about)
    {
        var totals = Totals(dir.FullName);
        return new CacheEntry(dir.Name, rel, true, totals.Bytes, totals.Files, totals.NewestUtc, about);
    }

    /// <summary>Deletes a file, or a folder and everything in it; `path` "" = everything IN the cache (the folder itself
    /// stays). A symlink is removed itself, never followed. What could not be deleted is counted, the first reason kept.</summary>
    public (CacheDeleteResult? Result, string? Error) Delete(string rootId, string? path, string who)
    {
        var (root, full, rel, error) = Resolve(rootId, path);
        if (error is not null) return (null, error);
        var tally = new Tally();
        if (rel.Length == 0 || Directory.Exists(full))
        {
            if (!Directory.Exists(full)) return (null, "Not found - deleted already?");
            DeleteTree(full!, tally, removeSelf: rel.Length > 0);
        }
        else if (File.Exists(full))
        {
            try
            {
                var length = new FileInfo(full!).Length;
                File.Delete(full!);
                tally.Files++;
                tally.Bytes += length;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { tally.Fail(ex); }
        }
        else return (null, "Not found - deleted already?");
        _totals.Clear();
        try { root!.AfterDelete?.Invoke(); }
        catch (Exception ex) { _logger.LogWarning(ex, "After deleting from the {Cache} cache.", root!.Name); }
        _logger.LogWarning("{Who} deleted {Cache}/{Path}: {Files} file(s), {Bytes} bytes{Failed}.", who, root!.Id, rel.Length == 0 ? "(everything)" : rel,
            tally.Files, tally.Bytes, tally.Failed > 0 ? $", {tally.Failed} could not be deleted ({tally.FirstError})" : "");
        return (new CacheDeleteResult(tally.Files, tally.Bytes, tally.Failed, tally.FirstError), null);
    }

    private static void DeleteTree(string dir, Tally tally, bool removeSelf)
    {
        IEnumerable<FileSystemInfo> children;
        try { children = new DirectoryInfo(dir).EnumerateFileSystemInfos("*", new EnumerationOptions { IgnoreInaccessible = true, AttributesToSkip = 0 }).ToList(); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { tally.Fail(ex); return; }
        foreach (var info in children)
        {
            try
            {
                if (IsLink(info)) { File.Delete(info.FullName); continue; }      // the link itself, never what it points at
                if (info is DirectoryInfo) { DeleteTree(info.FullName, tally, removeSelf: true); continue; }
                var length = ((FileInfo)info).Length;
                info.Delete();
                tally.Files++;
                tally.Bytes += length;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { tally.Fail(ex); }
        }
        if (!removeSelf) return;
        try { Directory.Delete(dir, recursive: false); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { tally.Fail(ex); }
    }

    private sealed class Tally
    {
        public long Files, Bytes;
        public int Failed;
        public string? FirstError;
        public void Fail(Exception ex) { Failed++; FirstError ??= ex.Message; }
    }

    // ---- Paths -----------------------------------------------------------------------------------------------------------

    /// <summary>A path inside a cache as the page sends it: relative, '/' between folders - "" for the root; null when it is
    /// not one (absolute, "..", ".", a drive, a NUL, too long).</summary>
    internal static string? Clean(string? path)
    {
        var p = (path ?? "").Replace('\\', '/').Trim();
        if (p.Length > 1024 || p.Contains('\0') || p.StartsWith('/') || Path.IsPathRooted(p)) return null;
        var parts = p.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Any(s => s is "." or ".." || s.Contains(':'))) return null;
        return string.Join('/', parts);
    }

    private (CacheRoot? Root, string? Full, string Rel, string? Error) Resolve(string rootId, string? path)
    {
        var root = _roots.FirstOrDefault(r => string.Equals(r.Id, rootId, StringComparison.OrdinalIgnoreCase));
        if (root is null) return (null, null, "", "No such cache.");
        if (root.Path is null) return (null, null, "", $"{root.Name} are not kept on disk on this server.");
        var rel = Clean(path);
        if (rel is null) return (null, null, "", "Not a path inside this cache.");
        var rootFull = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root.Path));
        var full = rel.Length == 0 ? rootFull : Path.GetFullPath(Path.Combine(rootFull, rel.Replace('/', Path.DirectorySeparatorChar)));
        if (full != rootFull && !full.StartsWith(rootFull + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            return (null, null, "", "Not a path inside this cache.");
        // No link on the way: a symlinked folder inside the cache could lead anywhere.
        var walk = rootFull;
        foreach (var part in rel.Split('/', StringSplitOptions.RemoveEmptyEntries))
        {
            walk = Path.Combine(walk, part);
            if (IsLink(walk)) return (null, null, "", "That is a link - links are not followed.");
        }
        return (root, full, rel, null);
    }

    private static bool IsLink(string path)
    {
        try
        {
            FileSystemInfo info = Directory.Exists(path) ? new DirectoryInfo(path) : new FileInfo(path);
            return info.Exists && IsLink(info);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return true; }
    }

    private static bool IsLink(FileSystemInfo info) => info.LinkTarget is not null || info.Attributes.HasFlag(FileAttributes.ReparsePoint);

    private static IEnumerable<FileSystemInfo> Children(string dir) =>
        new DirectoryInfo(dir).EnumerateFileSystemInfos("*", new EnumerationOptions { IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint });

    // ---- Totals ----------------------------------------------------------------------------------------------------------

    /// <summary>A folder's files, bytes and newest / oldest change, everything under it (links not followed) - counted again
    /// after 30 s or a delete.</summary>
    private CacheTotals Totals(string dir)
    {
        if (_totals.TryGetValue(dir, out var kept) && Clock() - kept.At < TotalsKeptFor) return kept.Totals;
        long files = 0, bytes = 0;
        DateTime? newest = null, oldest = null;
        try
        {
            foreach (var file in new DirectoryInfo(dir).EnumerateFiles("*", new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint }))
            {
                try
                {
                    var length = file.Length;
                    var at = file.LastWriteTimeUtc;
                    files++;
                    bytes += length;
                    if (newest is null || at > newest) newest = at;
                    if (oldest is null || at < oldest) oldest = at;
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }       // gone while counted
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        var totals = new CacheTotals(files, bytes, newest is { } n ? Utc(n) : null, oldest is { } o ? Utc(o) : null);
        _totals[dir] = (Clock(), totals);
        return totals;
    }

    private static DateTimeOffset Utc(DateTime t) => new(DateTime.SpecifyKind(t, DateTimeKind.Utc));

    // ---- What a folder / file is, where it is known ----------------------------------------------------------------------

    private string? Hint(string rootId, string parentRel, FileSystemInfo info)
    {
        var name = info.Name;
        var depth = parentRel.Length == 0 ? 0 : parentRel.Split('/').Length;
        switch (rootId)
        {
            case "dhan":
                if (depth == 0)
                {
                    return name switch
                    {
                        "v1" => "Dhan's answers by kind of call - one gzip file per instrument and day",
                        "nse" => "NSE's past days - contract lists and expired futures' 1-minute bars",
                        "scrip-master" => "Dhan's instrument list - downloaded again when missing or 4 h old",
                        _ => null,
                    };
                }
                if (parentRel == "v1")
                {
                    return name switch
                    {
                        "charts-intraday" => "1-minute candles - spot, futures and options",
                        "charts-rollingoption" => "Expired / rolling option candles",
                        _ => null,
                    };
                }
                if (info is DirectoryInfo && name == "days") return "A folder a month, then a day";
                if (info is FileInfo && name.EndsWith(".tmp", StringComparison.Ordinal)) return "Being written";
                if (info is FileInfo && name.EndsWith(".json.gz", StringComparison.Ordinal)) return "One instrument's day - named by the day and a hash of the request";
                return null;
            case "order-flow":
                if (depth == 1 && info is DirectoryInfo contract)
                {
                    try
                    {
                        var file = Path.Combine(contract.FullName, "contract.json");
                        if (!File.Exists(file)) return null;
                        var c = JsonSerializer.Deserialize<ContractName>(File.ReadAllText(file), Json);
                        return c?.ContractSymbol is { Length: > 0 } symbol ? (c.Expiry is { } e ? $"{symbol} · expiry {e:dd MMM yyyy}" : symbol) : null;
                    }
                    catch { return null; }
                }
                if (name == "contract.json") return "The contract's name";
                if (info is FileInfo && name.StartsWith(Today(), StringComparison.Ordinal) && name.EndsWith(".json.gz", StringComparison.Ordinal))
                    return "Today - written again at the next checkpoint (every 5 min)";
                return null;
            case "historical":
                if (name.EndsWith("_spot_1m.csv", StringComparison.Ordinal)) return $"{name.Split('_')[0]} 1-minute spot candles";
                if (name.EndsWith(".meta.json", StringComparison.Ordinal)) return "Which days the CSV covers";
                return null;
            default:
                return null;
        }
    }

    private sealed record ContractName(string? ContractSymbol, DateOnly? Expiry);
}

/// <summary>A cache the page lists: its id, name, folder (null = not kept on disk here), what it is, and what to do after a
/// delete in it (drop copies held in memory, count it again).</summary>
public sealed record CacheRoot(string Id, string Name, string? Path, string About, Action? AfterDelete);

public sealed record CacheTotals(long Files, long Bytes, DateTimeOffset? NewestUtc, DateTimeOffset? OldestUtc)
{
    public static readonly CacheTotals Empty = new(0, 0, null, null);
}

public sealed record CacheRootInfo(string Id, string Name, string About, string? Path, bool Exists, CacheTotals Totals);

/// <summary>A folder (its totals) or a file in a listing; `Path` relative to the cache's folder.</summary>
public sealed record CacheEntry(string Name, string Path, bool Folder, long Bytes, long Files, DateTimeOffset? ModifiedUtc, string? About);

/// <summary>`Truncated`: how many entries the folder has when over MaxEntries (only the first are listed).</summary>
public sealed record CacheListing(string Root, string RootName, string Path, CacheTotals Totals, IReadOnlyList<CacheEntry> Entries, int? Truncated);

public sealed record CacheDeleteResult(long Files, long Bytes, int Failed, string? FirstError);

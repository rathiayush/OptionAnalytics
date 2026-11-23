using System.Collections.Concurrent;
using System.IO.Compression;
using System.Text.Json;
using OptionAnalytics.Server.Dhan;
using OptionAnalytics.Server.Services.OrderFlow;
using OptionAnalytics.Server.Services.SignalStrategies;
using OptionAnalytics.Server.Services.Visitors;
using OptionAnalytics.Server.Telegram;

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
/// DOWNLOAD (asked for - "give option to download whole data as zip"): a file as it is, a folder (or a whole cache) as ONE
/// zip, or every cache in one zip (each its own top folder) - written straight into the response as it is read
/// (WriteZip - no copy on the server's disk first, a 10 GB cache included); the cache's gzip files are stored as they are
/// (squeezing gzip again only costs time), the rest deflated; a file being written (.tmp) or gone meanwhile is left out.
/// THE SERVER'S OWN RECORDS (asked for - "whatever files the system is generating, all CSV, give an option to download them
/// as well; show the folders with their paths"): read-only roots beside the caches - DOWNLOAD ONLY, never deleted here
/// (they are not fetched again): the Telegram message log (a CSV a day), the visitor log (a CSV a day), the saved strategies
/// (strategies.csv and each one's trades / days / events / live orders CSVs), the background runs (settings, reports, the
/// Feature finder's dataset CSV), and the trade / risk settings CSVs (single files in the data folder - `Only`, so nothing
/// else of that folder is ever listed or zipped). Not listed at all: the login keys (data protection), the Telegram
/// sign-in, the preferences and paper positions, the runner's config. Every root and every listing says its folder's FULL
/// path on the server. Every path is
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
        TelegramMessageLog telegramLog, VisitorLog visitors, ScannerRunnerStore scanner, TradeSettingsStore tradeSettings, RiskSettingsStore riskSettings,
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
            new CacheRoot("telegram-log", "Telegram message log", telegramLog.Root,
                "Every Telegram message the server sent, a CSV a day (IST) - time, status and the text as sent - and the days read back from the Telegram channel (from-telegram). Download only.",
                null, ReadOnly: true),
            new CacheRoot("visitor-log", "Visitor log", visitors.Root,
                "Every page opened, sign-in and sign-out with the city / country of the connection (never an IP address), a CSV a day (IST), 90 days. Download only.",
                null, ReadOnly: true),
            new CacheRoot("signal-strategies", "Saved strategies", Path.Combine(scanner.DataDirectory, "signal-strategies"),
                "strategies.csv - every saved strategy with its settings - and history/: each strategy's trades, day reports, alerts sent and live Dhan orders, a CSV each. Download only.",
                null, ReadOnly: true),
            new CacheRoot("signal-backtests", "Background runs", Path.Combine(scanner.DataDirectory, "signal-backtests"),
                "The Signal backtest's background runs - each run's settings and progress (.json), its report (.result.json) and a Feature finder run's dataset (.features.csv). Download only.",
                null, ReadOnly: true),
            new CacheRoot("trade-settings", "Trade settings CSV", Path.GetDirectoryName(Path.GetFullPath(tradeSettings.FilePath)),
                "Lots, SL / target / trail, slippage and the server alerts per index - the file the Trade settings page writes. Download only.",
                null, ReadOnly: true, Only: new[] { Path.GetFileName(tradeSettings.FilePath) }),
            new CacheRoot("risk-settings", "Risk settings CSV", Path.GetDirectoryName(Path.GetFullPath(riskSettings.FilePath)),
                "The risk limits - the file the Risk page writes. Download only.",
                null, ReadOnly: true, Only: new[] { Path.GetFileName(riskSettings.FilePath) }),
        }, logger)
    { }

    internal CacheBrowser(IReadOnlyList<CacheRoot> roots, ILogger logger)
    {
        _roots = roots;
        _logger = logger;
    }

    /// <summary>Each cache / record folder: what it is, its FULL path (a one-file root: the file's), whether it is download
    /// only, and what it holds now.</summary>
    public IReadOnlyList<CacheRootInfo> Roots() => _roots.Select(r =>
    {
        var exists = r.Path is not null && Directory.Exists(r.Path) && (r.Only is null || OnlyFiles(r).Any());
        var shown = r.Path is null ? null : r.Only is { Count: 1 } ? Path.Combine(Path.GetFullPath(r.Path), r.Only[0]) : Path.GetFullPath(r.Path);
        return new CacheRootInfo(r.Id, r.Name, r.About, shown, exists, !exists ? CacheTotals.Empty : r.Only is null ? Totals(Path.GetFullPath(r.Path!)) : FilesTotals(OnlyFiles(r)),
            r.ReadOnly, r.ReadOnly ? "records" : "cache");
    }).ToList();

    /// <summary>A one-file root's files that are there, as FileInfos.</summary>
    private static IEnumerable<FileInfo> OnlyFiles(CacheRoot r) =>
        (r.Only ?? Array.Empty<string>()).Select(n => new FileInfo(Path.Combine(Path.GetFullPath(r.Path!), n))).Where(f => f.Exists && !IsLink(f));

    private static CacheTotals FilesTotals(IEnumerable<FileInfo> files)
    {
        var list = files.ToList();
        if (list.Count == 0) return CacheTotals.Empty;
        return new CacheTotals(list.Count, list.Sum(f => f.Length), Utc(list.Max(f => f.LastWriteTimeUtc)), Utc(list.Min(f => f.LastWriteTimeUtc)));
    }

    /// <summary>One folder of a cache (`path` relative to its root, "" = the root): its folders (with their totals) and files.</summary>
    public (CacheListing? Listing, string? Error) List(string rootId, string? path)
    {
        var (root, full, rel, error) = Resolve(rootId, path);
        if (error is not null) return (null, error);
        if (!Directory.Exists(full)) return (null, File.Exists(full) ? "That is a file - open its folder." : "Not found - deleted already?");
        if (root!.Only is not null)
        {
            var only = OnlyFiles(root).ToList();
            var listed = only.Select(f => new CacheEntry(f.Name, f.Name, false, f.Length, 1, Utc(f.LastWriteTimeUtc), Hint(root.Id, "", f), f.FullName)).ToList();
            return (new CacheListing(root.Id, root.Name, "", FilesTotals(only), listed, null, full, root.ReadOnly), null);
        }
        var entries = new List<CacheEntry>();
        var count = 0;
        foreach (var info in Children(full!).OrderBy(i => i is FileInfo).ThenBy(i => i.Name, StringComparer.Ordinal))
        {
            if (++count > MaxEntries) continue;
            var childRel = rel.Length == 0 ? info.Name : $"{rel}/{info.Name}";
            var about = Hint(root!.Id, rel, info);
            entries.Add(info is DirectoryInfo dir
                ? Folder(dir, childRel, about)
                : new CacheEntry(info.Name, childRel, false, ((FileInfo)info).Length, 1, Utc(info.LastWriteTimeUtc), about, info.FullName));
        }
        return (new CacheListing(root!.Id, root.Name, rel, Totals(full!), entries, count > MaxEntries ? count : null, full, root.ReadOnly), null);
    }

    private CacheEntry Folder(DirectoryInfo dir, string rel, string? about)
    {
        var totals = Totals(dir.FullName);
        return new CacheEntry(dir.Name, rel, true, totals.Bytes, totals.Files, totals.NewestUtc, about, dir.FullName);
    }

    /// <summary>Deletes a file, or a folder and everything in it; `path` "" = everything IN the cache (the folder itself
    /// stays). A symlink is removed itself, never followed. What could not be deleted is counted, the first reason kept.</summary>
    public (CacheDeleteResult? Result, string? Error) Delete(string rootId, string? path, string who)
    {
        var (root, full, rel, error) = Resolve(rootId, path);
        if (error is not null) return (null, error);
        if (root!.ReadOnly) return (null, $"{root.Name}: the server's own records - download only, never deleted here.");
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

    /// <summary>What downloading `path` gives: a FILE, sent as it is, or a FOLDER ("" = the whole cache) zipped - with the
    /// name it is saved under and the folder name inside the zip.</summary>
    public (CacheDownload? Download, string? Error) Download(string rootId, string? path)
    {
        var (root, full, rel, error) = Resolve(rootId, path);
        if (error is not null) return (null, error);
        var stamp = Today();
        if (rel.Length > 0 && File.Exists(full)) return (new CacheDownload(full!, false, Path.GetFileName(full!), "", new FileInfo(full!).Length), null);
        if (!Directory.Exists(full)) return (null, "Not found - deleted already?");
        if (root!.Only is not null)
        {
            var files = OnlyFiles(root).ToList();
            return (new CacheDownload(full!, true, $"{root.Id}-{stamp}.zip", root.Id, files.Sum(f => f.Length))
            { Sources = files.Select(f => (root.Id, f.FullName)).ToList() }, null);
        }
        var inside = rel.Length == 0 ? root!.Id : rel.Split('/')[^1];
        var name = rel.Length == 0 ? $"{root!.Id}-{stamp}.zip" : $"{root!.Id}-{rel.Replace('/', '-')}-{stamp}.zip";
        return (new CacheDownload(full!, true, name, inside, Totals(full!).Bytes), null);
    }

    /// <summary>What a zip of many roots holds, as (its id, a folder - or one file of a one-file root): `kind` "caches" (the
    /// default - the data caches, as the one zip of everything always was), "records" (the server's own records) or "all".</summary>
    public IReadOnlyList<(string Prefix, string Folder)> AllFolders(string kind = "caches") =>
        _roots.Where(r => r.Path is not null && Directory.Exists(r.Path))
            .Where(r => kind == "all" || (kind == "records") == r.ReadOnly)
            .SelectMany(r => r.Only is null
                ? new[] { (r.Id, Path.GetFullPath(r.Path!)) }
                : OnlyFiles(r).Select(f => (r.Id, f.FullName)).ToArray())
            .ToList();

    /// <summary>The folders written as ONE zip into <paramref name="output"/> as they are read (nothing kept on the server):
    /// each file under its folder's prefix, by its path inside the folder; links not followed, a file being written (.tmp)
    /// or gone meanwhile left out; a gzip / zip file stored as it is, the rest deflated (fastest). Stops at
    /// <paramref name="cancel"/> (the browser went away). Returns the files and bytes put in. A source that is a FILE (a
    /// one-file root's) goes in as {prefix}/{its name}; `include` (by file name - the CSV-only zip) leaves the rest out.</summary>
    public (long Files, long Bytes) WriteZip(Stream output, IEnumerable<(string Prefix, string Folder)> folders, CancellationToken cancel = default,
        Func<string, bool>? include = null)
    {
        long files = 0, bytes = 0;
        using var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true);
        foreach (var (prefix, folder) in folders)
        {
            var single = !Directory.Exists(folder) && File.Exists(folder);
            if (!single && !Directory.Exists(folder)) continue;
            var baseDir = single ? Path.GetDirectoryName(folder)! : folder;
            var options = new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint };
            IEnumerable<FileInfo> found = single ? new[] { new FileInfo(folder) } : new DirectoryInfo(folder).EnumerateFiles("*", options).OrderBy(f => f.FullName, StringComparer.Ordinal);
            foreach (var file in found)
            {
                cancel.ThrowIfCancellationRequested();
                if (file.Name.EndsWith(".tmp", StringComparison.Ordinal) || IsLink(file)) continue;
                if (include is not null && !include(file.Name)) continue;
                FileStream source;
                try { source = new FileStream(file.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete); }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { continue; }       // gone / locked meanwhile
                using (source)
                {
                    var inside = Path.GetRelativePath(baseDir, file.FullName).Replace(Path.DirectorySeparatorChar, '/');
                    var stored = file.Name.EndsWith(".gz", StringComparison.OrdinalIgnoreCase) || file.Name.EndsWith(".zip", StringComparison.OrdinalIgnoreCase);
                    var entry = zip.CreateEntry(prefix.Length > 0 ? $"{prefix}/{inside}" : inside, stored ? CompressionLevel.NoCompression : CompressionLevel.Fastest);
                    entry.LastWriteTime = file.LastWriteTime;
                    using var target = entry.Open();
                    source.CopyTo(target);
                    files++;
                    bytes += source.Length;
                }
            }
        }
        return (files, bytes);
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
        // A one-file root: only its own files, nothing else of the folder it sits in.
        if (root.Only is not null && rel.Length > 0 && !root.Only.Contains(rel, StringComparer.Ordinal)) return (null, null, "", "Not a path inside this cache.");
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
            case "telegram-log":
                if (info is DirectoryInfo && name == "from-telegram") return "Days read back from the Telegram channel - one gzip file a day";
                if (name == "covered-from.txt") return "Since when the log records - a day after it is whole";
                if (name.EndsWith(".csv", StringComparison.Ordinal)) return name.StartsWith(Today(), StringComparison.Ordinal) ? "Today's messages - still being written" : "The messages sent that day (IST)";
                return null;
            case "visitor-log":
                if (name.EndsWith(".csv", StringComparison.Ordinal)) return name.StartsWith(Today(), StringComparison.Ordinal) ? "Today's visits - still being written" : "The visits that day (IST)";
                return null;
            case "signal-strategies":
                if (depth == 0 && name == "strategies.csv") return "Every saved strategy - its switches and settings";
                if (depth == 0 && info is DirectoryInfo && name == "history") return "Each strategy's trades, day reports, alerts and live orders";
                if (info is FileInfo && parentRel == "history" && name.EndsWith(".csv", StringComparison.Ordinal))
                {
                    var stem = name[..^4];
                    var cut = stem.LastIndexOf('-');
                    if (cut <= 0) return null;
                    var kind = stem[(cut + 1)..] switch
                    {
                        "trades" => "Trades - written as each signal comes",
                        "days" => "Day reports",
                        "events" => "Entries / exits sent",
                        "orders" => "Live Dhan orders",
                        _ => null,
                    };
                    var strategy = StrategyNames(info is FileInfo f ? f.Directory?.Parent?.FullName : null).GetValueOrDefault(stem[..cut]);
                    return kind is null ? null : strategy is null ? kind : $"{strategy} - {kind.ToLowerInvariant()}";
                }
                return null;
            case "signal-backtests":
                if (name.EndsWith(".features.csv", StringComparison.Ordinal)) return RunName(info, ".features.csv") is { } run ? $"{run} - Feature finder dataset (a row a candle)" : "Feature finder dataset (a row a candle)";
                if (name.EndsWith(".result.json", StringComparison.Ordinal)) return RunName(info, ".result.json") is { } r2 ? $"{r2} - its report" : "A run's report";
                if (name.EndsWith(".json", StringComparison.Ordinal)) return RunName(info, ".json") is { } r3 ? $"{r3} - settings and progress" : "A run's settings and progress";
                return null;
            case "trade-settings":
                return "Trade settings per index";
            case "risk-settings":
                return "Risk limits";
            default:
                return null;
        }
    }

    /// <summary>The saved strategies' names by id (strategies.csv in `folder`) - to name each history file.</summary>
    private static Dictionary<string, string> StrategyNames(string? folder)
    {
        var names = new Dictionary<string, string>(StringComparer.Ordinal);
        try
        {
            var file = folder is null ? null : Path.Combine(folder, "strategies.csv");
            if (file is null || !File.Exists(file)) return names;
            foreach (var row in CsvTable.Read(file))
                if (row.TryGetValue("id", out var id) && row.TryGetValue("name", out var name) && id.Length > 0) names[id] = name;
        }
        catch { /* a name is only a hint */ }
        return names;
    }

    /// <summary>A background run's name from its {id}.json beside the file (`suffix` cut off the file's name to get the id).</summary>
    private static string? RunName(FileSystemInfo info, string suffix)
    {
        try
        {
            var id = info.Name[..^suffix.Length];
            var dir = (info as FileInfo)?.DirectoryName;
            if (dir is null || id.Length == 0) return null;
            var job = Path.Combine(dir, $"{id}.json");
            if (!File.Exists(job) || new FileInfo(job).Length > 512 * 1024) return null;
            using var doc = JsonDocument.Parse(File.ReadAllText(job));
            return doc.RootElement.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() : null;
        }
        catch { return null; }
    }

    private sealed record ContractName(string? ContractSymbol, DateOnly? Expiry);
}

/// <summary>A cache the page lists: its id, name, folder (null = not kept on disk here), what it is, and what to do after a
/// delete in it (drop copies held in memory, count it again).
/// `ReadOnly` = the server's own records: download only, never deleted here. `Only` = the file names this root shows of its
/// folder (a settings CSV in the data folder) - nothing else of that folder is listed, downloaded or zipped.</summary>
public sealed record CacheRoot(string Id, string Name, string? Path, string About, Action? AfterDelete, bool ReadOnly = false, IReadOnlyList<string>? Only = null);

public sealed record CacheTotals(long Files, long Bytes, DateTimeOffset? NewestUtc, DateTimeOffset? OldestUtc)
{
    public static readonly CacheTotals Empty = new(0, 0, null, null);
}

/// <summary>`Path` - the folder's full path on the server (a one-file root's: the file's); `Kind` "cache" / "records".</summary>
public sealed record CacheRootInfo(string Id, string Name, string About, string? Path, bool Exists, CacheTotals Totals, bool ReadOnly = false, string Kind = "cache");

/// <summary>A folder (its totals) or a file in a listing; `Path` relative to the cache's folder, `FullPath` on the server.</summary>
public sealed record CacheEntry(string Name, string Path, bool Folder, long Bytes, long Files, DateTimeOffset? ModifiedUtc, string? About, string? FullPath = null);

/// <summary>`Truncated`: how many entries the folder has when over MaxEntries (only the first are listed); `FullPath` - the
/// folder's path on the server; `ReadOnly` - the server's own records (download only).</summary>
public sealed record CacheListing(string Root, string RootName, string Path, CacheTotals Totals, IReadOnlyList<CacheEntry> Entries, int? Truncated,
    string? FullPath = null, bool ReadOnly = false);

public sealed record CacheDeleteResult(long Files, long Bytes, int Failed, string? FirstError);

/// <summary>A download: the file or folder on disk, whether it is zipped, the name it is saved under, the folder name
/// inside the zip, and its size (before zipping).</summary>
public sealed record CacheDownload(string FullPath, bool Folder, string FileName, string Prefix, long Bytes)
{
    /// <summary>What a zip holds when not the one folder - a one-file root's files.</summary>
    public IReadOnlyList<(string Prefix, string Folder)>? Sources { get; init; }
}

using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// The disk cache of Dhan's Data API for PAST days: every intraday candle call (spot, futures, options -
/// DhanHistoricalDataService) and every rolling / expired-option call (DhanRollingOptionDataService) is kept as gzip
/// JSON under Storage:DhanCachePath (default dhan-cache), ONE FILE PER INSTRUMENT AND IST DAY, and answered from there
/// from then on: an OI Replay day, a past futures day, the Order Flow page's estimated day, the record's If bought /
/// If sold fill-in, a tuning job, the chart backfills that ask "the last N days up to today" - NIFTY, BANKNIFTY and
/// SENSEX alike - ask Dhan for a closed day once, ever, across restarts, and even with no Dhan session. Per day, so a
/// window that runs into today still keeps its past days, and any later window that holds one of them reads it from
/// disk (only the days not kept go to Dhan, in one call - DhanDayWindow).
///
/// Only what can never change is kept: a day before today (IST) that Dhan sent a full session of (judged on Dhan's
/// own minutes - DhanHistoricalDataService.SentTimes), or that Dhan has already answered PAST in the same call (a
/// holiday then has nothing and a short session stays short - kept as they are). A broken file is deleted and fetched
/// again; a disk problem is logged and never fails the call.
///
/// The folder is held to Storage:DhanCacheMaxGb (default 10 GB): once over it, the files read least recently go first,
/// down to 90% of it. Files: {dir}/v1/{kind}/days/{yyyy-MM}/{dd}/{day}-{hash}.json.gz, the hash of the endpoint, the
/// request without its dates and the day (a folder a day - a full cache is some hundred thousand files). The older whole-window files ({dir}/v1/{kind}/{yyyy-MM}/{last day}-{hash}.json.gz)
/// are still read for the very request they hold, and split into days as they are.
/// </summary>
public sealed class DhanDataCache
{
    public const int Version = 1;
    public const double DefaultMaxGb = 10;
    /// <summary>A trim goes down to this share of the cap, so it does not run again on the next write.</summary>
    internal const double TrimTo = 0.9;
    private readonly string _dir;
    private readonly ILogger<DhanDataCache> _logger;
    private readonly Func<DateOnly> _today;
    private readonly long _maxBytes;
    private long _hits;
    private long _writes;
    /// <summary>The folder's size as last counted plus what was written since; -1 until the first count.</summary>
    private long _bytes = -1;
    private int _trimming;

    public DhanDataCache(IHostEnvironment environment, IConfiguration configuration, ILogger<DhanDataCache> logger)
        : this(PathOf(environment, configuration), logger, maxBytes: MaxBytesOf(configuration)) { }

    internal DhanDataCache(string directory, ILogger<DhanDataCache> logger, Func<DateOnly>? today = null, long? maxBytes = null)
    {
        _dir = directory;
        _logger = logger;
        _today = today ?? IstClock.Today;
        _maxBytes = maxBytes ?? (long)(DefaultMaxGb * 1024 * 1024 * 1024);
    }

    public static string PathOf(IHostEnvironment environment, IConfiguration configuration)
    {
        var configured = configuration["Storage:DhanCachePath"];
        var path = string.IsNullOrWhiteSpace(configured) ? "dhan-cache" : configured;
        return Path.GetFullPath(Path.IsPathRooted(path) ? path : Path.Combine(environment.ContentRootPath, path));
    }

    /// <summary>Storage:DhanCacheMaxGb (default 10) in bytes.</summary>
    internal static long MaxBytesOf(IConfiguration configuration)
    {
        var gb = double.TryParse(configuration["Storage:DhanCacheMaxGb"], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var v) && v > 0 ? v : DefaultMaxGb;
        return (long)(gb * 1024 * 1024 * 1024);
    }

    public string Directory => _dir;
    public long MaxBytes => _maxBytes;
    /// <summary>Calls answered from disk / responses written since the start.</summary>
    public long Hits => Interlocked.Read(ref _hits);
    public long Writes => Interlocked.Read(ref _writes);

    /// <summary>Whether a window ending on <paramref name="lastDay"/> (IST) has closed - only those are kept.</summary>
    public bool Cacheable(DateOnly lastDay) => lastDay < _today();

    /// <summary>The (older) whole-window file a request is kept in.</summary>
    internal string FileOf(string endpoint, object payload, DateOnly lastDay) =>
        Path.Combine(_dir, $"v{Version}", KindOf(endpoint), lastDay.ToString("yyyy-MM"), $"{lastDay:yyyy-MM-dd}-{Hash($"{endpoint}\n{JsonSerializer.Serialize(payload)}")}.json.gz");

    /// <summary>The file one IST day of a series is kept in - <paramref name="key"/> is the request without its dates.</summary>
    internal string FileOfDay(string endpoint, object key, DateOnly day) =>
        Path.Combine(_dir, $"v{Version}", KindOf(endpoint), "days", day.ToString("yyyy-MM"), day.ToString("dd"), $"{day:yyyy-MM-dd}-{Hash($"{endpoint}\n{JsonSerializer.Serialize(key)}\n{day:yyyy-MM-dd}")}.json.gz");

    private static string KindOf(string endpoint) => endpoint.Trim('/').Replace('/', '-');

    private static string Hash(string request) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(request)), 0, 12).ToLowerInvariant();

    /// <summary>Dhan's response to this request from a whole-window file (the caller disposes it), else null - never
    /// for a window not yet closed.</summary>
    public JsonDocument? TryGet(string endpoint, object payload, DateOnly lastDay) =>
        Cacheable(lastDay) ? Read(FileOf(endpoint, payload, lastDay)) : null;

    /// <summary>Whether this day of the series is on disk (not read).</summary>
    public bool HasDay(string endpoint, object key, DateOnly day) => Cacheable(day) && File.Exists(FileOfDay(endpoint, key, day));

    /// <summary>One day of the series from disk, in Dhan's own response shape (the caller disposes it), else null.</summary>
    public JsonDocument? TryGetDay(string endpoint, object key, DateOnly day) =>
        Cacheable(day) ? Read(FileOfDay(endpoint, key, day)) : null;

    /// <summary>Keeps Dhan's response to this request as a whole window - only for a closed window, and only when it
    /// had data (<paramref name="hasData"/>). A disk problem is logged, never thrown.</summary>
    public void Put(string endpoint, object payload, DateOnly lastDay, JsonElement response, bool hasData)
    {
        if (!hasData || !Cacheable(lastDay)) return;
        Write(FileOf(endpoint, payload, lastDay), endpoint, payload, w => response.WriteTo(w));
    }

    /// <summary>Keeps one closed day of the series (<paramref name="response"/>: that day's part of Dhan's answer, in its
    /// shape - empty for a day Dhan has nothing for). The caller judges that the day is final.</summary>
    public void PutDay(string endpoint, object key, DateOnly day, Action<Utf8JsonWriter> writeResponse)
    {
        if (!Cacheable(day)) return;
        Write(FileOfDay(endpoint, key, day), endpoint, new { day = day.ToString("yyyy-MM-dd"), key }, writeResponse);
    }

    private JsonDocument? Read(string path)
    {
        if (!File.Exists(path)) return null;
        try
        {
            JsonDocument doc;
            using (var file = File.OpenRead(path))
            using (var gz = new GZipStream(file, CompressionMode.Decompress))
            using (var kept = JsonDocument.Parse(gz))
            {
                if (!kept.RootElement.TryGetProperty("response", out var response)) throw new InvalidDataException("no response in it");
                doc = JsonDocument.Parse(response.GetRawText());
            }
            Interlocked.Increment(ref _hits);
            // Read now: the size cap removes the files read least recently first.
            try { File.SetLastAccessTimeUtc(path, DateTime.UtcNow); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            return doc;
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or JsonException or UnauthorizedAccessException)
        {
            _logger.LogWarning("Dhan cache file {Path} could not be read ({Error}) - deleted, it is fetched again.", path, ex.Message);
            try { File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            return null;
        }
    }

    private void Write(string path, string endpoint, object request, Action<Utf8JsonWriter> writeResponse)
    {
        var tmp = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            System.IO.Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            using (var file = File.Create(tmp))
            using (var gz = new GZipStream(file, CompressionLevel.Optimal))
            using (var writer = new Utf8JsonWriter(gz))
            {
                writer.WriteStartObject();
                writer.WriteString("endpoint", endpoint);
                writer.WriteString("cachedUtc", DateTimeOffset.UtcNow);
                writer.WritePropertyName("request");
                JsonSerializer.Serialize(writer, request);
                writer.WritePropertyName("response");
                writeResponse(writer);
                writer.WriteEndObject();
            }
            var added = new FileInfo(tmp).Length - (File.Exists(path) ? new FileInfo(path).Length : 0);
            File.Move(tmp, path, overwrite: true);
            Interlocked.Increment(ref _writes);
            Grew(added);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning("Dhan response for {Endpoint} not cached ({Error}).", endpoint, ex.Message);
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }

    /// <summary>Counts a write; the first one, or one that takes the folder over the cap, starts a trim in the
    /// background (one at a time).</summary>
    private void Grew(long added)
    {
        var known = Interlocked.Read(ref _bytes);
        if (known >= 0 && Interlocked.Add(ref _bytes, added) <= _maxBytes) return;
        if (Interlocked.CompareExchange(ref _trimming, 1, 0) != 0) return;
        _ = Task.Run(() =>
        {
            try { TrimNow(); }
            catch (Exception ex) { _logger.LogWarning(ex, "Dhan cache size check failed."); }
            finally { Volatile.Write(ref _trimming, 0); }
        });
    }

    /// <summary>Counts the folder and, when it is over the cap, deletes the files read least recently until it is at
    /// <see cref="TrimTo"/> of it (a stray .tmp an hour old goes too). Returns the bytes deleted.</summary>
    internal long TrimNow()
    {
        if (!System.IO.Directory.Exists(_dir)) { Interlocked.Exchange(ref _bytes, 0); return 0; }
        var files = new List<(FileInfo File, long Length, DateTime Used)>();
        long total = 0, deleted = 0;
        foreach (var path in System.IO.Directory.EnumerateFiles(_dir, "*", SearchOption.AllDirectories))
        {
            try
            {
                var info = new FileInfo(path);
                var length = info.Length;
                if (path.EndsWith(".tmp", StringComparison.Ordinal))
                {
                    if (DateTime.UtcNow - info.LastWriteTimeUtc > TimeSpan.FromHours(1)) { info.Delete(); deleted += length; }
                    continue;
                }
                if (!path.EndsWith(".json.gz", StringComparison.Ordinal)) continue;
                total += length;
                files.Add((info, length, info.LastAccessTimeUtc > info.LastWriteTimeUtc ? info.LastAccessTimeUtc : info.LastWriteTimeUtc));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        }
        if (total > _maxBytes)
        {
            var goal = (long)(_maxBytes * TrimTo);
            var removed = 0;
            foreach (var (file, length, _) in files.OrderBy(f => f.Used))
            {
                if (total <= goal) break;
                try { file.Delete(); total -= length; deleted += length; removed++; }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
            }
            _logger.LogInformation("Dhan cache over its {Max:0.#} GB cap - {Files} least recently used file(s) removed, {Size:0.##} GB kept.",
                _maxBytes / 1073741824d, removed, total / 1073741824d);
        }
        Interlocked.Exchange(ref _bytes, total);
        return deleted;
    }
}

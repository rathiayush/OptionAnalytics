using System.Globalization;
using System.IO.Compression;
using OptionAnalytics.Server.Services;
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
/// down to 90% of it.
///
/// Files: a CSV per instrument and day - {dir}/csv/{kind}/{yyyy-MM}/{yyyy-MM-dd}/{instrument}-{hash}.csv - Dhan's arrays as
/// columns (open, high, low, close, volume, timestamp; oi, iv, spot, strike for the rolling options), a row a minute,
/// with the minute in IST first (time_ist) and the request in its "# " header lines; read back into Dhan's own answer.
/// The hash is of the endpoint, the request without its dates and the day. The older gzip JSON files
/// ({dir}/v1/{kind}/days/{yyyy-MM}/{dd}/{day}-{hash}.json.gz) are still read - and moved to CSV the first time - so
/// nothing kept before is asked of Dhan again; the older whole-window files ({dir}/v1/{kind}/{yyyy-MM}/{last day}-{hash}.json.gz)
/// are still read for the very request they hold, and split into days as they are.
/// </summary>
public sealed class DhanDataCache
{
    public const int Version = 1;
    public const double DefaultMaxGb = 10;
    /// <summary>A trim goes down to this share of the cap, so it does not run again on the next write.</summary>
    internal const double TrimTo = 0.9;
    private readonly string _dir;
    private readonly string _csvDir;
    private readonly ILogger<DhanDataCache> _logger;
    private readonly Func<DateOnly> _today;
    private readonly long _maxBytes;
    private long _hits;
    private long _writes;
    private long _writeErrors;
    /// <summary>The folder's size as last counted plus what was written since; -1 until the first count.</summary>
    private long _bytes = -1;
    private int _trimming;

    public DhanDataCache(IHostEnvironment environment, IConfiguration configuration, ILogger<DhanDataCache> logger)
        : this(PathOf(environment, configuration), logger, maxBytes: MaxBytesOf(configuration)) { }

    internal DhanDataCache(string directory, ILogger<DhanDataCache> logger, Func<DateOnly>? today = null, long? maxBytes = null)
    {
        _dir = directory;
        _csvDir = Path.Combine(directory, "csv") + Path.DirectorySeparatorChar;
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
    /// <summary>Writes the disk refused since the start (a folder not writable - see CheckFolder).</summary>
    public long WriteErrors => Interlocked.Read(ref _writeErrors);

    /// <summary>Whether the cache folder can be written: creates it and writes / deletes a small file. The error when not.</summary>
    public (bool Writable, string? Error) CheckFolder()
    {
        var probe = Path.Combine(_dir, $".write-check-{Guid.NewGuid():N}");
        try
        {
            System.IO.Directory.CreateDirectory(_dir);
            File.WriteAllText(probe, "ok");
            File.Delete(probe);
            return (true, null);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return (false, ex.Message);
        }
    }

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
        !ForceRefresh && Cacheable(lastDay) ? Read(FileOf(endpoint, payload, lastDay)) : null;

    // Set for the length of one request that asked to fetch from Dhan afresh ("force fetch" on the OI Replay page): every read below
    // then misses - so Dhan is asked for the days - and every day that comes back is written over what was kept (PutDay / Put always
    // overwrite). Flows with the request's async work, like the rate limiter's priority scope.
    private static readonly AsyncLocal<bool> ForceRefreshRequested = new();

    /// <summary>True while the current request asked to skip the cache for reading and update it with what Dhan sends.</summary>
    public static bool ForceRefresh => ForceRefreshRequested.Value;

    /// <summary>Marks the current async flow as a force fetch until disposed.</summary>
    public static IDisposable ForceRefreshScope()
    {
        var before = ForceRefreshRequested.Value;
        ForceRefreshRequested.Value = true;
        return new RestoreForce(before);
    }

    private sealed class RestoreForce(bool before) : IDisposable
    {
        public void Dispose() => ForceRefreshRequested.Value = before;
    }

    /// <summary>The CSV one IST day of a series is kept in (see the class comment).</summary>
    internal string CsvFileOfDay(string endpoint, object key, DateOnly day)
    {
        var request = JsonSerializer.Serialize(key);
        return Path.Combine(_dir, "csv", KindOf(endpoint), day.ToString("yyyy-MM"), day.ToString("yyyy-MM-dd"),
            $"{LabelOf(request)}-{Hash($"{endpoint}\n{request}\n{day:yyyy-MM-dd}")}.csv");
    }

    /// <summary>The request's values as a readable file name part ("13_IDX_I_INDEX_1", "NSE_FNO_1_13_OPTIDX_WEEK_1_ATMp3_CALL"):
    /// letters, digits and '_' kept, '+' p, '-' m; a true flag by its name; lists left out.</summary>
    internal static string LabelOf(string requestJson)
    {
        var parts = new List<string>();
        try
        {
            using var doc = JsonDocument.Parse(requestJson);
            if (doc.RootElement.ValueKind == JsonValueKind.Object)
                foreach (var p in doc.RootElement.EnumerateObject())
                {
                    var text = p.Value.ValueKind switch
                    {
                        JsonValueKind.String => p.Value.GetString(),
                        JsonValueKind.Number => p.Value.GetRawText(),
                        JsonValueKind.True => p.Name,
                        _ => null,
                    };
                    if (string.IsNullOrEmpty(text)) continue;
                    var sb = new StringBuilder(text.Length);
                    foreach (var c in text) if (char.IsAsciiLetterOrDigit(c) || c == '_') sb.Append(c); else if (c == '+') sb.Append('p'); else if (c == '-') sb.Append('m');
                    if (sb.Length > 0) parts.Add(sb.ToString());
                }
        }
        catch (JsonException) { }
        var label = string.Join('_', parts);
        return label.Length == 0 ? "series" : label.Length > 90 ? label[..90] : label;
    }

    /// <summary>Whether this day of the series is on disk (not read) - never, for a force fetch.</summary>
    public bool HasDay(string endpoint, object key, DateOnly day) =>
        !ForceRefresh && Cacheable(day) && (File.Exists(CsvFileOfDay(endpoint, key, day)) || File.Exists(FileOfDay(endpoint, key, day)));

    /// <summary>One day of the series from disk, in Dhan's own response shape (the caller disposes it), else null. A day still
    /// in the older gzip JSON file is moved to CSV as it is read.</summary>
    public JsonDocument? TryGetDay(string endpoint, object key, DateOnly day)
    {
        if (ForceRefresh || !Cacheable(day)) return null;
        var csv = CsvFileOfDay(endpoint, key, day);
        var doc = ReadCsvDay(csv);
        if (doc is not null) return doc;
        var legacy = FileOfDay(endpoint, key, day);
        doc = Read(legacy);
        if (doc is not null && WriteCsvDay(csv, endpoint, key, day, doc.RootElement, fromDhan: false) == true) TryDelete(legacy);
        return doc;
    }

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
        // Kept as CSV when the day's arrays are plain columns of numbers (Dhan's candle answers are); anything else as gzip JSON.
        JsonDocument response;
        using (var buffer = new MemoryStream())
        {
            using (var writer = new Utf8JsonWriter(buffer)) writeResponse(writer);
            response = JsonDocument.Parse(buffer.ToArray());
        }
        using (response)
        {
            var csv = WriteCsvDay(CsvFileOfDay(endpoint, key, day), endpoint, key, day, response.RootElement);
            if (csv == true) TryDelete(FileOfDay(endpoint, key, day));
            if (csv is not null) return; // written, or the disk refused it (said - not tried again as JSON)
            var root = response.RootElement;
            Write(FileOfDay(endpoint, key, day), endpoint, new { day = day.ToString("yyyy-MM-dd"), key }, w => root.WriteTo(w));
        }
    }

    // ---- The CSV files ----

    /// <summary>The derived first column of a CSV - the minute in IST, for reading the file; not part of Dhan's answer.</summary>
    internal const string TimeIstColumn = "time_ist";

    /// <summary>Where the day's arrays are in a kept answer: the answer itself (/charts/intraday), or {"data":{"ce"|"pe":{...}}}
    /// (/charts/rollingoption, kept for one side). Null for any other shape.</summary>
    internal static (string Path, JsonElement Series)? SeriesOf(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) return null;
        var props = root.EnumerateObject().ToList();
        if (props.Count == 0 || props.Any(p => p.Value.ValueKind == JsonValueKind.Array)) return ("", root);
        if (props.Count == 1 && props[0].Name == "data" && props[0].Value.ValueKind == JsonValueKind.Object)
        {
            var sides = props[0].Value.EnumerateObject().ToList();
            if (sides.Count == 1 && sides[0].Value.ValueKind == JsonValueKind.Object) return ($"data.{sides[0].Name}", sides[0].Value);
        }
        return null;
    }

    /// <summary>Writes one day's answer as CSV: true when written, false when the disk refused it, null (nothing tried) when its
    /// arrays are not equal-length columns of numbers - then it is kept as gzip JSON.</summary>
    internal bool? WriteCsvDay(string path, string endpoint, object key, DateOnly day, JsonElement response, bool fromDhan = true)
    {
        if (SeriesOf(response) is not { } found) return null;
        var columns = new List<(string Name, List<string> Cells)>();
        var scalars = new Dictionary<string, JsonElement>();
        int? length = null;
        foreach (var p in found.Series.EnumerateObject())
        {
            if (p.Value.ValueKind != JsonValueKind.Array) { scalars[p.Name] = p.Value; continue; }
            if (p.Name == TimeIstColumn || p.Name.Length == 0 || p.Name.Any(c => c is ',' or '\n' or '\r' or '#')) return null;
            var cells = new List<string>();
            foreach (var e in p.Value.EnumerateArray())
            {
                if (e.ValueKind == JsonValueKind.Number) cells.Add(e.GetRawText());
                else if (e.ValueKind == JsonValueKind.Null) cells.Add("");
                else return null;
            }
            if (length is not null && cells.Count != length) return null;
            length = cells.Count;
            columns.Add((p.Name, cells));
        }
        var stamps = columns.FindIndex(c => c.Name == "timestamp");
        var sb = new StringBuilder();
        sb.Append("# endpoint=").Append(endpoint).Append('\n');
        sb.Append("# request=").Append(JsonSerializer.Serialize(key)).Append('\n');
        sb.Append("# day=").Append(day.ToString("yyyy-MM-dd")).Append(" (IST)\n");
        sb.Append("# series=").Append(found.Path).Append('\n');
        if (scalars.Count > 0) sb.Append("# scalars=").Append(JsonSerializer.Serialize(scalars)).Append('\n');
        sb.Append("# cached_utc=").Append(DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture)).Append('\n');
        sb.AppendJoin(',', (stamps >= 0 ? new[] { TimeIstColumn } : Array.Empty<string>()).Concat(columns.Select(c => c.Name))).Append('\n');
        for (var i = 0; i < (length ?? 0); i++)
        {
            if (stamps >= 0)
                sb.Append(double.TryParse(columns[stamps].Cells[i], NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds)
                    ? DateTimeOffset.FromUnixTimeSeconds((long)seconds).ToOffset(IstClock.Offset).ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture) : "").Append(',');
            for (var c = 0; c < columns.Count; c++) { if (c > 0) sb.Append(','); sb.Append(columns[c].Cells[i]); }
            sb.Append('\n');
        }
        return WriteText(path, endpoint, sb.ToString(), fromDhan);
    }

    /// <summary>A day's CSV back as Dhan's own answer (the caller disposes it); null when there is none. A broken file is deleted
    /// and the day fetched again.</summary>
    private JsonDocument? ReadCsvDay(string path)
    {
        if (!File.Exists(path)) return null;
        try
        {
            var meta = new Dictionary<string, string>(StringComparer.Ordinal);
            string[]? header = null;
            var rows = new List<string[]>();
            foreach (var raw in File.ReadLines(path, Encoding.UTF8))
            {
                var line = raw.TrimEnd('\r');
                if (line.StartsWith("# ", StringComparison.Ordinal))
                {
                    var eq = line.IndexOf('=');
                    if (eq > 2) meta[line[2..eq]] = line[(eq + 1)..];
                    continue;
                }
                if (header is null) { header = line.Length == 0 ? Array.Empty<string>() : line.Split(','); continue; }
                if (line.Length == 0) continue;
                var cells = line.Split(',');
                if (cells.Length != header.Length) throw new InvalidDataException($"a row has {cells.Length} cells, the header {header.Length}");
                rows.Add(cells);
            }
            if (header is null || !meta.TryGetValue("series", out var seriesPath)) throw new InvalidDataException("no header");

            using var buffer = new MemoryStream();
            using (var w = new Utf8JsonWriter(buffer))
            {
                var wrappers = seriesPath.Length == 0 ? Array.Empty<string>() : seriesPath.Split('.');
                foreach (var name in wrappers) { w.WriteStartObject(); w.WritePropertyName(name); }
                w.WriteStartObject();
                if (meta.TryGetValue("scalars", out var scalars))
                    using (var kept = JsonDocument.Parse(scalars))
                        foreach (var p in kept.RootElement.EnumerateObject()) p.WriteTo(w);
                for (var c = 0; c < header.Length; c++)
                {
                    if (header[c] == TimeIstColumn) continue;
                    w.WritePropertyName(header[c]);
                    w.WriteStartArray();
                    foreach (var row in rows) { if (row[c].Length == 0) w.WriteNullValue(); else w.WriteRawValue(row[c]); }
                    w.WriteEndArray();
                }
                w.WriteEndObject();
                foreach (var _ in wrappers) w.WriteEndObject();
            }
            var doc = JsonDocument.Parse(buffer.ToArray());
            Interlocked.Increment(ref _hits);
            // Read now: the size cap removes the files read least recently first.
            try { File.SetLastAccessTimeUtc(path, DateTime.UtcNow); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            return doc;
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or JsonException or UnauthorizedAccessException or ArgumentException)
        {
            _logger.LogWarning("Dhan cache file {Path} could not be read ({Error}) - deleted, it is fetched again.", path, ex.Message);
            TryDelete(path);
            return null;
        }
    }

    /// <summary>Writes a file whole (a temporary file moved over it) and counts it; false when the disk refused it - logged, and
    /// shown on the page's load progress, never thrown. `fromDhan`: a day Dhan sent now (counted as saved on the load panel).</summary>
    private bool WriteText(string path, string endpoint, string content, bool fromDhan)
    {
        var tmp = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            System.IO.Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(tmp, content, new UTF8Encoding(false));
            var added = new FileInfo(tmp).Length - (File.Exists(path) ? new FileInfo(path).Length : 0);
            File.Move(tmp, path, overwrite: true);
            Interlocked.Increment(ref _writes);
            // A day Dhan just sent - not one only moved from an older file - is what the load panel counts as saved.
            if (fromDhan) LoadProgress.SavedToDisk();
            Grew(added);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            WriteFailed(endpoint, path, ex.Message);
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            return false;
        }
    }

    private void WriteFailed(string endpoint, string path, string error)
    {
        Interlocked.Increment(ref _writeErrors);
        _logger.LogWarning("Dhan response for {Endpoint} not cached at {Path} ({Error}).", endpoint, path, error);
        LoadProgress.DiskError($"Could not save to the disk cache ({error}) - this day will be asked of Dhan again next time.");
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
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
            LoadProgress.SavedToDisk();
            Grew(added);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            WriteFailed(endpoint, path, ex.Message);
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
                // The cache's own files only - the scrip master's CSV and the NSE store beside them are not trimmed.
                if (!path.EndsWith(".json.gz", StringComparison.Ordinal) && !(path.EndsWith(".csv", StringComparison.Ordinal) && path.StartsWith(_csvDir, StringComparison.Ordinal))) continue;
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

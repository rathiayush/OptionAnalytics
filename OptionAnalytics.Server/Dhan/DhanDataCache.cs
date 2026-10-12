using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace OptionAnalytics.Server.Dhan;

/// <summary>
/// The disk cache of Dhan's Data API for PAST days: every intraday candle call (spot, futures, options -
/// DhanHistoricalDataService) and every rolling / expired-option chunk (DhanRollingOptionDataService) whose whole
/// window has closed is kept as gzip JSON - the request and Dhan's own response - under Storage:DhanCachePath
/// (default dhan-cache), and the same request is answered from it from then on: an OI Replay day, a past futures day,
/// the Order Flow page's estimated day, the record's If bought / If sold fill-in or a tuning job ask Dhan for a closed
/// day once, ever - across restarts, and even with no Dhan session.
///
/// Only what can never change is kept: a window ending before today (IST), and a response with data in it (an empty
/// answer - a holiday, a strike not traded, a busy moment - is asked again next time). A broken file is deleted and
/// fetched again; a disk problem is logged and never fails the call. Files: {dir}/v1/{kind}/{yyyy-MM}/{last day}-{hash}
/// .json.gz, the hash of the endpoint and the request - so a request that differs in anything is a different file.
/// </summary>
public sealed class DhanDataCache
{
    public const int Version = 1;
    private readonly string _dir;
    private readonly ILogger<DhanDataCache> _logger;
    private readonly Func<DateOnly> _today;
    private long _hits;
    private long _writes;

    public DhanDataCache(IHostEnvironment environment, IConfiguration configuration, ILogger<DhanDataCache> logger)
        : this(PathOf(environment, configuration), logger) { }

    internal DhanDataCache(string directory, ILogger<DhanDataCache> logger, Func<DateOnly>? today = null)
    {
        _dir = directory;
        _logger = logger;
        _today = today ?? IstClock.Today;
    }

    public static string PathOf(IHostEnvironment environment, IConfiguration configuration)
    {
        var configured = configuration["Storage:DhanCachePath"];
        var path = string.IsNullOrWhiteSpace(configured) ? "dhan-cache" : configured;
        return Path.GetFullPath(Path.IsPathRooted(path) ? path : Path.Combine(environment.ContentRootPath, path));
    }

    public string Directory => _dir;
    /// <summary>Calls answered from disk / responses written since the start.</summary>
    public long Hits => Interlocked.Read(ref _hits);
    public long Writes => Interlocked.Read(ref _writes);

    /// <summary>Whether a window ending on <paramref name="lastDay"/> (IST) has closed - only those are kept.</summary>
    public bool Cacheable(DateOnly lastDay) => lastDay < _today();

    /// <summary>The file a request is kept in.</summary>
    internal string FileOf(string endpoint, object payload, DateOnly lastDay)
    {
        var request = $"{endpoint}\n{JsonSerializer.Serialize(payload)}";
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(request)), 0, 12).ToLowerInvariant();
        var kind = endpoint.Trim('/').Replace('/', '-');
        return Path.Combine(_dir, $"v{Version}", kind, lastDay.ToString("yyyy-MM"), $"{lastDay:yyyy-MM-dd}-{hash}.json.gz");
    }

    /// <summary>Dhan's response to this request from disk (the caller disposes it), else null - never for a window not
    /// yet closed.</summary>
    public JsonDocument? TryGet(string endpoint, object payload, DateOnly lastDay)
    {
        if (!Cacheable(lastDay)) return null;
        var path = FileOf(endpoint, payload, lastDay);
        if (!File.Exists(path)) return null;
        try
        {
            using var file = File.OpenRead(path);
            using var gz = new GZipStream(file, CompressionMode.Decompress);
            using var kept = JsonDocument.Parse(gz);
            if (!kept.RootElement.TryGetProperty("response", out var response)) throw new InvalidDataException("no response in it");
            var doc = JsonDocument.Parse(response.GetRawText());
            Interlocked.Increment(ref _hits);
            return doc;
        }
        catch (Exception ex) when (ex is IOException or InvalidDataException or JsonException or UnauthorizedAccessException)
        {
            _logger.LogWarning("Dhan cache file {Path} could not be read ({Error}) - deleted, it is fetched again.", path, ex.Message);
            try { File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            return null;
        }
    }

    /// <summary>Keeps Dhan's response to this request - only for a closed window, and only when it had data
    /// (<paramref name="hasData"/>). A disk problem is logged, never thrown.</summary>
    public void Put(string endpoint, object payload, DateOnly lastDay, JsonElement response, bool hasData)
    {
        if (!hasData || !Cacheable(lastDay)) return;
        var path = FileOf(endpoint, payload, lastDay);
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
                JsonSerializer.Serialize(writer, payload);
                writer.WritePropertyName("response");
                response.WriteTo(writer);
                writer.WriteEndObject();
            }
            File.Move(tmp, path, overwrite: true);
            Interlocked.Increment(ref _writes);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning("Dhan response for {Endpoint} not cached ({Error}).", endpoint, ex.Message);
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}

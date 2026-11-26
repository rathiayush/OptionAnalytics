using System.IO.Compression;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace OptionAnalytics.Server.TrueData;

/// <summary>
/// PAST DAYS OF THE TICK FLOW PAGE kept on disk (asked for - "load previous day data into these profiles and also cache them"): one gzip JSON file per kind,
/// index and day under {Live.StatePath}/tick-days/{kind}/{UNDERLYING}/{yyyy-MM-dd}.json.gz - "futures" (the day's 1-minute footprint bars at a 1-point row)
/// and "options" (the day's big option orders). TrueData's tick history keeps only the last days of the trial (a subscription longer) and the option build takes
/// minutes, so a day read once is never asked of TrueData again. Past days only - today is never written (it is still changing). No StatePath = off.
/// A failed read or write is a miss, never an error. Its own - nothing of the Dhan cache.
/// </summary>
public sealed class TickDayDiskCache
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerOptions.Default) { PropertyNameCaseInsensitive = true };
    private readonly string _root;
    private readonly ILogger<TickDayDiskCache> _logger;

    public TickDayDiskCache(IOptions<TrueDataOptions> options, ILogger<TickDayDiskCache> logger)
    {
        _root = string.IsNullOrWhiteSpace(options.Value.Live.StatePath) ? "" : Path.Combine(options.Value.Live.StatePath, "tick-days");
        _logger = logger;
    }

    /// <summary>For the tests: a cache in a folder.</summary>
    internal TickDayDiskCache(string root, ILogger<TickDayDiskCache> logger) { _root = root; _logger = logger; }

    /// <summary>The indices whose past days are loaded and kept - NIFTY for now (asked for), BANKNIFTY later: add it here.</summary>
    public static readonly string[] Indices = { "NIFTY" };
    public static bool Keeps(string underlying) => Indices.Contains(underlying.ToUpperInvariant());

    public bool Enabled => _root.Length > 0;

    public string FileOf(string kind, string underlying, DateOnly day) =>
        Path.Combine(_root, kind, underlying.ToUpperInvariant(), $"{day:yyyy-MM-dd}.json.gz");

    public T? Read<T>(string kind, string underlying, DateOnly day) where T : class
    {
        if (!Enabled || !Keeps(underlying)) return null;
        try
        {
            var file = FileOf(kind, underlying, day);
            if (!File.Exists(file)) return null;
            using var stream = File.OpenRead(file);
            using var gz = new GZipStream(stream, CompressionMode.Decompress);
            return JsonSerializer.Deserialize<T>(gz, Json);
        }
        catch (Exception ex) { _logger.LogWarning(ex, "Tick day {Kind} {Underlying} {Day} could not be read from disk.", kind, underlying, day); return null; }
    }

    /// <summary>Writes a PAST day whole (a temp file moved into place); today and later are refused.</summary>
    public bool Write<T>(string kind, string underlying, DateOnly day, T value) where T : class
    {
        if (!Enabled || !Keeps(underlying) || day >= IstClock.Today()) return false;
        try
        {
            var file = FileOf(kind, underlying, day);
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            var temp = file + ".tmp";
            using (var stream = File.Create(temp))
            using (var gz = new GZipStream(stream, CompressionLevel.Optimal))
                JsonSerializer.Serialize(gz, value, Json);
            File.Move(temp, file, true);
            return true;
        }
        catch (Exception ex) { _logger.LogWarning(ex, "Tick day {Kind} {Underlying} {Day} could not be written to disk.", kind, underlying, day); return false; }
    }
}

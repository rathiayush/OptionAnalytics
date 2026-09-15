using System.Globalization;
using System.Text.Json;
using OptionAnalytics.Server.Models;

namespace OptionAnalytics.Server.Services;

/// <summary>
/// On-disk cache of a year's worth of spot 1-minute candles per underlying, one plain CSV file
/// each (see HistoricalSpotDataPrefetchHostedService for what actually fills it) - the one thing in
/// this app that IS persisted across a redeploy, at the user's own explicit request ("i do not need
/// db okay"). A flat, time-ascending CSV needs no index to stay fast here: ExpiredOptionBacktestService
/// only ever reads a slice of at most ~1 year (roughly 94,000 rows), a linear scan of which is a
/// single-digit-millisecond cost, nowhere near what would justify a database or a custom binary
/// layout.
///
/// A small sidecar ".meta.json" per underlying records exactly which [FromDay,ToDay] window the CSV
/// actually covers, written only after the CSV itself is fully written - this is what
/// HasCompleteData uses to decide "already fetched, skip" on the next startup without re-parsing the
/// whole CSV just to find its own date bounds, and what keeps a half-written file (a crash mid-fetch)
/// from ever being read as complete.
/// </summary>
public sealed class HistoricalSpotDataStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };
    private const string TimeFormat = "yyyy-MM-ddTHH:mm:sszzz";

    private readonly string _directory;
    private readonly ILogger<HistoricalSpotDataStore> _logger;

    public HistoricalSpotDataStore(IHostEnvironment environment, IConfiguration configuration, ILogger<HistoricalSpotDataStore> logger)
    {
        // Same convention as StrategyTriggerStore's own TriggersPath - Storage:HistoricalDataPath
        // (env var Storage__HistoricalDataPath) points this at the mounted volume in production;
        // next to the app by default for a local run. See docker-compose.yml.
        var configured = configuration["Storage:HistoricalDataPath"];
        _directory = string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(environment.ContentRootPath, "historical-data")
            : configured;
        _logger = logger;

        Directory.CreateDirectory(_directory);
    }

    private string CsvPath(string underlying) => Path.Combine(_directory, $"{underlying.ToUpperInvariant()}_spot_1m.csv");
    private string MetaPath(string underlying) => Path.Combine(_directory, $"{underlying.ToUpperInvariant()}_spot_1m.meta.json");

    private sealed record Meta(DateOnly FromDay, DateOnly ToDay, DateTimeOffset FetchedAtUtc);

    /// <summary>True when a previous prefetch already wrote a CSV covering at least
    /// [requiredFromDay, requiredToDay] - the guard that makes the background prefetch a genuine
    /// one-time job rather than something that re-fetches a whole year from Dhan on every
    /// restart.</summary>
    public bool HasCompleteData(string underlying, DateOnly requiredFromDay, DateOnly requiredToDay)
    {
        var meta = ReadMeta(underlying);
        return meta is not null && meta.FromDay <= requiredFromDay && meta.ToDay >= requiredToDay;
    }

    private Meta? ReadMeta(string underlying)
    {
        var path = MetaPath(underlying);
        if (!File.Exists(path)) return null;

        try
        {
            return JsonSerializer.Deserialize<Meta>(File.ReadAllText(path));
        }
        catch (Exception ex) when (ex is JsonException or IOException)
        {
            _logger.LogWarning(ex, "Could not read {Path} - treating {Underlying}'s historical cache as absent.", path, underlying);
            return null;
        }
    }

    /// <summary>Every cached candle for [fromDay,toDay] (IST calendar dates, both inclusive) -
    /// callers should check HasCompleteData first; this just returns whatever the CSV happens to
    /// contain in that window, empty if the file itself is missing.</summary>
    public IReadOnlyList<CandleWithVolume> Read(string underlying, DateOnly fromDay, DateOnly toDay)
    {
        var path = CsvPath(underlying);
        if (!File.Exists(path)) return Array.Empty<CandleWithVolume>();

        var result = new List<CandleWithVolume>();
        using var reader = new StreamReader(path);
        reader.ReadLine(); // header

        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (line.Length == 0) continue;
            var parts = line.Split(',');
            if (parts.Length != 6) continue;

            if (!DateTimeOffset.TryParseExact(parts[0], TimeFormat, CultureInfo.InvariantCulture, DateTimeStyles.None, out var time))
                continue;

            var day = IstClock.IstDate(time);
            if (day < fromDay || day > toDay) continue;

            result.Add(new CandleWithVolume(
                time,
                decimal.Parse(parts[1], CultureInfo.InvariantCulture),
                decimal.Parse(parts[2], CultureInfo.InvariantCulture),
                decimal.Parse(parts[3], CultureInfo.InvariantCulture),
                decimal.Parse(parts[4], CultureInfo.InvariantCulture),
                long.Parse(parts[5], CultureInfo.InvariantCulture)));
        }

        return result;
    }

    /// <summary>Overwrites this underlying's CSV with <paramref name="candles"/> (assumed already
    /// time-ascending) and only then writes the meta file recording [fromDay,toDay] as covered -
    /// that ordering is what keeps a process killed mid-write from ever leaving behind a meta file
    /// that claims coverage the CSV itself does not actually have.</summary>
    public async Task SaveAsync(string underlying, DateOnly fromDay, DateOnly toDay, IReadOnlyList<CandleWithVolume> candles, CancellationToken cancellationToken)
    {
        var csvPath = CsvPath(underlying);
        var tempPath = csvPath + ".tmp";

        await using (var writer = new StreamWriter(tempPath, append: false))
        {
            await writer.WriteLineAsync("TimeUtc,Open,High,Low,Close,Volume");
            foreach (var c in candles)
            {
                await writer.WriteLineAsync(string.Join(',',
                    c.Time.ToString(TimeFormat, CultureInfo.InvariantCulture),
                    c.Open.ToString(CultureInfo.InvariantCulture),
                    c.High.ToString(CultureInfo.InvariantCulture),
                    c.Low.ToString(CultureInfo.InvariantCulture),
                    c.Close.ToString(CultureInfo.InvariantCulture),
                    c.Volume.ToString(CultureInfo.InvariantCulture)));
            }
        }

        File.Move(tempPath, csvPath, overwrite: true);

        var meta = new Meta(fromDay, toDay, DateTimeOffset.UtcNow);
        await File.WriteAllTextAsync(MetaPath(underlying), JsonSerializer.Serialize(meta, JsonOptions), cancellationToken);

        _logger.LogInformation("Saved {Count} cached spot candle(s) for {Underlying} ({From}..{To}) to {Path}.", candles.Count, underlying, fromDay, toDay, csvPath);
    }
}
